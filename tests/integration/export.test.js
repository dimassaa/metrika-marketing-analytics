import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
import { addDays } from '../../src/lib/dates.js';
import { parseCsv } from '../../src/lib/csv.js';
import { AUDIT_ACTIONS } from '../../src/config/audit-actions.js';

const ANALYST = 'analyst@metrika.by';
const VIEWER = 'viewer@metrika.by';
const ADMIN = 'admin@metrika.by';

/** @type {import('pg').Pool} */
let pool;
/** @type {import('express').Express} */
let app;
/** Latest date with statistics: the app's data anchor, never the system clock. */
let anchor;

beforeAll(async () => {
  await resetTestDatabase();
  await seed();
  pool = getTestPool();
  const { rows } = await pool.query('SELECT max(stat_date)::text AS anchor FROM daily_stats');
  anchor = rows[0].anchor;
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  // Export writes a journal row on every call; clearing it keeps each audit assertion about the request it just made.
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM sessions');
  app = makeApp();
});

/**
 * @param {string} email
 * @returns {Promise<import('supertest').SuperAgentTest>}
 */
async function signedIn(email) {
  const agent = request.agent(app);
  const login = await loginAs(agent, email);
  expect(login.status).toBe(302);
  return agent;
}

/**
 * Splits a CSV response into header-named records using the same parser the importer uses.
 * @param {import('supertest').Response} res
 * @returns {{ headers: string[], rows: Array<Record<string, string>> }}
 */
function csvOf(res) {
  const { headers, rows } = parseCsv(res.text);
  return { headers, rows: rows.map((row) => row.values) };
}

describe('channels export', () => {
  it('downloads a BOM-prefixed CRLF CSV containing only the filtered channels', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/export/channels.csv').query({ kind: 'paid' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="metrika-channels-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.text.startsWith('\uFEFFcode;name;kind;')).toBe(true);
    expect(res.text.includes('\r\n')).toBe(true);

    const { headers, rows } = csvOf(res);
    expect(headers).toEqual([
      'code',
      'name',
      'kind',
      'is_active',
      'target_cac_byn',
      'target_romi_pct',
      'campaigns_count',
    ]);
    // The seed has eight channels, six of them paid.
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.kind === 'paid')).toBe(true);
    // Money is a plain decimal with a comma and no thousands separators, so a spreadsheet reads a number.
    for (const row of rows) {
      expect(row.target_cac_byn).toMatch(/^\d+,\d{2}$/);
      expect(row.target_romi_pct).toMatch(/^\d+,\d{2}$/);
      expect(row.campaigns_count).toMatch(/^\d+$/);
      expect(['true', 'false']).toContain(row.is_active);
    }
  });

  it('is available to a viewer, an analyst and an admin', async () => {
    for (const email of [VIEWER, ANALYST, ADMIN]) {
      const agent = await signedIn(email);
      const res = await agent.get('/app/export/channels.csv');
      expect(res.status, `${email} must be allowed to export`).toBe(200);
    }
  });

  it('sends an anonymous request to the login form', async () => {
    const res = await request(app).get('/app/export/channels.csv');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?next=%2Fapp%2Fexport%2Fchannels.csv');
  });

  it('neutralises spreadsheet formulas in text cells', async () => {
    await pool.query("UPDATE channels SET name = '=1+1' WHERE code = 'instagram'");
    await pool.query("UPDATE channels SET name = '@cmd' WHERE code = 'google'");
    try {
      const agent = await signedIn(VIEWER);
      const res = await agent.get('/app/export/channels.csv');

      const { rows } = csvOf(res);
      const byCode = Object.fromEntries(rows.map((row) => [row.code, row.name]));
      expect(byCode.instagram).toBe("'=1+1");
      expect(byCode.google).toBe("'@cmd");
    } finally {
      await pool.query("UPDATE channels SET name = 'Instagram' WHERE code = 'instagram'");
      await pool.query("UPDATE channels SET name = 'Google Ads' WHERE code = 'google'");
    }
  });
});

describe('campaigns export', () => {
  it('honours the status filter', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/export/campaigns.csv').query({ status: 'finished' });

    expect(res.status).toBe(200);
    const { headers, rows } = csvOf(res);
    expect(headers).toEqual([
      'code',
      'name',
      'channel_code',
      'status',
      'started_on',
      'ended_on',
      'budget_byn',
      'spend_byn',
    ]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === 'finished')).toBe(true);
    for (const row of rows) {
      expect(row.ended_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (row.budget_byn !== '') expect(row.budget_byn).toMatch(/^\d+,\d{2}$/);
      expect(row.spend_byn).toMatch(/^\d+,\d{2}$/);
    }
  });
});

describe('daily statistics export', () => {
  it('keeps every row inside the requested anchor-relative period and formats money for Excel', async () => {
    const agent = await signedIn(VIEWER);
    const from = addDays(anchor, -9);

    const res = await agent.get('/app/export/daily_stats.csv').query({ from, to: anchor });

    expect(res.status).toBe(200);
    const { headers, rows } = csvOf(res);
    expect(headers).toEqual([
      'stat_date',
      'channel_code',
      'campaign_code',
      'impressions',
      'clicks',
      'leads',
      'spend_byn',
    ]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.stat_date >= from && row.stat_date <= anchor).toBe(true);
      expect(row.spend_byn).toMatch(/^\d+,\d{2}$/);
      expect(row.spend_byn).not.toContain(' ');
      expect(row.impressions).toMatch(/^\d+$/);
    }
  });

  it('defaults an omitted period to the last 30 days from the data anchor', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/export/daily_stats.csv');

    expect(res.status).toBe(200);
    const { rows } = csvOf(res);
    expect(rows.length).toBeGreaterThan(0);
    const from = addDays(anchor, -29);
    expect(rows.every((row) => row.stat_date >= from && row.stat_date <= anchor)).toBe(true);
  });
});

describe('orders export', () => {
  it('exports external ids, first-touch channel, dates and money as decimals', async () => {
    const agent = await signedIn(VIEWER);
    const from = addDays(anchor, -9);

    const res = await agent.get('/app/export/orders.csv').query({ from, to: anchor });

    expect(res.status).toBe(200);
    const { headers, rows } = csvOf(res);
    expect(headers).toEqual([
      'external_id',
      'customer_external_id',
      'first_channel_code',
      'campaign_code',
      'occurred_at',
      'revenue_byn',
      'margin_byn',
    ]);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.external_id).not.toBe('');
      expect(row.customer_external_id).not.toBe('');
      expect(row.first_channel_code).not.toBe('');
      expect(row.occurred_at >= from && row.occurred_at <= anchor).toBe(true);
      expect(row.revenue_byn).toMatch(/^\d+,\d{2}$/);
      expect(row.margin_byn).toMatch(/^\d+,\d{2}$/);
    }
  });

  it('advertises the order row cap', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/export/orders.csv');

    expect(res.status).toBe(200);
    expect(res.headers['x-row-limit']).toBe('50000');
  });
});

describe('export guard rails', () => {
  it('writes an audit row with the dataset, filters and row count', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/export/channels.csv').query({ kind: 'paid' });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT a.action, a.entity, a.payload, u.email
         FROM audit_log a
         JOIN users u ON u.id = a.user_id
        WHERE a.action = $1`,
      [AUDIT_ACTIONS.EXPORT_CSV],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(VIEWER);
    expect(rows[0].entity).toBe('channels');
    expect(rows[0].payload).toMatchObject({ filters: { kind: 'paid' }, rowsCount: 6 });
  });

  it('rejects an unknown dataset with a validation error instead of a file', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/export/unknown.csv');

    expect(res.status).toBe(400);
    expect(res.text).toContain('Неизвестный набор данных');
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('rejects a reversed period with a validation error', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/export/daily_stats.csv').query({ from: anchor, to: addDays(anchor, -1) });

    expect(res.status).toBe(400);
    expect(res.text).toContain('Начало периода');
  });
});
