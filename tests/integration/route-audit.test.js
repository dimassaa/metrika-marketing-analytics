import { describe, expect, it } from 'vitest';
import session from 'express-session';
import { createApp } from '../../src/app.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** The only non-GET routes allowed to run without an authentication guard. CSRF still applies to both. */
const PUBLIC_MUTATIONS = new Set(['POST /login', 'POST /logout']);

/**
 * @param {string} prefix Mount path accumulated from the application root.
 * @param {string} part Layer path in Express 5 (`rawPath` for a mount, `route.path` for a route).
 * @returns {string} One normalised absolute path.
 */
function joinPath(prefix, part) {
  const joined = `${prefix}${part.startsWith('/') ? '' : '/'}${part}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/**
 * Mount paths of one Express 5 layer. A router can be mounted on several paths, so the walk descends once per path.
 * @param {any} layer
 * @returns {string[]}
 */
function mountPaths(layer) {
  const raw = layer.rawPath;
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw) && raw.length > 0) return raw;
  // A future Express change must fail here, not silently skip a whole subtree.
  throw new Error(`route audit cannot read the mount path of layer "${layer.name}"`);
}

/**
 * Walks the router tree and returns one entry per method/path pair. Guard and CSRF flags are inherited from the
 * layers above the route, which is how the global `csrfProtection` mount protects nested API routers.
 * @param {import('express').Express} app
 * @returns {{
 *   routes: Array<{ method: string, path: string, csrf: boolean, auth: boolean, permission: string | null }>,
 *   globalCsrfLayers: number,
 * }}
 */
function collectRoutes(app) {
  const routes = [];
  let globalCsrfLayers = 0;

  /**
   * @param {any[]} stack
   * @param {string} prefix
   * @param {{ csrf: boolean, auth: boolean }} inherited
   */
  function walk(stack, prefix, inherited) {
    // Middleware applies to the layers after it: the state accumulates down the stack and is copied into every nested
    // router, so a child inheriting the global CSRF mount cannot leak changes back to a sibling.
    let state = { ...inherited };
    for (const layer of stack) {
      if (layer.route) {
        const path = joinPath(prefix, layer.route.path);
        const handlers = layer.route.stack.map((entry) => entry.handle).filter((fn) => typeof fn === 'function');
        const csrf = state.csrf || handlers.some((fn) => fn.csrf === true);
        const auth = state.auth || handlers.some((fn) => fn.auth === true);
        const permission =
          handlers.find((fn) => typeof fn.permission === 'string')?.permission ?? null;

        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (!enabled) continue;
          routes.push({ method: method.toUpperCase(), path, csrf, auth, permission });
        }
        continue;
      }

      if (typeof layer.handle !== 'function') {
        throw new Error(`route audit cannot walk layer "${layer.name}": handle is not a function`);
      }
      if (layer.handle.csrf === true) {
        globalCsrfLayers += 1;
      }

      state = {
        csrf: state.csrf || layer.handle.csrf === true,
        auth: state.auth || layer.handle.auth === true,
      };

      if (Array.isArray(layer.handle.stack)) {
        for (const mount of mountPaths(layer)) {
          walk(layer.handle.stack, joinPath(prefix, mount), state);
        }
      }
    }
  }

  walk(app.router.stack, '', { csrf: false, auth: false });
  return { routes, globalCsrfLayers };
}

function buildApp() {
  return createApp({
    db: { query: async () => ({ rows: [] }) },
    sessionStore: new session.MemoryStore(),
    assets: { assets: () => ({ scripts: [], preloads: [] }) },
  });
}

describe('route access audit', () => {
  const app = buildApp();
  const { routes, globalCsrfLayers } = collectRoutes(app);

  it('finds the full route surface', () => {
    expect(routes.length).toBeGreaterThanOrEqual(30);
    expect(new Set(routes.map((route) => `${route.method} ${route.path}`)).size).toBe(routes.length);
  });

  it('accounts for the global CSRF layer instead of assuming it', () => {
    expect(globalCsrfLayers).toBe(1);
  });

  it('marks every mutating route with CSRF protection', () => {
    const unprotected = routes
      .filter((route) => !SAFE_METHODS.has(route.method) && !route.csrf)
      .map((route) => `${route.method} ${route.path}`);

    expect(unprotected, `mutating routes without CSRF:\n${unprotected.join('\n')}`).toEqual([]);
  });

  it('guards every app and API route, and every public mutation except login/logout', () => {
    const unguarded = routes
      .filter((route) => {
        const inApp = route.path === '/app' || route.path.startsWith('/app/');
        const inApi = route.path === '/api' || route.path.startsWith('/api/');
        if (inApp || inApi) return !route.auth;

        const key = `${route.method} ${route.path}`;
        if (SAFE_METHODS.has(route.method) || PUBLIC_MUTATIONS.has(key)) return false;
        return !route.auth;
      })
      .map((route) => `${route.method} ${route.path}`);

    expect(unguarded, `routes without an auth/permission guard:\n${unguarded.join('\n')}`).toEqual([]);
  });

  it('keeps the public mutation allowlist exactly login and logout', () => {
    const publicMutations = routes
      .filter((route) => !SAFE_METHODS.has(route.method) && !route.auth)
      .map((route) => `${route.method} ${route.path}`)
      .sort();

    expect(publicMutations).toEqual([...PUBLIC_MUTATIONS].sort());
  });

  it('records the permission label on app mutations that carry one', () => {
    const withoutPermission = routes
      .filter((route) => route.path.startsWith('/app/') && !SAFE_METHODS.has(route.method))
      // Own-account actions require only a login; every other mutation names its permission.
      .filter((route) => !['/app/profile/password'].includes(route.path))
      .filter((route) => route.permission === null)
      .map((route) => `${route.method} ${route.path}`);

    expect(
      withoutPermission,
      `app mutations without a permission label:\n${withoutPermission.join('\n')}`,
    ).toEqual([]);
  });
});
