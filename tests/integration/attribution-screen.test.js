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
/** Fixed seed anchor, the same one the M3 attribution suite uses. */
const ANCHOR = '2026-11-21';

/** The attribution frame must not depend on the build output for its HTML contract. */
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

describe('attribution screen', () => {
  it('renders one island mount node for a viewer and leaves the comparison to React', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/attribution');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(countIslands(res.text, 'attribution')).toBe(1);
    expect(res.text).toContain('data-island="attribution"');
    expect(res.text).toContain('skeleton--chart');
    expect(res.text).toContain('<noscript>');
    // No chart or comparison markup may exist in the server frame.
    expect(res.text).not.toContain('chart__plot');
    expect(res.text).not.toContain('table--attribution');
  });

  it('gives the page exactly the object /api/v1/attribution returns for every model and period', async () => {
    const agent = await signedIn();

    for (const query of ['', '?model=first_touch', '?model=linear', '?days=90', '?days=180&model=linear']) {
      const page = await agent.get(`/app/attribution${query}`);
      const api = await agent.get(`/api/v1/attribution${query}`);

      expect(page.status, query).toBe(200);
      expect(api.status, query).toBe(200);
      expect(extractDataProps(page.text, 'attribution'), query).toEqual(api.body);
    }
  });

  it('keeps all three models visible and marks exactly the selected one', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/attribution?model=linear');
    const props = extractDataProps(res.text, 'attribution');

    expect(props.page).toBe('attribution');
    expect(props.model).toBe('linear');
    expect(props.models.map((entry) => entry.key)).toEqual(['last_touch', 'first_touch', 'linear']);
    expect(props.models.filter((entry) => entry.selected).map((entry) => entry.key)).toEqual(['linear']);
    expect(props.charts.revenue.series.length).toBeGreaterThan(0);
    expect(props.charts.revenue.series[0]).toHaveProperty('last_touch');
    expect(props.charts.revenue.series[0]).toHaveProperty('first_touch');
    expect(props.charts.revenue.series[0]).toHaveProperty('linear');
  });

  it('changes the summary with ?model= but not the underlying numbers', async () => {
    const agent = await signedIn();

    const last = extractDataProps((await agent.get('/app/attribution')).text, 'attribution');
    const first = extractDataProps((await agent.get('/app/attribution?model=first_touch')).text, 'attribution');

    expect(last.model).toBe('last_touch');
    expect(first.model).toBe('first_touch');
    expect(first.summary.key).toBe('first_touch');
    expect(first.summary.totalAttributedCents).toBe(
      first.models.find((entry) => entry.key === 'first_touch').totalAttributedCents,
    );
    // Selecting a model changes the highlight and the summary, not the comparison.
    expect(first.comparison).toEqual(last.comparison);
    expect(first.charts.revenue.series).toEqual(last.charts.revenue.series);
    expect(first.models.map((entry) => entry.totalAttributedCents)).toEqual(
      last.models.map((entry) => entry.totalAttributedCents),
    );
  });

  it('keeps every model channel column summing to that model total', async () => {
    const agent = await signedIn();

    const props = extractDataProps((await agent.get('/app/attribution')).text, 'attribution');
    const columns = { last_touch: 'lastTouchCents', first_touch: 'firstTouchCents', linear: 'linearCents' };

    for (const entry of props.models) {
      const sum = props.comparison.reduce((total, row) => total + BigInt(row[columns[entry.key]]), 0n);
      expect(sum, entry.key).toBe(BigInt(entry.totalAttributedCents));
    }
  });

  it('names the delta base and computes the delta from the service kopecks', async () => {
    const agent = await signedIn();

    const props = extractDataProps((await agent.get('/app/attribution')).text, 'attribution');
    expect(props.table.deltaModel).toBe('linear');
    expect(props.table.columns.find((column) => column.key === 'delta').label).toContain('линейная');
    expect(props.table.columns.find((column) => column.key === 'delta').label).toContain('последнее');

    for (const row of props.table.rows) {
      expect(row.deltaCents).toBe(String(BigInt(row.linearCents) - BigInt(row.lastTouchCents)));
      const source = props.comparison.find((entry) => entry.channelId === row.channelId);
      expect(row.deltaCents).toBe(source.deltaLinearVsLastCents);
    }
  });

  it('marks the active model link and keeps days in every model link', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/attribution?days=90&model=linear');
    const props = extractDataProps(res.text, 'attribution');

    expect(props.selector.options.find((option) => option.selected).value).toBe('linear');
    for (const option of props.selector.options) {
      expect(option.href).toContain('days=90');
    }
    expect(props.selector.options.filter((option) => option.ariaCurrent === 'page')).toHaveLength(1);
  });

  it('rejects an unknown or empty model with 400 instead of a silent default', async () => {
    const agent = await signedIn();

    for (const query of ['model=bogus', 'model=', 'model=time_decay']) {
      const res = await agent.get(`/app/attribution?${query}`);
      expect(res.status, query).toBe(400);
    }
  });

  it('keeps the attribution report within the four-query budget', async () => {
    const counter = wrapDb(pool);
    const metrics = createMetricsModule({
      db: counter.db,
      referenceRepository: createReferenceRepository(counter.db),
    });

    counter.reset();
    const report = await metrics.services.attribution.getAttributionReport({
      from: '2026-10-23',
      to: ANCHOR,
    });
    const queries = counter.count();

    expect(report.models.linear).toBeDefined();
    expect(queries, `attribution used ${queries} queries`).toBeLessThanOrEqual(4);
  });
});

describe('attribution screen on an empty stand', () => {
  beforeAll(async () => {
    await resetTestDatabase();
    await seed({ anchorDate: ANCHOR });
    await getTestPool().query('TRUNCATE daily_stats, touchpoints, orders, customers RESTART IDENTITY CASCADE');
  });

  it('renders measured zeros, a null model ROMI and no unattributed note', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/attribution');

    expect(res.status).toBe(200);
    const props = extractDataProps(res.text, 'attribution');

    expect(props.models).toHaveLength(3);
    for (const entry of props.models) {
      expect(entry.totalAttributedCents).toBe('0');
      expect(entry.totalAttributedLabel).toBe('0,00');
      expect(entry.totalSpendCents).toBe('0');
      expect(entry.romiPct).toBeNull();
      expect(entry.romiLabel).toBe('—');
    }
    expect(props.comparison.every((row) => row.lastTouchCents === '0')).toBe(true);
    expect(props.summary.totalAttributedCents).toBe('0');
    expect(props.unattributedNote).toBeNull();
    expect(props.charts.revenue.hasData).toBe(false);
    expect(JSON.stringify(props)).not.toMatch(/NaN|Infinity/);
  });
});
