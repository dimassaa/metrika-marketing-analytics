import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ASSETS = join(process.cwd(), 'public', 'assets');
const MANIFEST = join(ASSETS, '.vite', 'manifest.json');

/**
 * @param {string} dir
 * @returns {string[]} Relative paths of every file under `dir`.
 */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path).map((child) => join(name, child)) : [name];
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

  it('emits the dashboard entry and every file the manifest names', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

    for (const chunk of Object.values(manifest)) {
      expect(files, chunk.file).toContain(chunk.file);
    }
  });
});
