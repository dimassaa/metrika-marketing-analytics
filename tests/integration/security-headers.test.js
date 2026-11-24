import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import session from 'express-session';
import { createApp } from '../../src/app.js';

const PROBE_NAME = 'security-headers-probe.js';
const PROBE_PATH = join(process.cwd(), 'public', 'assets', PROBE_NAME);

const ASSET_STUB = { assets: () => ({ scripts: [], preloads: [] }) };

/**
 * A fake database keeps this suite free of PostgreSQL: every request below is answered before a repository is called
 * (the app page redirects an anonymous visitor, the API returns 401, and `/health` only needs `SELECT 1`).
 * @param {{ hsts?: boolean }} [options]
 * @returns {import('express').Express}
 */
function buildApp(options = {}) {
  return createApp({
    db: { query: async () => ({ rows: [{ ok: 1 }] }) },
    sessionStore: new session.MemoryStore(),
    assets: ASSET_STUB,
    ...options,
  });
}

/**
 * @param {import('express').Express} app
 * @param {string} path
 * @returns {Promise<import('supertest').Response>}
 */
function get(app, path) {
  return request(app).get(path);
}

beforeAll(() => {
  mkdirSync(join(process.cwd(), 'public', 'assets'), { recursive: true });
  writeFileSync(PROBE_PATH, 'export const probe = true;\n');
});

afterAll(() => {
  rmSync(PROBE_PATH, { force: true });
});

describe('security headers', () => {
  const app = buildApp();

  const PAGES = ['/', '/login', '/app/dashboard', '/api/v1/dashboard', '/health'];

  it.each(PAGES)('sets the common header set on %s', async (path) => {
    const res = await get(app, path);

    expect(res.headers['content-security-policy']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it.each(['/', '/login'])('keeps the CSP strict and nonce-based on %s', async (path) => {
    const res = await get(app, path);
    const csp = res.headers['content-security-policy'];

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toMatch(/script-src[^;]*'nonce-/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("script-src-attr 'none'");
    // Recharts writes inline style attributes; this is the forced relaxation, not a script one.
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
  });

  it.each(['/app/dashboard', '/api/v1/dashboard'])('closes %s to crawlers', async (path) => {
    const res = await get(app, path);

    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it.each(['/', '/login', '/health'])('does not add X-Robots-Tag to %s', async (path) => {
    const res = await get(app, path);

    expect(res.headers['x-robots-tag']).toBeUndefined();
  });

  it('does not send HSTS on a plain-HTTP demo stand', async () => {
    const res = await get(app, '/login');

    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('sends HSTS when cookies are marked secure', async () => {
    const secureApp = buildApp({ hsts: true });
    const res = await get(secureApp, '/login');

    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('keeps the single stylesheet revalidated and fingerprinted assets immutable', async () => {
    const css = await get(app, '/css/app.css');
    expect(css.status).toBe(200);
    expect(css.headers['cache-control']).toContain('max-age=0');

    const asset = await get(app, `/assets/${PROBE_NAME}`);
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('never caches the app shell, the API or the health probe', async () => {
    for (const path of ['/app/dashboard', '/api/v1/dashboard', '/health']) {
      const res = await get(app, path);
      expect(res.headers['cache-control'], path).toBe('no-store');
    }
  });
});
