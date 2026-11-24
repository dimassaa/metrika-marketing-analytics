import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { minskYesterday } from '../../src/lib/dates.js';
import { seed } from '../../db/seed/seed.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';

// The seed always ends at the Minsk calendar day before the run. Every date assertion below is relative to that
// anchor, so the suite stays green tomorrow and next month instead of pinning today's date.
const ANCHOR = minskYesterday();

describe('demo seed', () => {
  /** @type {import('pg').Pool | null} */
  let pool = null;
  /** @type {Awaited<ReturnType<typeof seed>> | null} */
  let first = null;

  beforeAll(async () => {
    await resetTestDatabase();
    pool = getTestPool();
    first = await seed();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  /**
   * Counts rows of a table named by a constant in this file; no user input reaches the SQL text.
   * @param {string} table
   * @returns {Promise<number>}
   */
  async function countRows(table) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0].n;
  }

  it('creates the documented demo volumes and reports the same counts it stored', async () => {
    expect(first).toMatchObject({ channels: 8, campaigns: 32, users: 3 });
    expect(first.customers).toBe(4000);
    expect(first.orders).toBeGreaterThanOrEqual(9000);
    expect(first.orders).toBeLessThanOrEqual(10000);
    expect(first.touchpoints).toBeGreaterThanOrEqual(8000);

    expect(await countRows('users')).toBe(first.users);
    expect(await countRows('channels')).toBe(first.channels);
    expect(await countRows('campaigns')).toBe(first.campaigns);
    expect(await countRows('customers')).toBe(first.customers);
    expect(await countRows('orders')).toBe(first.orders);
    expect(await countRows('touchpoints')).toBe(first.touchpoints);
  });

  it('seeds the committed 1200×630 raster as the OG cover', async () => {
    const { rows } = await pool.query(
      "SELECT filename, mime_type, size_bytes, bytes FROM media_assets WHERE slug = 'og-cover'",
    );
    const committed = readFileSync(new URL('../../public/img/og-cover.png', import.meta.url));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ filename: 'og-cover.png', mime_type: 'image/png' });
    expect(rows[0].size_bytes).toBe(committed.length);
    expect(rows[0].bytes.equals(committed)).toBe(true);
    // A 1×1 placeholder used to be seeded here; the social card needs the real dimensions.
    expect(committed.readUInt32BE(16)).toBe(1200);
    expect(committed.readUInt32BE(20)).toBe(630);
  });

  it('creates three demo users with argon2id hashes', async () => {
    const { rows } = await pool.query('SELECT email, role, password_hash FROM users ORDER BY role');
    expect(rows.map((row) => row.role)).toEqual(['admin', 'analyst', 'viewer']);
    expect(rows.map((row) => row.email)).toEqual([
      'admin@metrika.by',
      'analyst@metrika.by',
      'viewer@metrika.by',
    ]);
    for (const row of rows) expect(row.password_hash.startsWith('$argon2')).toBe(true);
  });

  it('covers 14 whole months of daily stats through the Minsk anchor day', async () => {
    const { rows: [anchorRow] } = await pool.query('SELECT max(stat_date)::text AS d FROM daily_stats');
    expect(anchorRow.d).toBe(ANCHOR);

    const { rows: [window] } = await pool.query(`
      SELECT min(stat_date)::text AS first_day, count(DISTINCT date_trunc('month', stat_date))::int AS months
      FROM daily_stats`);
    expect(window.first_day).toMatch(/^\d{4}-\d{2}-01$/);
    expect(window.months).toBe(14);
  });

  it('gives every customer a first order and keeps acquisition before it', async () => {
    const { rows: [missingFirstOrder] } = await pool.query(
      'SELECT count(*)::int AS n FROM customers WHERE first_order_at IS NULL',
    );
    expect(missingFirstOrder.n).toBe(0);

    const { rows: [acquiredAfterOrder] } = await pool.query(
      'SELECT count(*)::int AS n FROM customers WHERE acquired_at > first_order_at',
    );
    expect(acquiredAfterOrder.n).toBe(0);

    // First-touch attribution must survive every read: the earliest touchpoint is always the acquisition channel.
    const { rows: [mismatch] } = await pool.query(`
      SELECT count(*)::int AS n FROM customers c
      JOIN LATERAL (
        SELECT channel_id FROM touchpoints t WHERE t.customer_id = c.id ORDER BY occurred_at, id LIMIT 1
      ) f ON true
      WHERE f.channel_id <> c.first_channel_id`);
    expect(mismatch.n).toBe(0);
  });

  it('keeps 1-5 orders per customer with the first order at first_order_at', async () => {
    const { rows: [outsideRange] } = await pool.query(`
      SELECT count(*)::int AS n FROM (
        SELECT customer_id FROM orders GROUP BY customer_id HAVING count(*) > 5
      ) bad`);
    expect(outsideRange.n).toBe(0);

    const { rows: [orphans] } = await pool.query(`
      SELECT count(*)::int AS n FROM customers c
      WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)`);
    expect(orphans.n).toBe(0);

    const { rows: [firstOrderDrift] } = await pool.query(`
      SELECT count(*)::int AS n FROM customers c
      JOIN LATERAL (SELECT min(occurred_at) AS t FROM orders o WHERE o.customer_id = c.id) m ON true
      WHERE m.t <> c.first_order_at`);
    expect(firstOrderDrift.n).toBe(0);

    const { rows: [marginAboveRevenue] } = await pool.query(
      'SELECT count(*)::int AS n FROM orders WHERE margin_cents > revenue_cents',
    );
    expect(marginAboveRevenue.n).toBe(0);

    const { rows: [afterAnchor] } = await pool.query(
      `SELECT count(*)::int AS n FROM orders WHERE (occurred_at AT TIME ZONE 'Europe/Minsk')::date > $1::date`,
      [ANCHOR],
    );
    expect(afterAnchor.n).toBe(0);
  });

  it('keeps 2-5 touchpoints per customer with at least one before the first order', async () => {
    const { rows: [outsideRange] } = await pool.query(`
      SELECT count(*)::int AS n FROM (
        SELECT customer_id FROM touchpoints GROUP BY customer_id HAVING count(*) < 2 OR count(*) > 5
      ) bad`);
    expect(outsideRange.n).toBe(0);

    const { rows: [noPreOrderTouch] } = await pool.query(`
      SELECT count(*)::int AS n FROM customers c
      WHERE NOT EXISTS (
        SELECT 1 FROM touchpoints t WHERE t.customer_id = c.id AND t.occurred_at < c.first_order_at)`);
    expect(noPreOrderTouch.n).toBe(0);
  });

  it('keeps paid channels funded, free channels at zero spend and the funnel coherent', async () => {
    const { rows: byKind } = await pool.query(`
      SELECT ch.kind, sum(ds.spend_cents)::float8 AS spend
      FROM channels ch
      JOIN campaigns cp ON cp.channel_id = ch.id
      JOIN daily_stats ds ON ds.campaign_id = cp.id
      GROUP BY ch.kind`);
    const spendByKind = Object.fromEntries(byKind.map((row) => [row.kind, row.spend]));
    // The metrics spec declares Email and SEO free channels in the demo, so only paid and earned-adjacent
    // campaigns carry spend; every other channel must be funded, otherwise CAC would be meaningless.
    expect(spendByKind.paid).toBeGreaterThan(0);
    expect(spendByKind.owned).toBe(0);
    expect(spendByKind.earned).toBe(0);

    const { rows: [funnelBroken] } = await pool.query(
      'SELECT count(*)::int AS n FROM daily_stats WHERE clicks > impressions OR leads > clicks',
    );
    expect(funnelBroken.n).toBe(0);
  });

  it('sets the four demo goals for the last 12 months, created by the admin', async () => {
    const { rows: [admin] } = await pool.query(`SELECT id::text AS id FROM users WHERE role = 'admin'`);
    const { rows } = await pool.query(`
      SELECT metric, target_value::float8 AS target, period_start::text AS start, period_end::text AS end,
             created_by::text AS created_by
      FROM goals ORDER BY metric`);
    expect(rows.map((row) => row.metric)).toEqual(['cac', 'ltv_cac', 'payback', 'romi']);

    const goals = Object.fromEntries(rows.map((row) => [row.metric, row]));
    expect(goals.cac.target).toBe(50);
    expect(goals.romi.target).toBe(120);
    expect(goals.ltv_cac.target).toBe(3);
    expect(goals.payback.target).toBe(12);
    for (const goal of rows) {
      expect(goal.end).toBe(ANCHOR);
      expect(goal.start).toMatch(/^\d{4}-\d{2}-01$/);
      expect(goal.created_by).toBe(admin.id);
    }
  });

  /**
   * Content fingerprint of the generated tables. Row counts alone would not notice a change in impressions,
   * clicks, leads or spend, and the revenue sum only covers `orders`; the daily-checksum closes that gap. The
   * timestamps are compared as min/max so a shifted event window fails even if row counts stay equal.
   * @returns {Promise<{ daily: string, orders: { first: string, last: string }, touchpoints: { first: string, last: string } }>}
   */
  async function dataFingerprint() {
    const { rows: [daily] } = await pool.query(`
      SELECT md5(string_agg(
        campaign_id::text || ':' || stat_date::text || ':' || impressions::text || ':' ||
        clicks::text || ':' || leads::text || ':' || spend_cents::text,
        ',' ORDER BY campaign_id, stat_date
      )) AS digest
      FROM daily_stats`);
    const { rows: [orders] } = await pool.query(
      'SELECT min(occurred_at)::text AS first, max(occurred_at)::text AS last FROM orders',
    );
    const { rows: [touchpoints] } = await pool.query(
      'SELECT min(occurred_at)::text AS first, max(occurred_at)::text AS last FROM touchpoints',
    );
    return { daily: daily.digest, orders, touchpoints };
  }

  it('is idempotent: a second run reproduces the same rows and totals', async () => {
    const fingerprintBefore = await dataFingerprint();
    const { rows: [before] } = await pool.query('SELECT sum(revenue_cents)::text AS s FROM orders');
    const second = await seed();
    const { rows: [after] } = await pool.query('SELECT sum(revenue_cents)::text AS s FROM orders');
    const fingerprintAfter = await dataFingerprint();

    expect(second.orders).toBe(first.orders);
    expect(second.customers).toBe(first.customers);
    expect(after.s).toBe(before.s);
    expect(await countRows('orders')).toBe(first.orders);
    expect(fingerprintAfter).toEqual(fingerprintBefore);
  });
});
