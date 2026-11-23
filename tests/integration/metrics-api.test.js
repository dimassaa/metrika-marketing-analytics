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

describe('GET /api/v1/channels', () => {
  it('is guarded by channels:view and answers the same screen model as the page', async () => {
    expect(METRICS_API_PERMISSIONS['/channels']).toBe('channels:view');

    const agent = await signedIn();
    const res = await agent.get('/api/v1/channels');

    expect(res.status).toBe(200);
    expect(res.type).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.rows).toHaveLength(8);
    expect(res.body.excluded.at(-1)).toMatchObject({ code: 'blended', reason: 'blended' });
    expect(JSON.stringify(res.body)).not.toMatch(/NaN|Infinity/);
  });

  it('rejects an unknown filter and a malformed weight with 400', async () => {
    const agent = await signedIn();

    for (const query of ['status=bogus', 'sort=bogus', 'dir=sideways', 'wCac=abc', 'wCac=10&wRomi=20']) {
      const res = await agent.get(`/api/v1/channels?${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code, query).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('changes the order when custom weights favour another criterion', async () => {
    const agent = await signedIn();

    const byDefault = await agent.get('/api/v1/channels');
    const byRomi = await agent.get('/api/v1/channels?wCac=0&wRomi=100&wLtvCac=0&wNewCustomers=0');

    expect(byRomi.status).toBe(200);
    expect(byRomi.body.weights).toEqual({ cac: 0, romi: 1, ltvCac: 0, newCustomers: 0 });
    expect(byRomi.body.weightsBasisPoints).toEqual({ cac: 0, romi: 1000, ltvCac: 0, newCustomers: 0 });
    expect(byRomi.body.rows.filter((row) => row.rank !== null).map((row) => row.code)).not.toEqual(
      byDefault.body.rows.filter((row) => row.rank !== null).map((row) => row.code),
    );
  });
});

describe('GET /api/v1/channels/:id', () => {
  it('requires a session and the channels:view permission', async () => {
    expect(METRICS_API_PERMISSIONS['/channels/:id']).toBe('channels:view');
    const { rows } = await pool.query('SELECT id::text AS id FROM channels ORDER BY id LIMIT 1');
    const id = rows[0].id;

    const anonymous = await request(app).get(`/api/v1/channels/${id}`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHORIZED');

    const agent = await signedIn();
    const res = await agent.get(`/api/v1/channels/${id}`);
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects an invalid period with 400 and an unknown id with 404 JSON', async () => {
    const agent = await signedIn();
    const { rows } = await pool.query('SELECT id::text AS id FROM channels ORDER BY id LIMIT 1');

    const period = await agent.get(`/api/v1/channels/${rows[0].id}?days=45`);
    expect(period.status).toBe(400);
    expect(period.body.error.code).toBe('VALIDATION_ERROR');

    for (const id of ['999999', 'abc']) {
      const res = await agent.get(`/api/v1/channels/${id}`);
      expect(res.status, id).toBe(404);
      expect(res.type, id).toMatch(/application\/json/);
      expect(res.body.error.code, id).toBe('NOT_FOUND');
    }
  });

  it('returns a JSON-safe empty passport for a channel without statistics', async () => {
    const { rows } = await pool.query(
      `INSERT INTO channels (code, name, kind, target_cac_cents, target_romi_pct)
       VALUES ('api_empty', 'API empty', 'paid', 5000, 100)
       RETURNING id::text AS id`,
    );
    const id = rows[0].id;
    const agent = await signedIn();

    try {
      const res = await agent.get(`/api/v1/channels/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.health.status).toBe('no_data');
      expect(res.body.funnel.stages).toHaveLength(5);
      expect(res.body.funnel.meterMax).toBe(1);
      expect(res.body.retention.hasData).toBe(false);
      expect(JSON.stringify(res.body)).not.toMatch(/NaN|Infinity/);
    } finally {
      await pool.query('DELETE FROM channels WHERE id = $1::bigint', [id]);
    }
  });
});

describe('GET /api/v1/cohorts', () => {
  it('requires a session and the cohorts:view permission', async () => {
    expect(METRICS_API_PERMISSIONS['/cohorts']).toBe('cohorts:view');

    const anonymous = await request(app).get('/api/v1/cohorts');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHORIZED');

    const agent = await signedIn();
    const res = await agent.get('/api/v1/cohorts');

    expect(res.status).toBe(200);
    expect(res.type).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.page).toBe('cohorts');
    expect(res.body.horizonMonths).toBe(12);
    expect(res.body.cohorts.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/NaN|Infinity/);
  });

  it('honours horizon=3 and horizon=6 as real matrix widths', async () => {
    const agent = await signedIn();

    for (const horizon of [3, 6]) {
      const res = await agent.get(`/api/v1/cohorts?horizon=${horizon}`);

      expect(res.status, String(horizon)).toBe(200);
      expect(res.body.horizonMonths).toBe(horizon);
      expect(res.body.table.columns).toHaveLength(horizon + 3);
      expect(res.body.charts.ltv.series).toHaveLength(horizon);
    }
  });

  it('rejects an unsupported horizon and a malformed filter with 400', async () => {
    const agent = await signedIn();

    for (const query of [
      'horizon=7',
      'horizon=0',
      'horizon=abc',
      'horizon=',
      'channelId=abc',
      'channelId=',
      'fromCohortMonth=2026-13',
    ]) {
      const res = await agent.get(`/api/v1/cohorts?${query}`);

      expect(res.status, query).toBe(400);
      expect(res.body.error.code, query).toBe('VALIDATION_ERROR');
      expect(res.body.error.message, query).toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('accepts a channel filter and returns that channel in the LTV rows', async () => {
    const { rows } = await pool.query(
      `SELECT c.id::text AS id
         FROM channels c
        WHERE EXISTS (SELECT 1 FROM customers cu WHERE cu.first_channel_id = c.id)
        ORDER BY c.code
        LIMIT 1`,
    );
    const id = rows[0].id;
    const agent = await signedIn();

    const res = await agent.get(`/api/v1/cohorts?channelId=${id}`);

    expect(res.status).toBe(200);
    expect(res.body.channelLtv).toHaveLength(1);
    expect(res.body.channelLtv[0].channelId).toBe(id);
    expect(res.body.cohorts.length).toBeGreaterThan(0);
  });
});

describe('GET /api/v1/ranking', () => {
  it('is guarded by channels:view and returns the raw M3 ranking report', async () => {
    expect(METRICS_API_PERMISSIONS['/ranking']).toBe('channels:view');

    const agent = await signedIn();
    const res = await agent.get('/api/v1/ranking');

    expect(res.status).toBe(200);
    expect(res.type).toMatch(/application\/json/);
    expect(res.body.ranked.length).toBeGreaterThan(0);
    expect(res.body.excluded).toContainEqual({ code: 'blended', reason: 'blended', reasonLabel: 'Сводная строка' });
    expect(Object.values(res.body.weightsBasisPoints).reduce((sum, value) => sum + value, 0)).toBe(1000);

    for (const row of res.body.ranked) {
      const sum = row.contributions.reduce((total, entry) => total + entry.contribution, 0);
      expect(Math.abs(sum - row.score)).toBeLessThanOrEqual(0.05);
    }
  });

  it('rejects a partial or non-numeric weight set with 400', async () => {
    const agent = await signedIn();

    for (const query of ['wCac=abc', 'wCac=10&wRomi=20', 'wCac=0&wRomi=0&wLtvCac=0&wNewCustomers=0']) {
      const res = await agent.get(`/api/v1/ranking?${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code, query).toBe('VALIDATION_ERROR');
    }
  });
});

describe('channel API query budgets', () => {
  it('keeps the channels list within 14 reads and the ranking within 12', async () => {
    const counter = wrapDb(pool);
    const metrics = createMetricsModule({
      db: counter.db,
      referenceRepository: createReferenceRepository(counter.db),
    });
    const { rows: anchorRows } = await pool.query('SELECT max(stat_date)::text AS anchor FROM daily_stats');
    const anchor = anchorRows[0].anchor;

    counter.reset();
    await metrics.services.channelList.getChannelList({ anchor });
    const channels = counter.count();

    counter.reset();
    await metrics.services.ranking.getRankingReport({ anchor });
    const ranking = counter.count();

    expect(channels, `channels used ${channels} queries`).toBeLessThanOrEqual(14);
    expect(ranking, `ranking used ${ranking} queries`).toBeLessThanOrEqual(12);
  });
});
