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

/**
 * Reads the hidden period fields of the dashboard channel filter, so a test submits what the form really carries
 * instead of reconstructing the expected query by hand.
 *
 * @param {string} html Rendered page.
 * @returns {Array<{ name: string, value: string }>}
 */
function filterPeriodFields(html) {
  const form = html.match(/<form class="card filters"[\s\S]*?<\/form>/)?.[0];
  if (!form) throw new Error('dashboard filter form not found');
  return [...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((match) => ({
    name: match[1],
    value: match[2],
  }));
}

/**
 * @param {Array<{ name: string, value: string }>} fields
 * @returns {string}
 */
function asQuery(fields) {
  return new URLSearchParams(fields.map((field) => [field.name, field.value])).toString();
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

  it('renders the days select on the default URL, with 30 days selected', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/dashboard');

    expect(res.status).toBe(200);
    expect(res.text).toContain('app-topbar__period');
    expect(res.text).toContain('name="days"');
    expect(res.text).toContain('<option value="30" selected>');
    expect(res.text).not.toContain('app-topbar__range');
  });

  it('gives the page exactly the object the JSON API returns', async () => {
    const agent = await signedIn();

    const page = await agent.get('/app/dashboard?days=30');
    const api = await agent.get('/api/v1/dashboard?days=30');

    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    expect(extractDataProps(page.text)).toEqual(api.body);
  });

  it('renders the channel filter form, keeps selected values and the period', async () => {
    const { rows } = await pool.query('SELECT id::text AS id FROM channels ORDER BY code LIMIT 2');
    const ids = rows.map((row) => row.id);

    const agent = await signedIn();
    const res = await agent.get(`/app/dashboard?days=90&channelIds=${ids.join(',')}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('name="channelIds"');
    expect(res.text).toContain('multiple');
    expect(res.text).toContain('aria-describedby="dashboard-channels-hint"');
    expect(res.text).toContain('id="dashboard-channels-hint"');
    expect(filterPeriodFields(res.text)).toEqual([{ name: 'days', value: '90' }]);
    for (const id of ids) {
      // A filtered page must reopen with the same channels ticked, not with an empty multi-select.
      expect(res.text).toContain(`<option value="${id}" selected>`);
    }
    expect(res.text).toContain('Сбросить');
    expect(res.text).toContain('href="/app/dashboard?days=90"');

    // The generated form fields must be accepted as-is, not just look plausible.
    const submitted = await agent.get(`/app/dashboard?${asQuery(filterPeriodFields(res.text))}`);
    expect(submitted.status).toBe(200);
    expect(extractDataProps(submitted.text).period.days).toBe(90);
  });

  it('keeps the page and the API identical under a channel filter', async () => {
    const { rows } = await pool.query('SELECT id::text AS id FROM channels ORDER BY code LIMIT 2');
    const ids = rows.map((row) => row.id);

    const agent = await signedIn();
    const page = await agent.get(`/app/dashboard?days=30&channelIds=${ids.join(',')}`);
    const api = await agent.get(`/api/v1/dashboard?days=30&channelIds=${ids.join(',')}`);

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

  it('recomputes CAC from the selected channel spend and customers', async () => {
    const { rows } = await pool.query(
      `SELECT id::text AS id FROM channels
        WHERE id IN (SELECT DISTINCT first_channel_id FROM customers WHERE first_channel_id IS NOT NULL)
        ORDER BY code LIMIT 1`,
    );
    const id = rows[0].id;

    const agent = await signedIn();
    const res = await agent.get(`/app/dashboard?days=30&channelIds=${id}`);

    expect(res.status).toBe(200);
    const props = extractDataProps(res.text);
    const row = props.channels[0];

    expect(props.channels).toHaveLength(1);
    expect(props.kpis.spendCents).toBe(row.spendCents);
    expect(props.kpis.newCustomers).toBe(row.newCustomers);
    expect(props.kpis.cacCents).toBe(row.cacCents);
    // CAC is the quotient of the summed spend and customers, not an independently rounded average.
    const customers = BigInt(row.newCustomers);
    const expectedCac = (BigInt(row.spendCents) * 2n + customers) / (2n * customers);
    expect(BigInt(props.kpis.cacCents)).toBe(expectedCac);
    expect(props.charts.channelSpend.series).toHaveLength(1);
    expect(props.charts.cacLtv.table.rows).toHaveLength(1);
  });

  it('serves a 180-day window when days=180 is requested', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/dashboard?days=180');

    expect(res.status).toBe(200);
    const props = extractDataProps(res.text);
    expect(props.period.days).toBe(180);
    expect(props.period.label).toBe('180 дней');
  });

  it('replays an explicit from/to range and accepts the generated form submit', async () => {
    const { rows } = await pool.query('SELECT id::text AS id FROM channels ORDER BY code LIMIT 1');
    const id = rows[0].id;
    const agent = await signedIn();

    const res = await agent.get(
      `/app/dashboard?from=2026-10-01&to=2026-10-31&channelIds=${id}`,
    );

    expect(res.status).toBe(200);
    // The topbar must not pretend this range is the default 30 days.
    expect(res.text).toContain('app-topbar__range');
    expect(res.text).not.toContain('app-topbar__period');
    // The resolved length (31) is not an allowed `days` value; replaying from/to is the only 200-safe form.
    expect(filterPeriodFields(res.text)).toEqual([
      { name: 'from', value: '2026-10-01' },
      { name: 'to', value: '2026-10-31' },
    ]);
    expect(res.text).toContain('href="/app/dashboard?from=2026-10-01&amp;to=2026-10-31"');

    // Submit exactly what the form carries (its select still contributes the same channel).
    const submitted = await agent.get(
      `/app/dashboard?${asQuery(filterPeriodFields(res.text))}&channelIds=${id}`,
    );
    expect(submitted.status).toBe(200);
    expect(extractDataProps(submitted.text).period).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
    });
  });

  it('rejects an invalid filter with 400 instead of rendering a wider report', async () => {
    const agent = await signedIn();

    const bad = await agent.get('/app/dashboard?channelIds=abc');
    const empty = await agent.get('/app/dashboard?channelIds=');

    expect(bad.status).toBe(400);
    expect(empty.status).toBe(400);
  });

  it('shows Reset for a filter id that is not in the channel dimension', async () => {
    const agent = await signedIn();

    const res = await agent.get('/app/dashboard?days=30&channelIds=999999');

    expect(res.status).toBe(200);
    const props = extractDataProps(res.text);
    expect(props.filter.active).toBe(true);
    expect(props.verdict.status).toBe('no_data');
    expect(res.text).toContain('Сбросить');
    expect(res.text).toContain('Выбрано 1 из 8.');
    // No option can be ticked, but the control still agrees with the verdict and offers the way back.
    const filterForm = res.text.match(/<form class="card filters"[\s\S]*?<\/form>/)?.[0];
    expect(filterForm).not.toMatch(/<option value="[^"]+" selected>/);
  });

  it('rejects days together with from or to at the window boundary', async () => {
    const agent = await signedIn();

    const from = await agent.get('/app/dashboard?days=180&from=2026-10-01');
    const to = await agent.get('/app/dashboard?days=30&to=2026-11-21');

    expect(from.status).toBe(400);
    expect(to.status).toBe(400);
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
    // Product ruling: an all-zero spend/revenue series is "no measured activity" and shows the empty state. The
    // twelve requested weeks with their zeros stay in the duplicate table; the KPI spend tile still reads 0,00.
    expect(props.charts.spendRevenue.hasData).toBe(false);
    expect(props.charts.spendRevenue.series).toHaveLength(12);
    expect(props.charts.spendRevenue.series.every((row) => row.spend === 0 && row.revenue === 0)).toBe(true);
    expect(props.charts.channelSpend.hasData).toBe(false);
    expect(props.charts.channelSpend.series.every((row) => row.spend === 0)).toBe(true);
    // No channel has both CAC and LTV12, so the scatter says so and keeps a dash per channel.
    expect(props.charts.cacLtv.hasData).toBe(false);
    expect(props.charts.cacLtv.series).toEqual([]);
    expect(props.charts.cacLtv.caption).toContain('нет каналов с CAC и LTV12');
    expect(props.charts.cacLtv.table.rows.length).toBeGreaterThan(0);
    expect(props.charts.cacLtv.table.rows.every((row) => row.cells.cac === '—')).toBe(true);
    expect(res.text).not.toContain('NaN');
  });
});
