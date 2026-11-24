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
 *
 * The counter wraps the pool and the checked-out client, and forwards `totalCount` so
 * `cohortsRepository.withSnapshot` opens its real repeatable-read transaction. Every statement in the page —
 * session I/O, `BEGIN`, the snapshot reads, `COMMIT` — is therefore part of the measured number.
 */
const CEILINGS = Object.freeze({
  '/app/dashboard': 18,
  '/app/channels': 16,
  // Two LTV snapshots (channel health and the ranking row) open a repeatable-read transaction each:
  // 2 × [BEGIN + three reads + COMMIT]. The ceiling is the measured total including those statements.
  '/app/channels/1': 27,
  '/app/cohorts': 9,
  '/app/attribution': 8,
  // The measured alerts page is 26 because the first GET in a session also runs the throttled recalculation
  // (two window reports, upserts and stale resolution). The ceiling keeps that write path from hiding a read
  // regression while staying below the brief's 32.
  '/app/alerts': 32,
  '/app/scenarios': 12,
  // The API never recalculates on GET, so it is cheaper than the page and has its own flat ceiling.
  '/api/v1/alerts': 12,
  '/api/v1/scenarios': 12,
});

/** Transaction statements repeat once per snapshot by design; they are counted but never treated as duplicate reads. */
const TRANSACTION_CONTROL = /^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\b/i;

/**
 * Fails on a read statement that repeats with the same parameters inside one request.
 *
 * Statements inside a write transaction are skipped: the alerts recalculation legitimately reads the affected rows
 * to build its report and the page reads the list again after COMMIT. The tripwire targets duplicate reads in the
 * read model, not the read-check-write sequence of a mutation.
 *
 * @param {string} path Request path used in the assertion message.
 * @returns {void}
 */
function findDuplicates(path) {
  const seen = new Set();
  const duplicates = [];
  for (const [text, params, inWriteTransaction] of statements) {
    if (TRANSACTION_CONTROL.test(text) || inWriteTransaction) continue;
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
/** @type {Array<[string, string, boolean]>} Statements as `[text, params, insideWriteTransaction]`. */
let statements = [];

/**
 * Records one statement. Session ids and timestamps differ per request; the statement text plus the business
 * parameters is what a duplicate looks like.
 * @param {unknown[]} args Arguments of `pg`'s `query`.
 * @param {boolean} [inWriteTransaction] True for statements inside a plain `BEGIN … COMMIT`.
 */
function recordStatement(args, inWriteTransaction = false) {
  const params = Array.isArray(args[1]) ? args[1] : [];
  statements.push([String(args[0]).replace(/\s+/g, ' ').trim(), JSON.stringify(params), inWriteTransaction]);
}

beforeAll(async () => {
  await resetTestDatabase();
  await seed();
  pool = getTestPool();
  const db = {
    query(...args) {
      recordStatement(args);
      return pool.query(...args);
    },
    // `withSnapshot` opens a transaction only when the database exposes `totalCount` (a pool does, a checked-out
    // client does not). Forwarding it makes the test exercise the production branch instead of the "already inside
    // a transaction" shortcut. Wrapping `client.query` then counts BEGIN, the snapshot reads and COMMIT.
    async connect(...args) {
      const client = await pool.connect(...args);
      // A plain BEGIN opens a write transaction; the read-only snapshot spells out `READ ONLY`, so its statements
      // stay eligible for the duplicate-read check while a mutation's re-read does not.
      let inWriteTransaction = false;
      return {
        query(...queryArgs) {
          const text = String(queryArgs[0] ?? '');
          recordStatement(queryArgs, inWriteTransaction);
          if (/^BEGIN\b/i.test(text) && !/READ ONLY/i.test(text)) inWriteTransaction = true;
          if (/^(COMMIT|ROLLBACK)\b/i.test(text)) inWriteTransaction = false;
          return client.query(...queryArgs);
        },
        release(...releaseArgs) {
          return client.release(...releaseArgs);
        },
      };
    },
  };
  Object.defineProperty(db, 'totalCount', { get: () => pool.totalCount });
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

  it('counts both LTV snapshots on the channel passport', async () => {
    const agent = await signedIn();
    statements = [];

    const res = await agent.get('/app/channels/1');

    expect(res.status).toBe(200);
    // Two snapshots × [BEGIN + three reads + COMMIT]; a wrapper that hides `totalCount` drops the four
    // transaction-control statements and silently measures 23 instead of 27.
    const snapshotBegins = statements.filter(([text]) =>
      /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/i.test(text),
    );
    expect(snapshotBegins).toHaveLength(2);
    expect(statements).toHaveLength(27);
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
