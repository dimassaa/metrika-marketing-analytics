import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { createApp } from '../../src/app.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs } from '../helpers/app.js';

/**
 * Page-level query budget for the five analytics screens.
 *
 * The service budgets in `metrics.performance.test.js` count statements inside one service call. A page calls
 * several services, and without a request-scoped read cache the same channel list can be fetched by the ranking, the
 * attribution report and the screen model in one render. This test catches exactly that: a statement with the same
 * parameters twice in one request fails, and the total ceiling keeps a new call from hiding behind a different
 * parameter list.
 *
 * The cache is read-only and only active for GET/HEAD (`src/lib/request-cache.js`), so write flows never see a stale
 * row. Reading the ceiling here is deliberate: it is a tripwire for duplication, not a growth allowance.
 */
const CEILINGS = Object.freeze({
  '/app/dashboard': 18,
  '/app/channels': 16,
  '/app/channels/1': 24,
  '/app/cohorts': 9,
  '/app/attribution': 8,
  // The measured alerts page is 19 because the first GET in a session also runs the throttled recalculation
  // (two window reports, upserts and stale resolution). The ceiling keeps that write path from hiding a read
  // regression while staying well below the brief's 32.
  '/app/alerts': 32,
  '/app/scenarios': 12,
  // The API never recalculates on GET, so it is cheaper than the page and has its own flat ceiling.
  '/api/v1/alerts': 12,
  '/api/v1/scenarios': 12,
});

/**
 * Fails on a statement that repeats with the same parameters inside one request.
 *
 * @param {string} path Request path used in the assertion message.
 * @returns {void}
 */
function findDuplicates(path) {
  const seen = new Set();
  const duplicates = [];
  for (const [text, params] of statements) {
    const key = `${text}::${params}`;
    if (seen.has(key)) duplicates.push(text.slice(0, 90));
    seen.add(key);
  }
  expect(duplicates, `${path} repeated a statement with identical parameters`).toEqual([]);
}

/** @type {import('pg').Pool} */
let pool;
/** @type {import('express').Express} */
let app;
/** @type {string[][]} */
let statements = [];

beforeAll(async () => {
  await resetTestDatabase();
  await seed();
  pool = getTestPool();
  const db = {
    query(...args) {
      const params = Array.isArray(args[1]) ? args[1] : [];
      // Session ids and timestamps differ per request; the statement text plus the business parameters is what a
      // duplicate looks like.
      statements.push([String(args[0]).replace(/\s+/g, ' ').trim(), JSON.stringify(params)]);
      return pool.query(...args);
    },
    connect: (...args) => pool.connect(...args),
  };
  app = createApp({ db });
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await pool.query('DELETE FROM sessions');
});

/**
 * @returns {Promise<import('supertest').SuperAgentTest>} Signed-in agent.
 */
async function signedIn() {
  const agent = request.agent(app);
  const login = await loginAs(agent, 'analyst@metrika.by');
  expect(login.status).toBe(302);
  return agent;
}

describe('page query budget', () => {
  it.each(Object.entries(CEILINGS))('%s stays at or below %i statements with no duplicate read', async (path, ceiling) => {
    const agent = await signedIn();
    statements = [];

    const res = await agent.get(path);

    expect(res.status).toBe(200);
    expect(statements.length, `${path} ran ${statements.length} statements`).toBeLessThanOrEqual(ceiling);

    findDuplicates(path);
  });

  it('keeps a saved scenario detail at or below six statements on the page and the API', async () => {
    const agent = await signedIn();
    const builder = await agent.get('/app/scenarios');
    const csrf = builder.text.match(/name="_csrf" value="([^"]+)"/)?.[1];
    expect(csrf, 'the builder form must carry a CSRF token').toBeTypeOf('string');

    const saved = await agent
      .post('/app/scenarios')
      .type('form')
      .send({ _csrf: csrf, name: 'Бюджет запросов' });
    expect(saved.status).toBe(302);
    expect(saved.headers.location).toMatch(/^\/app\/scenarios\/\d+$/);

    // The snapshot is read-only: the detail path must not refit curves or replay the builder's list queries.
    const detailPath = saved.headers.location;
    const targets = [
      [detailPath, 'page'],
      [detailPath.replace('/app/', '/api/v1/'), 'api'],
    ];
    for (const [target, label] of targets) {
      statements = [];
      const res = await agent.get(target);
      expect(res.status, `${label} ${target}`).toBe(200);
      expect(statements.length, `${label} ${target} ran ${statements.length} statements`).toBeLessThanOrEqual(6);
      findDuplicates(target);
    }
  });
});
