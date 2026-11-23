import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
import { countIslands, extractDataProps } from '../helpers/dataProps.js';

const VIEWER = 'viewer@metrika.by';

/** The channel frame must not depend on the build output for its HTML contract. */
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

async function signedIn() {
  const agent = request.agent(app);
  const login = await loginAs(agent, VIEWER);
  expect(login.status).toBe(302);
  return agent;
}

describe('channels screen', () => {
  it('renders one island mount node and leaves the table to React', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/channels');

    expect(res.status).toBe(200);
    expect(countIslands(res.text, 'channels')).toBe(1);
    expect(res.text).toContain('data-island="channels"');
    expect(res.text).toContain('skeleton--chart');
    expect(res.text).toContain('<noscript>');
    // The server renders no table rows any more: all numbers come from `data-props`.
    expect(res.text).not.toContain('<tbody');
    expect(res.text).not.toContain('kpi__value');
  });

  it('renders the days select on the default URL, with 30 days selected', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/channels');

    expect(res.status).toBe(200);
    expect(res.text).toContain('app-topbar__period');
    expect(res.text).toContain('name="days"');
    expect(res.text).toContain('<option value="30" selected>');
    expect(res.text).not.toContain('app-topbar__range');
  });

  it('puts eight health rows in data-props, including no_data rows with null rank', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/channels');

    expect(res.status).toBe(200);
    const props = extractDataProps(res.text, 'channels');
    expect(props.rows).toHaveLength(8);
    expect(props.rows.filter((row) => row.rank !== null)).toHaveLength(6);
    expect(props.rows.filter((row) => row.rank === null).map((row) => row.status)).toEqual([
      'no_data',
      'no_data',
    ]);
    expect(props.excluded.at(-1)).toMatchObject({ code: 'blended', reason: 'blended' });
    expect(props.rows.every((row) => 'kind' in row && 'isActive' in row)).toBe(true);
    expect(props.blended.code).toBe('blended');
    expect(props.chart.romi.series.length).toBeGreaterThan(0);
  });

  it('builds a twelve-point sparkline for every table row', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/channels');
    const props = extractDataProps(res.text, 'channels');

    for (const row of props.rows) {
      const points = props.sparklines[row.channelId];
      expect(points, row.code).toHaveLength(12);
      expect(points.every((point) => typeof point.weekLabel === 'string')).toBe(true);
    }
    expect(
      Object.values(props.sparklines).some((points) => points.some((point) => typeof point.value === 'number')),
    ).toBe(true);
  });

  it('gives the page exactly the object the JSON API returns, weights and sort included', async () => {
    const agent = await signedIn();
    const query =
      'days=90&status=active&kind=paid&sort=cac&dir=asc&wCac=10&wRomi=40&wLtvCac=30&wNewCustomers=20';

    const page = await agent.get(`/app/channels?${query}`);
    const api = await agent.get(`/api/v1/channels?${query}`);

    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    expect(extractDataProps(page.text, 'channels')).toEqual(api.body);
  });

  it('keeps filters, period and weights in sort links and marks the active column', async () => {
    const agent = await signedIn();

    const res = await agent.get(
      '/app/channels?days=90&status=active&kind=paid&sort=cac&dir=asc&wCac=10&wRomi=40&wLtvCac=30&wNewCustomers=20',
    );
    const props = extractDataProps(res.text, 'channels');
    const active = props.sortLinks.find((link) => link.field === 'cac');
    const revenue = props.sortLinks.find((link) => link.field === 'revenue');

    expect(active).toMatchObject({ active: true, ariaSort: 'ascending' });
    expect(active.href).toContain('days=90');
    expect(active.href).toContain('status=active');
    expect(active.href).toContain('kind=paid');
    expect(active.href).toContain('wCac=10');
    expect(active.href).toContain('sort=cac');
    expect(revenue.ariaSort).toBe('none');
    for (const link of props.sortLinks) {
      expect(link.href).toContain('days=90');
      expect(link.href).toContain('wCac=10');
    }
  });

  it('replays decimal weights on the forms and in sort links, and the API agrees', async () => {
    const agent = await signedIn();
    const query = 'wCac=33.3&wRomi=33.3&wLtvCac=33.3&wNewCustomers=0.1';

    const page = await agent.get(`/app/channels?${query}`);
    const api = await agent.get(`/api/v1/channels?${query}`);

    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    expect(extractDataProps(page.text, 'channels')).toEqual(api.body);
    for (const link of extractDataProps(page.text, 'channels').sortLinks) {
      expect(link.href).toContain('wCac=33.3');
      expect(link.href).toContain('wNewCustomers=0.1');
    }
    expect(page.text).toContain('name="wCac"');
    expect(page.text).toContain('value="33.3"');
    expect(page.text).toContain('value="0.1"');
  });

  it('labels an explicit from/to range instead of showing the default 30 days', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/channels?from=2026-10-01&to=2026-10-31');

    expect(res.status).toBe(200);
    expect(res.text).toContain('01.10.2026 — 31.10.2026');
    expect(res.text).toContain('app-topbar__range');
    expect(res.text).not.toContain('app-topbar__period');
    expect(extractDataProps(res.text, 'channels').period).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
      days: 31,
    });
  });

  it('sorts revenue by kopeck value and keeps null ranks after measured rows', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/channels?sort=revenue&dir=asc');
    const props = extractDataProps(res.text, 'channels');
    const revenues = props.rows.map((row) => BigInt(row.revenueCents));

    for (let index = 1; index < revenues.length; index += 1) {
      expect(revenues[index] >= revenues[index - 1]).toBe(true);
    }
  });

  it('narrows rows by kind after ranking without changing the earned rank', async () => {
    const agent = await signedIn();
    const all = extractDataProps((await agent.get('/app/channels')).text, 'channels');
    const owned = extractDataProps((await agent.get('/app/channels?kind=owned')).text, 'channels');

    const instagramRank = all.rows.find((row) => row.code === 'instagram').rank;
    expect(owned.rows.map((row) => row.code)).toEqual(['email']);
    // The owned filter hides paid rows only; the visible email row keeps the exclusion it had in the full ranking.
    expect(all.rows.find((row) => row.code === 'instagram').rank).toBe(instagramRank);
    expect(owned.rows[0].rank).toBeNull();
  });

  it('shows every row for a stale status bookmark on the page, while the API rejects it', async () => {
    const agent = await signedIn();

    const page = await agent.get('/app/channels?status=bogus');
    const api = await agent.get('/api/v1/channels?status=bogus');

    expect(page.status).toBe(200);
    expect(extractDataProps(page.text, 'channels').filters.status).toBe('all');
    expect(extractDataProps(page.text, 'channels').rows).toHaveLength(8);
    expect(api.status).toBe(400);
    expect(api.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('renders the weight form for a viewer and keeps the M2 create form away from them', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/channels');

    expect(res.status).toBe(200);
    expect(res.text).toContain('name="wCac"');
    expect(res.text).toContain('name="wRomi"');
    expect(res.text).toContain('name="wLtvCac"');
    expect(res.text).toContain('name="wNewCustomers"');
    expect(res.text).toContain('action="/app/export/channels.csv"');
    expect(res.text).not.toContain('name="code"');
  });

  it('reorders the ranking when the request favours ROMI only', async () => {
    const agent = await signedIn();
    const byDefault = extractDataProps((await agent.get('/app/channels')).text, 'channels');
    const byRomi = extractDataProps(
      (await agent.get('/app/channels?wCac=0&wRomi=100&wLtvCac=0&wNewCustomers=0')).text,
      'channels',
    );

    expect(byRomi.weights).toEqual({ cac: 0, romi: 1, ltvCac: 0, newCustomers: 0 });
    expect(byRomi.rows.filter((row) => row.rank !== null).map((row) => row.code)).not.toEqual(
      byDefault.rows.filter((row) => row.rank !== null).map((row) => row.code),
    );
  });
});
