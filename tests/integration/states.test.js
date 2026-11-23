import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
import { countIslands, extractDataProps } from '../helpers/dataProps.js';

/**
 * Cross-screen contract for the five analytics screens: one mount node, a busy skeleton, a `<noscript>` fallback, a
 * JSON-safe model, a skip link into `<main>`, and the same empty-state rule on every chart.
 *
 * The file runs twice against one database. First the seeded stand proves that charts with activity are not empty.
 * Then the measured tables are truncated and every data-driven chart must say `hasData: false`; only the KPI totals
 * keep their measured zeros, because a total of zero is a fact while a flat zero line is indistinguishable from "we
 * have no data". That ruling is the product decision from the review, not an accident of the seed.
 *
 * The empty-state action itself is client-rendered and covered by `tests/unit/shared-ui.test.js` (render + open
 * behaviour) and the browser pass; SSR cannot contain it by definition.
 */
const VIEWER = 'viewer@metrika.by';
const NO_ASSETS = { assets: { assets: () => ({ scripts: [], preloads: [] }) } };

const PAGES = [
  { path: '/app/dashboard', island: 'dashboard' },
  { path: '/app/channels', island: 'channels' },
  // The passport title is the channel name from the seed, so the assertion checks that a title rendered, not its text.
  { path: '/app/channels/1', island: 'channel' },
  { path: '/app/cohorts', island: 'cohorts' },
  { path: '/app/attribution', island: 'attribution' },
];

/** @type {import('pg').Pool} */
let pool;
/** @type {import('express').Express} */
let app;

beforeAll(async () => {
  await resetTestDatabase();
  await seed();
  pool = getTestPool();
  app = makeApp(NO_ASSETS);
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
  const login = await loginAs(agent, VIEWER);
  expect(login.status).toBe(302);
  return agent;
}

/**
 * @param {object} charts Screen model chart map.
 * @returns {object[]} Every chart object that carries a `hasData` flag.
 */
function chartList(charts) {
  return Object.values(charts ?? {}).filter(
    (chart) => chart && typeof chart === 'object' && 'hasData' in chart,
  );
}

describe('shared screen states', () => {
  it.each(PAGES)('$path renders one island, a busy skeleton, a noscript fallback and a skip link', async (page) => {
    const agent = await signedIn();

    const res = await agent.get(page.path);

    expect(res.status).toBe(200);
    expect(countIslands(res.text, page.island)).toBe(1);
    expect(res.text).toContain('skeleton--chart');
    expect(res.text).toContain('aria-busy="true"');
    expect(res.text).toContain('Загрузка данных');
    expect(res.text).toContain('<noscript>');
    expect(res.text).toContain('<a class="skip-link" href="#main">Перейти к содержанию</a>');
    expect(res.text).toContain('<main id="main" class="app-content" tabindex="-1">');
    expect(res.text).toMatch(/<h1 class="app-topbar__title">[^<]+<\/h1>/);
  });

  it.each(PAGES)('$path exposes a model that the browser can parse as JSON', async (page) => {
    const agent = await signedIn();

    const res = await agent.get(page.path);
    const props = extractDataProps(res.text, page.island);

    // `extractDataProps` already runs JSON.parse on the attribute, which is the real guard: a bigint would have
    // thrown in `serializeDataProps` on the server and produced a 500 instead of this page.
    expect(props).toBeTypeOf('object');
    expect(Object.keys(props).length).toBeGreaterThan(0);
    expect(res.text).not.toContain('NaN');
    expect(res.text).not.toContain('Infinity');
  });

  it('keeps a boolean hasData and a duplicate table on every chart of every screen', async () => {
    const agent = await signedIn();

    for (const page of PAGES) {
      const res = await agent.get(page.path);
      const props = extractDataProps(res.text, page.island);
      const charts = chartList(props.charts ?? props.chart);

      expect(charts.length, page.path).toBeGreaterThan(0);
      for (const chart of charts) {
        expect(typeof chart.hasData, `${page.path}: ${chart.title}`).toBe('boolean');
        expect(Array.isArray(chart.table?.columns), `${page.path}: ${chart.title} table`).toBe(true);
      }
    }
  });
});

describe('charts on the seeded stand', () => {
  it('dashboard draws every chart because the seed has spend, revenue and customers', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/dashboard');
    const props = extractDataProps(res.text, 'dashboard');

    for (const [key, chart] of Object.entries(props.charts)) {
      expect(chart.hasData, `dashboard chart ${key}`).toBe(true);
    }
  });

  it('passport and attribution draw their money charts on the seeded stand', async () => {
    const agent = await signedIn();

    const passport = extractDataProps((await agent.get('/app/channels/1')).text, 'channel');
    const attribution = extractDataProps((await agent.get('/app/attribution')).text, 'attribution');

    expect(passport.charts.spendRevenue.hasData).toBe(true);
    expect(attribution.charts.revenue.hasData).toBe(true);
  });
});

describe('empty stand', () => {
  beforeAll(async () => {
    // Keep users, channels and campaigns: identity, the channel dimension and the passport route need them. Every
    // table that holds a measurement loses its rows.
    await pool.query('TRUNCATE daily_stats, touchpoints, orders, customers RESTART IDENTITY CASCADE');
  });

  it('dashboard shows the no_data verdict and an empty state on every chart', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/dashboard');
    const props = extractDataProps(res.text, 'dashboard');

    expect(props.verdict.status).toBe('no_data');
    expect(props.charts.cac.hasData).toBe(false);
    expect(props.charts.romi.hasData).toBe(false);
    expect(props.charts.cacLtv.hasData).toBe(false);
    // The product ruling: an all-zero series is "no measured activity", so it shows the empty state instead of a
    // flat zero line. The zero values stay in the duplicate table, and the KPI tiles keep their measured zeros.
    expect(props.charts.spendRevenue.hasData).toBe(false);
    expect(props.charts.spendRevenue.series.every((row) => row.spend === 0 && row.revenue === 0)).toBe(true);
    expect(props.charts.channelSpend.hasData).toBe(false);
    expect(props.charts.channelSpend.series.every((row) => row.spend === 0)).toBe(true);
    expect(props.kpis.spendLabel).toBe('0,00');
  });

  it('channels shows no measured ROMI and no ranked rows, while keeping the channel dimension', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/channels');
    const props = extractDataProps(res.text, 'channels');

    expect(props.chart.romi.hasData).toBe(false);
    expect(props.rows.every((row) => row.status === 'no_data')).toBe(true);
    expect(props.rows.length).toBeGreaterThan(0);
  });

  it('passport shows empty CAC, ROMI and spend charts for a channel without measurements', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/channels/1');
    const props = extractDataProps(res.text, 'channel');

    expect(props.charts.cac.hasData).toBe(false);
    expect(props.charts.romi.hasData).toBe(false);
    expect(props.charts.spendRevenue.hasData).toBe(false);
    expect(props.charts.spendRevenue.series.every((row) => row.spend === 0 && row.revenue === 0)).toBe(true);
    // The retention matrix has no cohorts, and the island must say so rather than paint zeroes.
    expect(props.retention.hasData).toBe(false);
  });

  it('cohorts has no matrix and no curve when there are no customers', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/cohorts');
    const props = extractDataProps(res.text, 'cohorts');

    expect(props.hasData).toBe(false);
    expect(props.table.rows).toEqual([]);
    expect(props.charts.ltv.hasData).toBe(false);
  });

  it('attribution has no attributed revenue and keeps all three models', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/attribution');
    const props = extractDataProps(res.text, 'attribution');

    expect(props.charts.revenue.hasData).toBe(false);
    expect(props.models).toHaveLength(3);
    expect(props.models.every((model) => model.totalAttributedLabel === '0,00')).toBe(true);
  });
});
