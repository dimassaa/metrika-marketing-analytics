import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
import { countIslands, extractDataProps } from '../helpers/dataProps.js';

const VIEWER = 'viewer@metrika.by';

/** The dashboard frame must not depend on the build output for its HTML contract. */
const NO_ASSETS = { assets: { assets: () => ({ scripts: [], preloads: [] }) } };

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
  app = makeApp(NO_ASSETS);
});

/**
 * @returns {Promise<import('supertest').SuperAgentTest>}
 */
async function signedIn() {
  const agent = request.agent(app);
  const login = await loginAs(agent, VIEWER);
  expect(login.status).toBe(302);
  return agent;
}

describe('dashboard screen', () => {
  it('renders one island mount node with a skeleton and no server-rendered KPI text', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/dashboard');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(countIslands(res.text)).toBe(1);
    expect(res.text).toContain('data-island="dashboard"');
    expect(res.text).toContain('skeleton--chart');
    expect(res.text).toContain('<noscript>');
    // React has not run on the server, so no KPI markup may exist in the HTML.
    expect(res.text).not.toContain('kpi__value');
  });

  it('gives the page exactly the object the JSON API returns', async () => {
    const agent = await signedIn();

    const page = await agent.get('/app/dashboard?days=30');
    const api = await agent.get('/api/v1/dashboard?days=30');

    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    expect(extractDataProps(page.text)).toEqual(api.body);
  });

  it('accepts a comma-separated filter and a repeated filter as the same screen', async () => {
    const { rows } = await pool.query('SELECT id::text AS id FROM channels ORDER BY code LIMIT 2');
    const [first, second] = rows.map((row) => row.id);

    const agent = await signedIn();
    const comma = await agent.get(`/app/dashboard?channelIds=${first},${second}`);
    const repeated = await agent.get(`/app/dashboard?channelIds=${first}&channelIds=${second}`);

    expect(comma.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(extractDataProps(comma.text)).toEqual(extractDataProps(repeated.text));
  });

  it('narrows the KPI and the weekly series to the selected channels', async () => {
    const { rows } = await pool.query('SELECT id::text AS id FROM channels ORDER BY code LIMIT 2');
    const ids = rows.map((row) => row.id);

    const agent = await signedIn();
    const all = await agent.get('/app/dashboard?days=30');
    const filtered = await agent.get(
      `/app/dashboard?days=30&channelIds=${ids.join(',')}`,
    );

    const allProps = extractDataProps(all.text);
    const filteredProps = extractDataProps(filtered.text);

    expect(filteredProps.filter.active).toBe(true);
    expect(filteredProps.channels).toHaveLength(2);
    expect(filteredProps.channelOptions.length).toBeGreaterThan(2);
    expect(BigInt(filteredProps.kpis.spendCents)).toBeLessThan(BigInt(allProps.kpis.spendCents));

    const rowSpend = filteredProps.channels.reduce((sum, row) => sum + BigInt(row.spendCents), 0n);
    expect(BigInt(filteredProps.kpis.spendCents)).toBe(rowSpend);
  });

  it('serves a 180-day window when days=180 is requested', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/dashboard?days=180');

    expect(res.status).toBe(200);
    const props = extractDataProps(res.text);
    expect(props.period.days).toBe(180);
    expect(props.period.label).toBe('180 дней');
  });

  it('rejects an invalid filter with 400 instead of rendering a wider report', async () => {
    const agent = await signedIn();

    const bad = await agent.get('/app/dashboard?channelIds=abc');
    const empty = await agent.get('/app/dashboard?channelIds=');

    expect(bad.status).toBe(400);
    expect(empty.status).toBe(400);
  });
});

describe('dashboard on an empty stand', () => {
  beforeAll(async () => {
    await resetTestDatabase();
    await seed();
    await getTestPool().query('TRUNCATE daily_stats, touchpoints, orders, customers RESTART IDENTITY CASCADE');
  });

  it('shows measured zeros for spend and customers, and honest dashes for CAC and ROMI', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/dashboard');

    expect(res.status).toBe(200);
    const props = extractDataProps(res.text);

    expect(props.kpis.spendLabel).toBe('0,00');
    expect(props.kpis.newCustomersLabel).toBe('0');
    expect(props.kpis.cacLabel).toBe('—');
    expect(props.kpis.romiLabel).toBe('—');
    expect(props.verdict.status).toBe('no_data');
    expect(props.charts.cac.hasData).toBe(false);
    expect(props.charts.romi.hasData).toBe(false);
    expect(props.charts.spendRevenue.hasData).toBe(false);
    expect(res.text).not.toContain('NaN');
  });
});
