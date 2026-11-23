import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { addDays } from '../../src/lib/dates.js';
import { createReferenceRepository } from '../../src/repositories/reference.repo.js';
import { createMetricsModule } from '../../src/services/metrics/index.js';
import { METRICS_API_PERMISSIONS } from '../../src/routes/api.routes.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
import { wrapDb } from '../helpers/queryCounter.js';

const VIEWER = 'viewer@metrika.by';

/** @type {import('pg').Pool} */
let pool;
/** @type {import('express').Express} */
let app;

beforeAll(async () => {
  await resetTestDatabase();
  await seed();
  pool = getTestPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await pool.query('DELETE FROM sessions');
  app = makeApp({ assets: { assets: () => ({ scripts: [], preloads: [] }) } });
});

async function signedIn() {
  const agent = request.agent(app);
  const login = await loginAs(agent, VIEWER);
  expect(login.status).toBe(302);
  return agent;
}

describe('GET /api/v1/dashboard', () => {
  it('answers an anonymous request with the JSON 401 contract', async () => {
    const res = await request(app).get('/api/v1/dashboard');

    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('guards the route with the permission recorded in the shared table', async () => {
    expect(METRICS_API_PERMISSIONS['/dashboard']).toBe('dashboard:view');

    const agent = await signedIn();
    const res = await agent.get('/api/v1/dashboard');

    expect(res.status).toBe(200);
    expect(res.type).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('defaults to the configured 30-day window from the data anchor', async () => {
    const agent = await signedIn();

    const res = await agent.get('/api/v1/dashboard');

    expect(res.status).toBe(200);
    expect(res.body.period.days).toBe(30);
    expect(res.body.period.from).toBe(addDays(res.body.period.anchor, -29));
    expect(res.body.period.to).toBe(res.body.period.anchor);
  });

  it('honours days=180 as a real 180-day window, not a label', async () => {
    const agent = await signedIn();

    const res = await agent.get('/api/v1/dashboard?days=180');

    expect(res.status).toBe(200);
    expect(res.body.period.days).toBe(180);
    expect(res.body.period.from).toBe(addDays(res.body.period.anchor, -179));
  });

  it('treats repeated and comma-separated channel filters as one model', async () => {
    const { rows } = await pool.query('SELECT id::text AS id FROM channels ORDER BY code LIMIT 2');
    const ids = rows.map((row) => row.id);
    const agent = await signedIn();

    const repeated = await agent.get(`/api/v1/dashboard?channelIds=${ids[0]}&channelIds=${ids[1]}`);
    const comma = await agent.get(`/api/v1/dashboard?channelIds=${ids.join(',')}`);

    expect(repeated.status).toBe(200);
    expect(comma.status).toBe(200);
    expect(repeated.body).toEqual(comma.body);
  });

  it.each([
    ['days=45', 'days=45'],
    ['a days/from conflict', 'days=30&from=2026-10-01'],
    ['a days/to conflict', 'days=30&to=2026-11-21'],
    ['a non-numeric channel id', 'channelIds=abc'],
    ['an empty channel id', 'channelIds='],
    ['a malformed date', 'from=01.10.2026'],
  ])('answers %s with a 400 validation error, not a SQL failure', async (_label, query) => {
    const agent = await signedIn();

    const res = await agent.get(`/api/v1/dashboard?${query}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/[А-Яа-яЁё]/);
    expect(res.body.error.message).not.toMatch(/SELECT|pg_|syntax error/i);
  });

  it('returns JSON-safe money and no NaN on the seeded stand', async () => {
    const agent = await signedIn();

    const res = await agent.get('/api/v1/dashboard');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/NaN|Infinity/);
    expect(typeof res.body.kpis.spendCents).toBe('string');
    expect(res.body.charts.cac.hasData).toBe(true);
  });

  it('keeps the dashboard query budget flat on eight channels and on one', async () => {
    const counter = wrapDb(pool);
    const metrics = createMetricsModule({
      db: counter.db,
      referenceRepository: createReferenceRepository(counter.db),
    });
    const { rows: anchorRows } = await pool.query('SELECT max(stat_date)::text AS anchor FROM daily_stats');
    const anchor = anchorRows[0].anchor;
    const { rows: channelRows } = await pool.query('SELECT id::text AS id FROM channels ORDER BY code');

    counter.reset();
    await metrics.services.dashboard.getDashboardSummary({ anchor });
    const allChannels = counter.count();

    counter.reset();
    await metrics.services.dashboard.getDashboardSummary({
      anchor,
      channelIds: [channelRows[0].id],
    });
    const oneChannel = counter.count();

    expect(allChannels).toBeLessThanOrEqual(15);
    expect(oneChannel).toBeLessThanOrEqual(15);
    // The filter narrows rows in memory; it must not add a per-channel query.
    expect(oneChannel).toBe(allChannels);
  });
});
