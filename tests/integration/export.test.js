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

/**
 * @param {string} html
 * @returns {string} The `<tbody>` slice, so table assertions do not match sidebar labels.
 */
function tableBody(html) {
  const start = html.indexOf('<tbody');
  const end = html.indexOf('</tbody>');
  return start === -1 || end === -1 ? '' : html.slice(start, end);
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

  it('clamps a future upper bound to the data anchor instead of promising rows that do not exist', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/export/daily_stats.csv').query({ to: addDays(anchor, 30) });

    expect(res.status).toBe(200);
    const { rows } = csvOf(res);
    expect(rows.length).toBeGreaterThan(0);
    const from = addDays(anchor, -29);
    expect(rows.every((row) => row.stat_date >= from && row.stat_date <= anchor)).toBe(true);
    expect(rows.some((row) => row.stat_date > anchor)).toBe(false);
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
      // ISO 8601 with the Minsk offset: the importer accepts this shape, so the file round-trips.
      expect(row.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+03:00$/);
      expect(row.occurred_at.slice(0, 10) >= from && row.occurred_at.slice(0, 10) <= anchor).toBe(true);
      expect(row.revenue_byn).toMatch(/^\d+,\d{2}$/);
      expect(row.margin_byn).toMatch(/^\d+,\d{2}$/);
    }

    // The exported timestamp is the same instant that is stored, not a re-interpreted local date.
    const { rows: stored } = await pool.query('SELECT occurred_at FROM orders WHERE external_id = $1', [
      rows[0].external_id,
    ]);
    expect(new Date(rows[0].occurred_at).getTime()).toBe(stored[0].occurred_at.getTime());
  });

  it('does not advertise a row cap when nothing was truncated', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/export/orders.csv').query({ from: addDays(anchor, -1), to: anchor });

    expect(res.status).toBe(200);
    expect(res.headers['x-row-limit']).toBeUndefined();
    expect(res.headers['x-row-truncated']).toBeUndefined();
  });

  it('neutralises formulas in external ids', async () => {
    const from = addDays(anchor, -9);
    const { rows: picked } = await pool.query(
      `SELECT o.id::text AS order_id, o.external_id, cu.id::text AS customer_id, cu.external_id AS customer_external_id
         FROM orders o
         JOIN customers cu ON cu.id = o.customer_id
        WHERE (o.occurred_at AT TIME ZONE 'Europe/Minsk')::date BETWEEN $1::date AND $2::date
        ORDER BY o.id
        LIMIT 1`,
      [from, anchor],
    );
    const original = picked[0];
    try {
      await pool.query('UPDATE orders SET external_id = $1 WHERE id = $2::bigint', ['@cmd', original.order_id]);
      await pool.query('UPDATE customers SET external_id = $1 WHERE id = $2::bigint', ['=1+1', original.customer_id]);

      const agent = await signedIn(VIEWER);
      const res = await agent.get('/app/export/orders.csv').query({ from, to: anchor });

      const { rows } = csvOf(res);
      expect(rows.find((row) => row.customer_external_id === "'=1+1")?.external_id).toBe("'@cmd");
    } finally {
      await pool.query('UPDATE orders SET external_id = $1 WHERE id = $2::bigint', [
        original.external_id,
        original.order_id,
      ]);
      await pool.query('UPDATE customers SET external_id = $1 WHERE id = $2::bigint', [
        original.customer_external_id,
        original.customer_id,
      ]);
    }
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
    expect(rows[0].payload).toMatchObject({ filters: { kind: 'paid' }, rowsCount: 6, truncated: false });
  });

  it('filters export rows by dataset in the journal', async () => {
    const viewer = await signedIn(VIEWER);
    await viewer.get('/app/export/channels.csv');
    await viewer.get('/app/export/campaigns.csv');

    const admin = await signedIn(ADMIN);
    const res = await admin.get('/app/audit').query({ entity: 'channels', action: AUDIT_ACTIONS.EXPORT_CSV });

    expect(res.status).toBe(200);
    // The code must survive the filter instead of being downgraded to "all".
    expect(res.text).toContain('<option value="channels" selected>');
    const body = tableBody(res.text);
    expect(body).toContain('Экспорт CSV');
    expect(body).toContain('Каналы');
    expect(body).not.toContain('Кампании');
    expect(body).toContain('Строк:');
    expect(body).toContain('Фильтры:');
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
