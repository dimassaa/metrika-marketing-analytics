import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { createReferenceRepository } from '../../src/repositories/reference.repo.js';
import { createMetricsModule } from '../../src/services/metrics/index.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
import { countIslands, extractDataProps } from '../helpers/dataProps.js';
import { wrapDb } from '../helpers/queryCounter.js';

const VIEWER = 'viewer@metrika.by';
/** Fixed seed anchor, the same one the M3 cohort suite uses, so the matrix is deterministic. */
const ANCHOR = '2026-11-21';

/** The cohorts frame must not depend on the build output for its HTML contract. */
const NO_ASSETS = { assets: { assets: () => ({ scripts: [], preloads: [] }) } };

/** @type {import('pg').Pool} */
let pool;
/** @type {import('express').Express} */
let app;

beforeAll(async () => {
  await resetTestDatabase();
  await seed({ anchorDate: ANCHOR });
  pool = getTestPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await pool.query('DELETE FROM sessions');
  app = makeApp(NO_ASSETS);
});

async function signedIn() {
  const agent = request.agent(app);
  const login = await loginAs(agent, VIEWER);
  expect(login.status).toBe(302);
  return agent;
}

/**
 * @returns {Promise<string>} A channel id that actually has customers, so the filter narrows something.
 */
async function channelWithCustomers() {
  const { rows } = await pool.query(
    `SELECT c.id::text AS id
       FROM channels c
      WHERE EXISTS (SELECT 1 FROM customers cu WHERE cu.first_channel_id = c.id)
      ORDER BY c.code
      LIMIT 1`,
  );
  return rows[0].id;
}

describe('cohorts screen', () => {
  it('renders one island mount node for a viewer and leaves the matrix to React', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/cohorts');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(countIslands(res.text, 'cohorts')).toBe(1);
    expect(res.text).toContain('data-island="cohorts"');
    expect(res.text).toContain('skeleton--chart');
    expect(res.text).toContain('<noscript>');
    // No matrix or chart markup may exist in the server frame.
    expect(res.text).not.toContain('matrix__cell');
    expect(res.text).not.toContain('chart__plot');
  });

  it('gives the page exactly the object /api/v1/cohorts returns for every horizon', async () => {
    const agent = await signedIn();
    const id = await channelWithCustomers();

    for (const query of ['', '?horizon=3', '?horizon=6', '?horizon=12', `?horizon=6&channelId=${id}`]) {
      const page = await agent.get(`/app/cohorts${query}`);
      const api = await agent.get(`/api/v1/cohorts${query}`);

      expect(page.status, query).toBe(200);
      expect(api.status, query).toBe(200);
      expect(extractDataProps(page.text, 'cohorts'), query).toEqual(api.body);
    }
  });

  it('marks partial cohorts, keeps a future cell null and lists the excluded cohorts', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/cohorts');
    const props = extractDataProps(res.text, 'cohorts');

    expect(props.horizonMonths).toBe(12);
    expect(props.anchor).toBe(ANCHOR);
    expect(props.hasData).toBe(true);
    expect(props.cohorts).toHaveLength(14);

    const partial = props.cohorts.filter((cohort) => cohort.isPartial);
    expect(partial.length).toBeGreaterThan(0);
    expect(props.excludedIncomplete.map((cohort) => cohort.cohortMonth)).toEqual(
      partial.map((cohort) => cohort.cohortMonth),
    );

    const newest = props.cohorts.at(-1);
    expect(newest.isPartial).toBe(true);
    expect(newest.monthsObserved).toBe(1);
    expect(newest.cells[1]).toMatchObject({
      monthOffset: 1,
      retentionPct: null,
      retentionLabel: '—',
      heatClass: 'is-empty',
    });
    // The anchor month is the cohort month: its first cell is a real 100%, not an empty one.
    expect(newest.cells[0]).toMatchObject({ retentionPct: 100, heatClass: 'heat-4' });

    expect(props.table.columns).toHaveLength(15);
    expect(props.table.rows).toHaveLength(14);
    expect(props.table.rows.find((row) => row.isPartial)).toBeDefined();
  });

  it('changes the number of columns, props and curve points with the horizon', async () => {
    const agent = await signedIn();
    const screens = {};

    for (const horizon of [3, 6, 12]) {
      const res = await agent.get(`/app/cohorts?horizon=${horizon}`);
      expect(res.status).toBe(200);
      const props = extractDataProps(res.text, 'cohorts');

      expect(props.horizonMonths, String(horizon)).toBe(horizon);
      expect(props.cohorts[0].cells).toHaveLength(horizon);
      expect(props.table.columns).toHaveLength(horizon + 3);
      expect(props.charts.ltv.series).toHaveLength(horizon);
      expect(props.charts.ltv.table.rows).toHaveLength(horizon);
      screens[horizon] = props;
    }

    expect(screens[3].table.columns.length).toBeLessThan(screens[12].table.columns.length);
    expect(screens[3].charts.ltv.series).not.toEqual(screens[12].charts.ltv.series);
  });

  it('does not render the daily period select on the cohorts topbar', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/cohorts');

    expect(res.status).toBe(200);
    expect(res.text).toContain('app-topbar__anchor');
    expect(res.text).toContain('Данные по');
    expect(res.text).not.toContain('name="days"');
    expect(res.text).not.toContain('app-topbar__period');
  });

  it('rejects an unsupported horizon on the page with 400, not a silently different matrix', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/cohorts?horizon=7');

    expect(res.status).toBe(400);
    expect(res.text).not.toContain('data-island="cohorts"');
  });

  it('marks the active horizon with aria-current and preserves channelId and days in the links', async () => {
    const agent = await signedIn();
    const id = await channelWithCustomers();

    const res = await agent.get(`/app/cohorts?horizon=6&channelId=${id}&days=90`);

    expect(res.status).toBe(200);
    const nav = res.text.match(/<nav class="segmented"[\s\S]*?<\/nav>/)?.[0];
    expect(nav).toBeDefined();
    expect((nav.match(/aria-current="page"/g) ?? []).length).toBe(1);
    expect(nav).toContain('horizon=6');
    expect(nav).toContain(`channelId=${id}`);
    expect(nav).toContain('days=90');
    // The active link is 6 months; 3 and 12 are plain links.
    expect(nav).toMatch(/<a class="segmented__item is-active" href="[^"]*horizon=6[^"]*" aria-current="page">6 месяцев<\/a>/);
    expect(nav).toContain('>3 месяца</a>');
    expect(nav).toContain('>12 месяцев</a>');
  });

  it('narrows the matrix to one channel when channelId is supplied', async () => {
    const agent = await signedIn();
    const id = await channelWithCustomers();

    const all = extractDataProps((await agent.get('/app/cohorts')).text, 'cohorts');
    const filtered = extractDataProps((await agent.get(`/app/cohorts?channelId=${id}`)).text, 'cohorts');

    const sumOf = (props) => props.cohorts.reduce((total, cohort) => total + cohort.cohortSize, 0);
    expect(sumOf(filtered)).toBeGreaterThan(0);
    expect(sumOf(filtered)).toBeLessThan(sumOf(all));
    expect(filtered.channelLtv).toHaveLength(1);
    expect(filtered.channelLtv[0].channelId).toBe(id);
    expect(filtered.channelFilter).toMatchObject({ id });
    expect(filtered.channelFilter.label).toMatch(/^Показан канал /);
    expect(all.channelFilter).toBeNull();
    expect(all.channelLtv.length).toBeGreaterThan(1);
  });

  it('keeps the cohort report within the five-query budget', async () => {
    const counter = wrapDb(pool);
    const metrics = createMetricsModule({
      db: counter.db,
      referenceRepository: createReferenceRepository(counter.db),
    });

    counter.reset();
    const matrix = await metrics.services.ltv.getCohortMatrix({ anchor: ANCHOR, horizonMonths: 12 });
    const queries = counter.count();

    expect(matrix.cohorts.length).toBeGreaterThan(0);
    // BEGIN + sizes + margins + channel dimension + COMMIT.
    expect(queries, `cohort matrix used ${queries} queries`).toBeLessThanOrEqual(5);
  });
});

describe('cohorts screen on an empty stand', () => {
  beforeAll(async () => {
    await resetTestDatabase();
    await seed({ anchorDate: ANCHOR });
    await getTestPool().query('TRUNCATE daily_stats, touchpoints, orders, customers RESTART IDENTITY CASCADE');
  });

  it('renders an honest empty state with no NaN and no created cohorts', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/cohorts');

    expect(res.status).toBe(200);
    const props = extractDataProps(res.text, 'cohorts');

    expect(props.hasData).toBe(false);
    expect(props.cohorts).toEqual([]);
    expect(props.excludedIncomplete).toEqual([]);
    expect(props.table.rows).toEqual([]);
    expect(props.charts.ltv.hasData).toBe(false);
    expect(props.charts.ltv.caption).toContain('0 когорт');
    expect(JSON.stringify(props)).not.toMatch(/NaN|Infinity/);
    // The frame still offers the horizon switch even when there are no cohorts.
    expect(res.text).toContain('>3 месяца</a>');
  });
});
