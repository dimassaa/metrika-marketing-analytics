import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { logger } from './logger.js';

/** Queries slower than this are worth a warning: the demo stand completes every screen well under it. */
export const SLOW_QUERY_MS = 200;

/**
 * Request-scoped identity for the database observer.
 *
 * Repositories receive only a query-capable object, so the caller's user id cannot travel as an argument without
 * threading it through every method. AsyncLocalStorage carries it across the awaited statements of one request
 * instead, and the observer reads it at query time.
 */
const requestContext = new AsyncLocalStorage();

/**
 * Express middleware that runs the rest of the request inside the observer context. It must sit after the session
 * middleware, because the user is stored there.
 * @type {import('express').RequestHandler}
 */
export function withRequestUser(req, res, next) {
  requestContext.run({ userId: req.session?.user?.id ?? null }, next);
}

/**
 * Collapses a statement to one line and keeps only the leading keyword. SQL parameters are never passed to the
 * logger, and request bodies are not part of this observer at all.
 * @param {unknown} text First argument of `pg`'s `query`.
 * @returns {{ operation: string, statement: string }}
 */
function describeStatement(text) {
  if (typeof text !== 'string') return { operation: 'unknown', statement: 'unknown' };
  const normalized = text.trim().replace(/\s+/g, ' ');
  return {
    operation: normalized.split(' ')[0]?.toLowerCase() || 'unknown',
    statement: normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized,
  };
}

/** @type {WeakMap<object, Array<{ thresholdMs: number, log: Function, wrapped: Function }>>} */
const queryWrappers = new WeakMap();

/**
 * Wraps one `query` method so a slow statement produces one warning with duration, operation and user id. The result
 * and the error path are unchanged: the observer never swallows, retries or rewrites a failure.
 * @param {any} target Object owning the method (pool or checked-out client).
 * @param {number} thresholdMs
 * @param {(entry: object, message: string) => void} log
 * @returns {(...args: unknown[]) => Promise<unknown>}
 */
function observedQuery(target, thresholdMs, log) {
  let wrappers = queryWrappers.get(target);
  if (!wrappers) {
    wrappers = [];
    queryWrappers.set(target, wrappers);
  }
  // The same pool can be wrapped by more than one app in tests; a different threshold or sink gets its own wrapper.
  const cached = wrappers.find((entry) => entry.thresholdMs === thresholdMs && entry.log === log);
  if (cached) return cached.wrapped;

  const original = target.query;
  const wrapped = async (...args) => {
    const startedAt = performance.now();
    try {
      return await original.apply(target, args);
    } finally {
      const durationMs = Math.round(performance.now() - startedAt);
      if (durationMs >= thresholdMs) {
        log(
          {
            durationMs,
            userId: requestContext.getStore()?.userId ?? 'anon',
            ...describeStatement(args[0]),
          },
          'slow query',
        );
      }
    }
  };

  wrappers.push({ thresholdMs, log, wrapped });
  return wrapped;
}

/**
 * @param {any} client Checked-out `pg` client.
 * @param {number} thresholdMs
 * @param {(entry: object, message: string) => void} log
 * @returns {any} Proxy with an observed `query` and bound remaining methods.
 */
function observeClient(client, thresholdMs, log) {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'query') return observedQuery(target, thresholdMs, log);
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Wraps the injected pool so every statement, including the ones inside `withTransaction`, is timed.
 *
 * The pool keeps its identity for all other properties: `totalCount` is still forwarded (the LTV snapshot checks it)
 * and `on`/`end` stay bound to the real pool, so connect-pg-simple behaves exactly as before.
 *
 * @param {any} database Pool-like object with `query`.
 * @param {{ thresholdMs?: number, log?: (entry: object, message: string) => void }} [options]
 *   `log` is injectable for unit tests; production uses the shared pino logger.
 * @returns {any} Proxy that behaves like `database` and logs slow statements.
 */
export function observeDb(database, { thresholdMs = SLOW_QUERY_MS, log = logger.warn.bind(logger) } = {}) {
  if (!database || typeof database.query !== 'function') {
    throw new TypeError('observeDb requires a query-capable database');
  }

  const connect = database.connect;
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === 'query') return observedQuery(target, thresholdMs, log);
      if (property === 'connect' && typeof connect === 'function') {
        return async (...args) => observeClient(await connect.apply(target, args), thresholdMs, log);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
