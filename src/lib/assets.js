import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Vite manifest access for the EJS shell.
 *
 * A page is server-rendered, so it has to name the fingerprinted file before the browser can run the island. The
 * manifest is the only source of those names; guessing `dashboard.js` would silently serve a stale bundle after a
 * deploy. This module is deliberately separate from Express: it can be unit-tested against a temp directory.
 */

/** Absolute path of the directory Vite writes into (`vite.config.js` -> `build.outDir`). */
export const ASSETS_DIR = fileURLToPath(new URL('../../public/assets', import.meta.url));

/** Default manifest location produced by Vite 7 (`build.manifest: true`). */
export const DEFAULT_MANIFEST_PATH = join(ASSETS_DIR, '.vite', 'manifest.json');

/**
 * Configuration failure: the build did not run or the manifest is corrupt. It is not an `AppError` because it is
 * not caused by a request, and the central error middleware must not translate it into a user-facing 4xx.
 */
export class AssetManifestError extends Error {
  /**
   * @param {string} message Operator-facing explanation with the path and the command that fixes it.
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'AssetManifestError';
  }
}

/**
 * Maps a public `/assets/...` URL back to the file on disk. Tests use it to check that every manifest entry points
 * at a real file; production code only needs the URL.
 * @param {string} src URL as written into the manifest (`dashboard-abc.js` after prefixing).
 * @returns {string} Absolute path under `public/assets`.
 */
export function absoluteAssetPath(src) {
  const relative = String(src).replace(/^\/?assets\//, '');
  return join(ASSETS_DIR, relative);
}

/**
 * Entry names the server may ask for. This list mirrors `build.rollupOptions.input` in `vite.config.js`; it is the
 * only way to reject a typo when the optional manifest is absent, because an absent manifest cannot name its entries.
 * When a manifest exists, the manifest itself is authoritative and this list is not consulted.
 */
const KNOWN_ENTRIES = new Set(['dashboard', 'channels']);

/**
 * @param {string} entryName Short entry name from the controller (`dashboard`).
 * @returns {string} Manifest key Vite produces for that entry.
 */
function manifestKey(entryName) {
  return `client/entries/${entryName}.jsx`;
}

/**
 * Creates a lazy manifest reader.
 *
 * A required manifest (production default) is read once at construction and never reloaded: it is startup
 * configuration, and a changed file under a running server would mean a half-deployed release. An optional
 * manifest (development/test) is re-read when its mtime changes, because `vite build --watch` rewrites it while the
 * long-lived Node process keeps running. Without a manifest the optional reader warns once and returns no scripts,
 * so a fresh clone can open pages before the first build.
 *
 * @param {{
 *   manifestPath?: string,
 *   required?: boolean,
 *   warn?: (details: object, message: string) => void,
 * }} [options]
 * @returns {{ assets: (entryNames: string | string[]) => { scripts: string[], preloads: string[] } }}
 * @throws {AssetManifestError} When a required manifest is missing or unreadable at startup.
 */
export function createAssetManifest({
  manifestPath = DEFAULT_MANIFEST_PATH,
  required = env.nodeEnv === 'production',
  warn = logger.warn.bind(logger),
} = {}) {
  /** @type {Record<string, { file: string, imports?: string[] }> | null} */
  let manifest = null;
  let mtimeMs = null;
  let loaded = false;
  let missingWarned = false;

  /**
   * @param {boolean} force Reload even when the mtime matches.
   * @returns {Record<string, { file: string, imports?: string[] }> | null} Parsed manifest, or null when optional
   *   and absent.
   * @throws {AssetManifestError} When the manifest is required but missing, or the JSON is malformed.
   */
  function load(force = false) {
    if (required && loaded && !force) return manifest;

    let stats;
    try {
      stats = statSync(manifestPath);
    } catch {
      if (required) {
        throw new AssetManifestError(
          `Asset manifest not found at ${manifestPath}. Run "npm run build" before starting in production.`,
        );
      }
      manifest = null;
      loaded = true;
      mtimeMs = null;
      if (!missingWarned) {
        missingWarned = true;
        warn(
          { manifestPath },
          'asset manifest is missing: pages render without islands until "npm run build" runs',
        );
      }
      return null;
    }

    if (!required && loaded && stats.mtimeMs === mtimeMs && !force) return manifest;

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new AssetManifestError(
        `Asset manifest at ${manifestPath} is unreadable. Rebuild it with "npm run build".`,
        { cause: error },
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AssetManifestError(
        `Asset manifest at ${manifestPath} is not an object. Rebuild it with "npm run build".`,
      );
    }

    manifest = parsed;
    mtimeMs = stats.mtimeMs;
    loaded = true;
    missingWarned = false;
    return manifest;
  }

  /**
   * Resolves the entry files and every chunk they import, recursively.
   *
   * @param {{ file: string, imports?: string[] }} chunk
   * @param {Set<string>} preloads Accumulator of chunk file names.
   * @param {Set<string>} visited Manifest keys already walked, so a cycle cannot loop forever.
   * @param {Record<string, { file: string, imports?: string[] }>} tree
   * @returns {void}
   */
  function collectImports(chunk, preloads, visited, tree) {
    for (const key of chunk.imports ?? []) {
      if (visited.has(key)) continue;
      visited.add(key);
      const imported = tree[key];
      if (!imported) {
        throw new AssetManifestError(
          `Asset manifest imports an unknown chunk "${key}". Rebuild it with "npm run build".`,
        );
      }
      preloads.add(imported.file);
      collectImports(imported, preloads, visited, tree);
    }
  }

  // A required manifest is startup configuration: read it now so a missing file stops the process before Express
  // starts accepting requests, not on the first dashboard visit.
  if (required) load();

  return {
    /**
     * @param {string | string[]} entryNames One entry or a page's list of entries.
     * @returns {{ scripts: string[], preloads: string[] }} Absolute URLs, entry scripts first; preloads are the
     *   imported chunks in import order, without duplicates.
     * @throws {AssetManifestError} When an entry is not in the manifest; a typo in a controller must not silently
     *   render a page without its island.
     */
    assets(entryNames) {
      const names = Array.isArray(entryNames) ? entryNames : [entryNames];
      if (names.length === 0) return { scripts: [], preloads: [] };

      const tree = load();
      if (tree === null) {
        // Without a manifest the only check left is the declared entry list; a typo must still fail loudly instead
        // of rendering a page with a silently missing island.
        for (const name of names) {
          if (!KNOWN_ENTRIES.has(name)) {
            throw new AssetManifestError(
              `Unknown island entry "${name}". Known entries: ${[...KNOWN_ENTRIES].join(', ')}.`,
            );
          }
        }
        return { scripts: [], preloads: [] };
      }

      /** @type {string[]} */
      const scripts = [];
      const preloads = new Set();
      const visited = new Set();

      for (const name of names) {
        const key = manifestKey(name);
        const entry = tree[key];
        if (!entry) {
          throw new AssetManifestError(
            `Asset manifest has no entry "${name}" (expected key "${key}"). Rebuild it with "npm run build".`,
          );
        }
        scripts.push(`/assets/${entry.file}`);
        collectImports(entry, preloads, visited, tree);
      }

      return { scripts, preloads: [...preloads].map((file) => `/assets/${file}`) };
    },
  };
}
