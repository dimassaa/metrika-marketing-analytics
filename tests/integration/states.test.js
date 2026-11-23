import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
import { countIslands, extractDataProps } from '../helpers/dataProps.js';

/**
 * Cross-screen contract for the five analytics screens: one mount node, a skeleton, a `<noscript>` fallback, a
 * JSON-safe model and a skip link into `<main>`.
 *
 * The database is seeded only for identities and the channel dimension, then every measured table is truncated. That
 * is the state a fresh stand is in before the first import, and it is the only state where an empty chart is the
 * truthful answer. It also keeps the test independent of the seed's own numbers.
 *
 * One exception is asserted explicitly rather than hidden: spend and revenue series are *measured zeros*, not
 * missing data, so `hasData` stays true for those charts (see `buildSpendRevenueChart`). The empty state there would
 * claim nothing was measured, which is false.
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
  // Keep users, channels and campaigns: identity, the channel dimension and the passport route need them. Every
  // table that holds a measurement loses its rows.
  await pool.query('TRUNCATE daily_stats, touchpoints, orders, customers RESTART IDENTITY CASCADE');
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
 * @param {unknown} value
 * @returns {boolean} True when a `bigint` sits anywhere in the value.
 */
function hasBigInt(value) {
  if (typeof value === 'bigint') return true;
  if (Array.isArray(value)) return value.some(hasBigInt);
  if (value !== null && typeof value === 'object') return Object.values(value).some(hasBigInt);
  return false;
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
  it.each(PAGES)('$path renders one island, a skeleton, a noscript fallback and a skip link', async (page) => {
    const agent = await signedIn();

    const res = await agent.get(page.path);

    expect(res.status).toBe(200);
    expect(countIslands(res.text, page.island)).toBe(1);
    expect(res.text).toContain('skeleton--chart');
    expect(res.text).toContain('<noscript>');
    expect(res.text).toContain('<a class="skip-link" href="#main">Перейти к содержанию</a>');
    expect(res.text).toContain('<main id="main" class="app-content" tabindex="-1">');
    expect(res.text).toMatch(/<h1 class="app-topbar__title">[^<]+<\/h1>/);
  });

  it.each(PAGES)('$path exposes a JSON-safe data-props model', async (page) => {
    const agent = await signedIn();

    const res = await agent.get(page.path);
    const props = extractDataProps(res.text, page.island);

    expect(props).toBeTypeOf('object');
    expect(hasBigInt(props)).toBe(false);
    // The browser must be able to parse exactly what the server wrote; a non-serialisable value would throw here.
    expect(() => JSON.stringify(props)).not.toThrow();
    expect(res.text).not.toContain('NaN');
    expect(res.text).not.toContain('Infinity');
  });

  it('dashboard shows the no_data verdict and honest empty charts on an empty stand', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/dashboard');
    const props = extractDataProps(res.text, 'dashboard');

    expect(props.verdict.status).toBe('no_data');
    expect(props.charts.cac.hasData).toBe(false);
    expect(props.charts.romi.hasData).toBe(false);
    expect(props.charts.cacLtv.hasData).toBe(false);
    // Measured zeros, not missing weeks: the weekly series exists and every value is zero.
    expect(props.charts.spendRevenue.hasData).toBe(true);
    expect(props.charts.spendRevenue.series.every((row) => row.spend === 0 && row.revenue === 0)).toBe(true);
    expect(props.charts.channelSpend.hasData).toBe(true);
    expect(props.charts.channelSpend.series.every((row) => row.spend === 0)).toBe(true);
  });

  it('channels shows no measured ROMI and no ranked rows, while keeping the channel dimension', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/channels');
    const props = extractDataProps(res.text, 'channels');

    expect(props.chart.romi.hasData).toBe(false);
    expect(props.rows.every((row) => row.status === 'no_data')).toBe(true);
    expect(props.rows.length).toBeGreaterThan(0);
  });

  it('passport shows empty CAC and ROMI charts for a channel without measurements', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/channels/1');
    const props = extractDataProps(res.text, 'channel');

    expect(props.charts.cac.hasData).toBe(false);
    expect(props.charts.romi.hasData).toBe(false);
    expect(props.charts.spendRevenue.hasData).toBe(true);
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

  it('keeps a boolean hasData on every chart of every screen', async () => {
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
