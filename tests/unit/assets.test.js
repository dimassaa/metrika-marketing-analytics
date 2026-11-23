import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AssetManifestError,
  KNOWN_ENTRIES,
  absoluteAssetPath,
  createAssetManifest,
} from '../../src/lib/assets.js';

const FIXTURE = 'tests/fixtures/asset-manifest.json';
const fixtures = [];

/**
 * @param {object} manifest
 * @returns {string} Path of a fresh manifest file.
 */
function manifestFile(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'metrika-assets-'));
  fixtures.push(dir);
  const path = join(dir, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

/**
 * Rewrites the manifest and forces a different mtime; a fast write can otherwise land in the same millisecond and
 * the development reload would look broken.
 * @param {string} path
 * @param {object} manifest
 */
function rewrite(path, manifest) {
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  const future = new Date(Date.now() + 2000);
  utimesSync(path, future, future);
}

afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop(), { recursive: true, force: true });
});

describe('asset manifest', () => {
  it('resolves the entry file and preloads every imported chunk recursively', () => {
    const manifest = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const assets = createAssetManifest({ manifestPath: manifestFile(manifest), required: true });

    expect(assets.assets(['dashboard'])).toEqual({
      scripts: ['/assets/dashboard-a1b2c3.js'],
      preloads: ['/assets/chunks/shared-d4e5f6.js', '/assets/chunks/react-g7h8i9.js'],
    });
  });

  it('maps a public asset URL back to a file under public/assets', () => {
    expect(absoluteAssetPath('/assets/chunks/shared.js')).toBe(
      join(process.cwd(), 'public', 'assets', 'chunks', 'shared.js'),
    );
    expect(absoluteAssetPath('chunks/shared.js')).toBe(
      join(process.cwd(), 'public', 'assets', 'chunks', 'shared.js'),
    );
  });

  it('fails loudly on an unknown entry name instead of rendering a page without its island', () => {
    const manifest = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const assets = createAssetManifest({ manifestPath: manifestFile(manifest), required: true });

    expect(() => assets.assets(['dashbaord'])).toThrow(AssetManifestError);
    expect(() => assets.assets(['dashbaord'])).toThrow(/dashbaord/);
  });

  it('names the path and the build command when a required manifest is missing', () => {
    const path = join(tmpdir(), `metrika-missing-${Date.now()}.json`);

    expect(() => createAssetManifest({ manifestPath: path, required: true })).toThrow(AssetManifestError);
    expect(() => createAssetManifest({ manifestPath: path, required: true })).toThrow(path);
    expect(() => createAssetManifest({ manifestPath: path, required: true })).toThrow(/npm run build/);
  });

  it('returns no scripts and one warning when an optional manifest is missing', () => {
    const path = join(tmpdir(), `metrika-missing-${Date.now()}-optional.json`);
    const warnings = [];
    const assets = createAssetManifest({
      manifestPath: path,
      required: false,
      warn: (details, message) => warnings.push({ details, message }),
    });

    expect(assets.assets(['dashboard'])).toEqual({ scripts: [], preloads: [] });
    expect(assets.assets(['dashboard'])).toEqual({ scripts: [], preloads: [] });
    // One warning per manifest instance, not one per request.
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/manifest/i);
  });

  it('still rejects an unknown entry when the optional manifest is missing', () => {
    const path = join(tmpdir(), `metrika-missing-${Date.now()}-unknown.json`);
    const assets = createAssetManifest({ manifestPath: path, required: false, warn: () => {} });

    expect(() => assets.assets(['dashbaord'])).toThrow(AssetManifestError);
    expect(() => assets.assets(['dashbaord'])).toThrow(/dashbaord/);
  });

  it('accepts every Vite entry before the first build, so a fresh clone cannot 500', () => {
    // Parse the input map instead of importing Vite config: this test only needs the declared keys, and a source
    // assertion fails in the same commit that adds an entry without teaching the optional-manifest guard about it.
    const source = readFileSync('vite.config.js', 'utf8');
    const input = /input:\s*\{([\s\S]*?)\n\s*\},/.exec(source)?.[1];
    expect(input).toBeTruthy();
    const entries = [...input.matchAll(/^\s*([a-z][a-z0-9]*):\s*fileURLToPath/gm)].map((match) => match[1]);

    expect(entries.length).toBeGreaterThanOrEqual(5);
    expect([...KNOWN_ENTRIES].sort()).toEqual([...entries].sort());

    const path = join(tmpdir(), `metrika-missing-${Date.now()}-fresh.json`);
    const assets = createAssetManifest({ manifestPath: path, required: false, warn: () => {} });
    for (const entry of entries) {
      expect(assets.assets([entry]), entry).toEqual({ scripts: [], preloads: [] });
    }
  });

  it('re-reads a development manifest when its mtime changes', () => {
    const path = manifestFile({ 'client/entries/dashboard.jsx': { file: 'dashboard-old.js', isEntry: true } });
    const assets = createAssetManifest({ manifestPath: path, required: false, warn: () => {} });

    expect(assets.assets(['dashboard']).scripts).toEqual(['/assets/dashboard-old.js']);

    rewrite(path, { 'client/entries/dashboard.jsx': { file: 'dashboard-new.js', isEntry: true } });

    expect(assets.assets(['dashboard']).scripts).toEqual(['/assets/dashboard-new.js']);
  });

  it('keeps the startup manifest for a required build until the process restarts', () => {
    const path = manifestFile({ 'client/entries/dashboard.jsx': { file: 'dashboard-old.js', isEntry: true } });
    const assets = createAssetManifest({ manifestPath: path, required: true });

    rewrite(path, { 'client/entries/dashboard.jsx': { file: 'dashboard-new.js', isEntry: true } });

    expect(assets.assets(['dashboard']).scripts).toEqual(['/assets/dashboard-old.js']);
  });

  it('throws a configuration error instead of a request error for a corrupt manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metrika-assets-'));
    fixtures.push(dir);
    const path = join(dir, 'manifest.json');
    writeFileSync(path, '{ not json');

    expect(() => createAssetManifest({ manifestPath: path, required: true })).toThrow(AssetManifestError);
    expect(() => createAssetManifest({ manifestPath: path, required: true })).toThrow(/npm run build/);
  });
});
