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
});

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

    const seen = new Set();
    const duplicates = [];
    for (const [text, params] of statements) {
      const key = `${text}::${params}`;
      if (seen.has(key)) duplicates.push(text.slice(0, 90));
      seen.add(key);
    }
    expect(duplicates, `${path} repeated a statement with identical parameters`).toEqual([]);
  });
});
