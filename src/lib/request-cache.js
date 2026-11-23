import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped read cache for repository calls.
 *
 * One page render asks several services for the same small reference rows: the ranking, the attribution report and
 * the screen model each need the channel list, and the passport loads the channel twice (metrics + the edit card).
 * The rows are read-only for the duration of a GET, so fetching them again is pure duplication — three identical
 * `SELECT ... FROM channels` statements for one screen.
 *
 * The cache is deliberately narrow:
 * - only GET and HEAD enter a store, so a POST that updates a channel can never read its own pre-update row;
 * - callers opt in per method and pass a key that includes every parameter, so no generic proxy guesses;
 * - the store holds rows (plain objects), and the repository maps them again on each call, so one caller mutating a
 *   returned object cannot change what the next caller sees;
 * - a rejected query is evicted, so a later call in the same request can retry instead of sharing the failure.
 *
 * Outside an HTTP request (unit tests, scripts, seed) `cachedRead` is a pass-through.
 */
const storage = new AsyncLocalStorage();

/**
 * Express middleware: opens a cache for the duration of a read request.
 *
 * Express runs downstream handlers inside `next()`, so the store is visible to every controller, service and
 * repository reached from this request without threading a context argument through the layers.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
export function requestCache(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  storage.run(new Map(), next);
}

/**
 * Returns the cached promise for `key`, or starts `load` once.
 *
 * @template T
 * @param {string} key Stable key that names the method and every parameter.
 * @param {() => Promise<T>} load Read to perform when the key is not cached.
 * @returns {Promise<T>}
 */
export function cachedRead(key, load) {
  const cache = storage.getStore();
  if (!cache) return load();

  if (!cache.has(key)) {
    const pending = load();
    cache.set(key, pending);
    // Keep a failed read out of the cache; otherwise one timeout would fail every later caller in the same render.
    pending.catch(() => cache.delete(key));
  }
  return cache.get(key);
}
