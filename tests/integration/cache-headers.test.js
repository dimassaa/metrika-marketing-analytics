import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import session from 'express-session';
import { createApp } from '../../src/app.js';

/**
 * Cache-policy regression lock.
 *
 * These headers shipped in M1–M4 and are easy to break while "optimising" static delivery: a blanket `immutable`
 * on the public tree would pin `app.css` for a year, and a cacheable HTML document would name a bundle hash that a
 * later deploy removed. The test mounts its own hashed fixture under a temporary directory, so a clean clone
 * without `public/assets` runs the same assertions instead of skipping the only case that matters.
 */

/** @type {string} */
let fixtureDir;
/** @type {import('express').Express} */
let app;

const HASHED_ASSET = 'dashboard-c4ch3f1xtur3.js';

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'metrika-cache-'));
  writeFileSync(join(fixtureDir, HASHED_ASSET), 'export const fixture = true;\n');

  app = createApp({
    // Nothing in this file needs a query; a landing or static request that reaches the database is a defect.
    db: {
      query: () => {
        throw new Error('cache-header checks must not query the database');
      },
    },
    sessionStore: new session.MemoryStore(),
    assets: { assets: () => ({ scripts: [], preloads: [] }) },
    assetsDir: fixtureDir,
  });
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('static asset cache policy', () => {
  it('marks a fingerprinted asset immutable for one year', async () => {
    const res = await request(app).get(`/assets/${HASHED_ASSET}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=31536000');
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('keeps the unhashed stylesheet on revalidation instead of immutable', async () => {
    const res = await request(app).get('/css/app.css');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=0');
    expect(res.headers['cache-control']).not.toContain('immutable');
    expect(res.headers.etag).toBeTypeOf('string');
  });

  it('answers a conditional stylesheet request with 304 and an empty body', async () => {
    const first = await request(app).get('/css/app.css');
    const second = await request(app).get('/css/app.css').set('If-None-Match', first.headers.etag);

    expect(second.status).toBe(304);
    expect(second.text ?? '').toBe('');
  });

  it('keeps the unhashed OG cover revalidating rather than immutable', async () => {
    const res = await request(app).get('/img/og-cover.svg');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=0');
    expect(res.headers['cache-control']).not.toContain('immutable');
  });

  it('does not pin the HTML document that names the current bundle hash', async () => {
    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    const cacheControl = res.headers['cache-control'] ?? '';
    expect(cacheControl).not.toContain('immutable');
    expect(cacheControl).not.toContain('max-age=31536000');
  });
});

describe('private surface cache policy', () => {
  it('sends no-store and a noindex header on the redirect into the app', async () => {
    const res = await request(app).get('/app/dashboard');

    expect(res.status).toBe(302);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('sends no-store on an unauthenticated API response', async () => {
    const res = await request(app).get('/api/v1/alerts');

    expect(res.status).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('keeps the health probe uncacheable even when the database is down', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('crawl rules stay locked', () => {
  it('keeps the login form noindex', async () => {
    const res = await request(app).get('/login');

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<meta name="robots" content="noindex/);
  });

  it('keeps /app and /api out of robots.txt and only the landing in the sitemap', async () => {
    const robots = await request(app).get('/robots.txt');
    const sitemap = await request(app).get('/sitemap.xml');

    expect(robots.text).toContain('Disallow: /app');
    expect(robots.text).toContain('Disallow: /api');
    expect(sitemap.text.match(/<loc>/g)).toHaveLength(1);
  });
});
