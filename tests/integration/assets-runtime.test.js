import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { createAssetManifest } from '../../src/lib/assets.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';

const VIEWER = 'viewer@metrika.by';
const PROBE_NAME = 'runtime-probe.js';
const PROBE_PATH = join(process.cwd(), 'public', 'assets', PROBE_NAME);

/** @type {import('pg').Pool} */
let pool;

beforeAll(async () => {
  await resetTestDatabase();
  await seed();
  pool = getTestPool();
});

afterAll(async () => {
  rmSync(PROBE_PATH, { force: true });
  await closeTestPool();
});

beforeEach(async () => {
  await pool.query('DELETE FROM sessions');
});

/**
 * @param {import('express').Express} app
 * @returns {Promise<import('supertest').SuperAgentTest>}
 */
async function signedIn(app) {
  const agent = request.agent(app);
  const login = await loginAs(agent, VIEWER);
  expect(login.status).toBe(302);
  return agent;
}

describe('asset runtime', () => {
  it('renders the page without islands when no manifest exists in test mode', async () => {
    const manifest = createAssetManifest({
      manifestPath: '/nonexistent/metrika/manifest.json',
      required: false,
      warn: () => {},
    });
    const app = makeApp({ assets: manifest });
    const agent = await signedIn(app);

    const res = await agent.get('/app/dashboard');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script type="module"');
  });

  it('renders the script tags supplied by an injected manifest', async () => {
    const stub = {
      assets: () => ({
        scripts: ['/assets/dashboard-stub.js'],
        preloads: ['/assets/chunks/shared-stub.js'],
      }),
    };
    const app = makeApp({ assets: stub });
    const agent = await signedIn(app);

    const res = await agent.get('/app/dashboard');

    expect(res.status).toBe(200);
    expect(res.text).toContain('src="/assets/dashboard-stub.js"');
    expect(res.text).toContain('rel="modulepreload" href="/assets/chunks/shared-stub.js"');
  });

  it('keeps the HTML uncached and the CSP strict for scripts', async () => {
    const app = makeApp({ assets: { assets: () => ({ scripts: [], preloads: [] }) } });
    const agent = await signedIn(app);

    const res = await agent.get('/app/dashboard');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');

    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).toMatch(/script-src[^;]*'nonce-/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("script-src-attr 'none'");
  });

  it('serves fingerprinted assets as immutable for a year', async () => {
    mkdirSync(join(process.cwd(), 'public', 'assets'), { recursive: true });
    writeFileSync(PROBE_PATH, 'export const probe = true;\n');

    const app = makeApp({ assets: { assets: () => ({ scripts: [], preloads: [] }) } });

    const res = await request(app).get(`/assets/${PROBE_NAME}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });
});
