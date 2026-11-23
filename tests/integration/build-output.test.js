import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const ASSETS = join(process.cwd(), 'public', 'assets');
const MANIFEST = join(ASSETS, '.vite', 'manifest.json');

/**
 * Gzip ceilings from the M4 plan. The build is one entry, so the entry and the page are measured on the same file;
 * `imports`/`dynamicImports` are included in the page total in case a later split moves code out.
 *
 * The measurement uses zlib level 9, matching the numbers recorded in `IMPROVEMENTS.md`. zlib output can differ by a
 * few bytes between Node versions, which is why the ceilings are whole kilobytes and the test reports the measured
 * value on failure. The guard runs only when a build exists (`describe.skipIf`), so CI must build before testing —
 * the same precondition as the other tests in this file.
 */
const ENTRY_GZIP_BUDGET = 210 * 1024;
const PAGE_GZIP_BUDGET = 250 * 1024;

/**
 * @param {string} path
 * @returns {string} Path with forward slashes, matching the manifest's separators on every OS.
 */
function toPosix(path) {
  return path.split(sep).join('/');
}

/**
 * @param {string} dir
 * @returns {string[]} Relative paths of every file under `dir`, with forward slashes.
 */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? walk(path).map((child) => toPosix(join(name, child)))
      : [name];
  });
}

const hasBuild = existsSync(MANIFEST);
const files = hasBuild ? walk(ASSETS) : [];

describe.skipIf(!hasBuild)('vite build output', () => {
  it('has no nested assets directory: publicDir is disabled and asset names are flat', () => {
    expect(files.some((file) => file === 'assets' || file.startsWith('assets/'))).toBe(false);
  });

  it('emits no stylesheet, because the app has exactly one CSS file outside the bundle', () => {
    expect(files.filter((file) => file.endsWith('.css'))).toEqual([]);
  });

  it('writes the manifest the Express helper reads', () => {
    expect(existsSync(MANIFEST)).toBe(true);
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    expect(manifest['client/entries/dashboard.jsx']?.isEntry).toBe(true);
  });

  it('keeps the dashboard entry and the whole page under their gzip budgets', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const entryKey = 'client/entries/dashboard.jsx';
    const entry = manifest[entryKey];
    const chunkKeys = new Set([
      entryKey,
      ...(entry.imports ?? []),
      ...(entry.dynamicImports ?? []),
    ]);
    const pageFiles = new Set(
      [...chunkKeys].map((key) => manifest[key]?.file).filter((file) => typeof file === 'string'),
    );

    /** @param {string} file */
    const gzipSize = (file) => gzipSync(readFileSync(join(ASSETS, file)), { level: 9 }).length;

    const entryGzip = gzipSize(entry.file);
    const pageGzip = [...pageFiles].reduce((sum, file) => sum + gzipSize(file), 0);

    expect(entryGzip, `entry gzip is ${entryGzip} B, budget ${ENTRY_GZIP_BUDGET} B`).toBeLessThanOrEqual(
      ENTRY_GZIP_BUDGET,
    );
    expect(pageGzip, `page gzip is ${pageGzip} B, budget ${PAGE_GZIP_BUDGET} B`).toBeLessThanOrEqual(
      PAGE_GZIP_BUDGET,
    );
  });

  it('emits the dashboard entry and every file the manifest names', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

    for (const chunk of Object.values(manifest)) {
      expect(files, chunk.file).toContain(chunk.file);
    }
  });

  it('ships the production React build even when .env sets NODE_ENV=development', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const entry = readFileSync(join(ASSETS, manifest['client/entries/dashboard.jsx'].file), 'utf8');

    // This warning only exists in react-dom's development build; its presence means `define` did not win.
    expect(entry).not.toContain('Each child in a list');
    expect(entry).not.toContain('react-dom.development');
    // The production runtime has no jsxDEV. Seeing it means plugin-react chose the development transform from
    // `.env` while the runtime was production, which crashes the island at mount.
    expect(entry).not.toContain('jsxDEV');
  });
});
