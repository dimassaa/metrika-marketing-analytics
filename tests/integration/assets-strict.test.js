import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MANIFEST_PATH } from '../../src/lib/assets.js';

/**
 * Production strictness cannot be exercised by importing `src/lib/assets.js` in this suite: the module reads
 * `env.nodeEnv` once at import time and the Vitest setup files pin `NODE_ENV=test`, where a missing manifest is an
 * optional warning. Patching the exported `env` object afterwards would test a mutation the server never performs.
 *
 * Each case therefore boots a short-lived child `node` process with `NODE_ENV=production` and the production-only
 * environment guards satisfied. The child either builds the real Express app (missing manifest) or constructs the
 * manifest reader twice around a rewritten file (cache policy). Its JSON line on stdout is the assertion surface.
 */

const PROJECT_ROOT = process.cwd();
const STARTUP_TIMEOUT_MS = 20_000;

/** Production values that satisfy `src/config/env.js`; the database URL is never dialled because `db` is a stub. */
const PRODUCTION_ENV = Object.freeze({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  SESSION_SECRET: 'strict-manifest-test-secret-0123456789abcdef',
  APP_URL: 'http://localhost:3000',
  COOKIE_SECURE: 'true',
  LOG_LEVEL: 'silent',
});

/** @type {string[]} */
const fixtures = [];

/**
 * @param {string} source ES module source executed with `--input-type=module`; relative imports resolve from the
 *   project root, so the child imports exactly the modules the server imports.
 * @param {Record<string, string>} [extraEnv]
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runChildModule(source, extraEnv = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: STARTUP_TIMEOUT_MS,
    env: { ...process.env, ...PRODUCTION_ENV, ...extraEnv },
  });
}

/**
 * @param {{ status: number | null, stdout: string, stderr: string }} result
 * @returns {Record<string, unknown>} Last stdout line parsed as JSON, so a stray log line cannot hide a crash.
 */
function lastJson(result) {
  const line = result.stdout.trim().split('\n').at(-1);
  expect(line, result.stderr).toBeTruthy();
  return JSON.parse(line);
}

afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop(), { recursive: true, force: true });
});

describe('production asset manifest', () => {
  it('refuses to build the app when the manifest is missing, without opening a port', () => {
    // `createApp` reads the default manifest path, with no injection point, so the only way to prove production
    // refusal while a build is present is to move that build aside for the seconds the child needs. The rename is
    // restored in `finally`, and Vitest runs integration files one at a time, so no other test can observe the gap.
    const backupPath = `${DEFAULT_MANIFEST_PATH}.strict-test-backup`;
    const hadManifest = existsSync(DEFAULT_MANIFEST_PATH);
    if (hadManifest) renameSync(DEFAULT_MANIFEST_PATH, backupPath);

    const source = `
      import { createApp } from './src/app.js';
      const db = { query: async () => ({ rows: [] }), connect: async () => { throw new Error('unused'); } };
      try {
        createApp({ db });
        console.log(JSON.stringify({ started: true }));
        process.exit(10);
      } catch (error) {
        console.log(JSON.stringify({ started: false, name: error.name, message: error.message }));
      }
    `;

    let result;
    try {
      result = runChildModule(source);
    } finally {
      if (hadManifest) renameSync(backupPath, DEFAULT_MANIFEST_PATH);
    }
    const output = lastJson(result);

    expect(result.error).toBeUndefined();
    expect(output.started).toBe(false);
    expect(output.name).toBe('AssetManifestError');
    // The default manifest path is the real build output, not an injected one: production fails before Express starts.
    expect(String(output.message)).toContain(DEFAULT_MANIFEST_PATH);
    expect(String(output.message)).toContain('npm run build');
    expect(result.status).toBe(0);
  });

  it('keeps the startup manifest for the whole production process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metrika-strict-manifest-'));
    fixtures.push(dir);
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({ 'client/entries/dashboard.jsx': { file: 'dashboard-old.js', isEntry: true } }),
    );
    const source = `
      import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
      import { createAssetManifest } from './src/lib/assets.js';
      const manifestPath = process.env.STRICT_MANIFEST_PATH;
      const assets = createAssetManifest({ manifestPath });
      const before = assets.assets(['dashboard']).scripts;
      writeFileSync(manifestPath, JSON.stringify({ 'client/entries/dashboard.jsx': { file: 'dashboard-new.js', isEntry: true } }));
      const future = new Date(Date.now() + 5000);
      utimesSync(manifestPath, future, future);
      const after = assets.assets(['dashboard']).scripts;
      console.log(JSON.stringify({ before, after, reloaded: readFileSync(manifestPath, 'utf8').includes('dashboard-new.js') }));
    `;

    const result = runChildModule(source, { STRICT_MANIFEST_PATH: manifestPath });
    const output = lastJson(result);

    expect(result.status).toBe(0);
    expect(output.before).toEqual(['/assets/dashboard-old.js']);
    expect(output.after).toEqual(['/assets/dashboard-old.js']);
    // The file on disk did change; only the production reader ignored it, which is the point of the cache rule.
    expect(output.reloaded).toBe(true);
  });
});
