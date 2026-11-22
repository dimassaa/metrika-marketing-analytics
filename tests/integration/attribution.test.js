import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../../db/seed/seed.js';
import { addDays, isoWeekStart, minskDayEnd, minskDayStart } from '../../src/lib/dates.js';
import { createAttributionRepository } from '../../src/repositories/attribution.repo.js';
import { createChannelsRepository } from '../../src/repositories/channels.repo.js';
import { createMetricsRepository } from '../../src/repositories/metrics.repo.js';
import { attributeOrders, createAttributionService } from '../../src/services/metrics/attribution.service.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';

/**
 * Fixed anchor so the seed is deterministic. The window is the default 30 inclusive days, the same one the CAC
 * integration test uses, which keeps the two reports comparable.
 */
const ANCHOR = '2026-11-21';
const FROM = addDays(ANCHOR, -29);
const TO = ANCHOR;
const MODELS = ['last_touch', 'first_touch', 'linear'];

/** @type {import('pg').Pool} */
let pool;
/** @type {ReturnType<typeof createAttributionRepository>} */
let attributionRepository;
/** @type {ReturnType<typeof createMetricsRepository>} */
let metricsRepository;
/** @type {ReturnType<typeof createAttributionService>} */
let attributionService;
/** @type {Record<string, string>} */
let channelIds;

beforeAll(async () => {
  await resetTestDatabase();
  await seed({ anchorDate: ANCHOR });
  pool = getTestPool();
  attributionRepository = createAttributionRepository(pool);
  metricsRepository = createMetricsRepository(pool);
  attributionService = createAttributionService({
    attributionRepository,
    metricsRepository,
    channelsRepository: createChannelsRepository(pool),
  });

  const { rows } = await pool.query('SELECT id::text AS id, code FROM channels ORDER BY code');
  channelIds = Object.fromEntries(rows.map((row) => [row.code, row.id]));
});

afterAll(async () => {
  await closeTestPool();
});

/**
 * @param {Array<{ revenueCents: string }>} rows
 * @returns {bigint}
 */
function sumCents(rows) {
  return rows.reduce((sum, row) => sum + BigInt(row.revenueCents), 0n);
}

/**
 * @param {{
 *   models: Record<string, { revenueByChannel: Array<{ channelId: string, revenueCents: string }> }>,
 * }} report
 * @param {string} model
 * @param {string} channelId
 * @returns {string}
 */
function channelCents(report, model, channelId) {
  const row = report.models[model].revenueByChannel.find((entry) => entry.channelId === channelId);
  expect(row).toBeDefined();
  return row.revenueCents;
}

describe('attribution against the seeded stand', () => {
  it('holds the cent invariant for every model and the period order revenue', async () => {
    const report = await attributionService.getAttributionReport({ from: FROM, to: TO });

    const { rows: totals } = await pool.query(
      `SELECT count(*)::int AS orders, coalesce(sum(revenue_cents), 0)::bigint::text AS revenue_cents
         FROM orders
        WHERE occurred_at >= $1::timestamptz
          AND occurred_at <= $2::timestamptz`,
      [minskDayStart(FROM), minskDayEnd(TO)],
    );
    expect(totals[0].orders).toBeGreaterThan(0);
    const expectedRevenue = BigInt(totals[0].revenue_cents);
    // Golden total of the deterministic seed for this anchor; a seed change must update this number explicitly.
    expect(expectedRevenue).toBe(9356994n);

    expect(report.period).toEqual({ from: FROM, to: TO });
    expect(Object.keys(report.models)).toEqual(MODELS);

    for (const model of MODELS) {
      const view = report.models[model];
      expect(view.totalRevenueCents).toBe(expectedRevenue.toString());
      // Every seeded customer has an acquisition channel, so no order may fall out of the allocation.
      expect(view.totalAttributedCents).toBe(expectedRevenue.toString());
      expect(sumCents(view.revenueByChannel)).toBe(expectedRevenue);
    }
  });

  it('reconciles the comparison table with the three model maps', async () => {
    const report = await attributionService.getAttributionReport({ from: FROM, to: TO });

    expect(report.comparison).toHaveLength(8);
    expect(new Set(report.comparison.map((row) => row.channelId)).size).toBe(report.comparison.length);
    for (const row of report.comparison) {
      expect(row.deltaModel).toBe('linear');
      expect(row.lastTouchCents).toBe(channelCents(report, 'last_touch', row.channelId));
      expect(row.firstTouchCents).toBe(channelCents(report, 'first_touch', row.channelId));
      expect(row.linearCents).toBe(channelCents(report, 'linear', row.channelId));
      expect(BigInt(row.deltaLinearVsLastCents)).toBe(BigInt(row.linearCents) - BigInt(row.lastTouchCents));
    }
  });

  it('keeps ROMI undefined for owned channels without spend', async () => {
    const report = await attributionService.getAttributionReport({ from: FROM, to: TO });
    const spend = await metricsRepository.listChannelSpend({ from: FROM, to: TO });
    const freeChannels = spend.filter((row) => row.spendCents === 0n).map((row) => row.channelId);

    expect(freeChannels.length).toBeGreaterThan(0);
    for (const channelId of freeChannels) {
      const row = report.models.last_touch.revenueByChannel.find((entry) => entry.channelId === channelId);
      expect(row.romiPct).toBeNull();
    }
  });

  it('sums weekly last-touch revenue into the report total, Monday to Sunday', async () => {
    const report = await attributionService.getAttributionReport({ from: FROM, to: TO });
    const series = await attributionService.getAttributionSeries({ from: FROM, to: TO });

    expect(series.length).toBeGreaterThan(0);
    for (const row of series) {
      expect(isoWeekStart(row.weekStart)).toBe(row.weekStart);
    }
    expect(sumCents(series)).toBe(BigInt(report.models.last_touch.totalAttributedCents));
  });

  it('filters the series by channel without losing kopecks', async () => {
    const report = await attributionService.getAttributionReport({ from: FROM, to: TO });
    const series = await attributionService.getAttributionSeries({
      from: FROM,
      to: TO,
      model: 'linear',
      channelId: channelIds.instagram,
    });

    expect(sumCents(series)).toBe(BigInt(channelCents(report, 'linear', channelIds.instagram)));
    expect(sumCents(series)).toBeLessThanOrEqual(BigInt(report.models.linear.totalAttributedCents));
  });

  it('serialises without NaN or Infinity', async () => {
    const report = await attributionService.getAttributionReport({ from: FROM, to: TO });

    expect(JSON.stringify(report)).not.toMatch(/NaN|Infinity/);
  });
});

describe('attribution boundaries', () => {
  it('reads an order at 00:30 Minsk on its own day and its window edges exactly', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const scopedRepository = createAttributionRepository(client);
      const fallbackChannelId = channelIds.instagram;

      const { rows: dayCustomers } = await client.query(
        `INSERT INTO customers (external_id, first_channel_id, acquired_at)
         VALUES ('attr_day_customer', $1::bigint, '2026-09-01T00:00:00+03:00')
         RETURNING id::text AS id`,
        [fallbackChannelId],
      );
      const dayCustomerId = dayCustomers[0].id;

      const at0030 = new Date(minskDayStart('2026-11-10').getTime() + 30 * 60_000);
      const previousDayEnd = minskDayEnd('2026-11-09');

      await client.query(
        `INSERT INTO orders (external_id, customer_id, occurred_at, revenue_cents, margin_cents)
         VALUES ('attr_order_0030', $1::bigint, $2::timestamptz, 5000, 2000),
                ('attr_order_prev', $1::bigint, $3::timestamptz, 7000, 3000)`,
        [dayCustomerId, at0030, previousDayEnd],
      );

      const { rows: dayOrders } = await client.query(
        `SELECT id::text AS id, external_id FROM orders WHERE external_id LIKE 'attr_order_%'`,
      );
      const dayOrderIds = Object.fromEntries(dayOrders.map((order) => [order.external_id, order.id]));

      const onTenth = await scopedRepository.listOrdersInPeriod({ from: '2026-11-10', to: '2026-11-10' });
      const onNinth = await scopedRepository.listOrdersInPeriod({ from: '2026-11-09', to: '2026-11-09' });

      expect(onTenth.some((order) => order.orderId === dayOrderIds.attr_order_0030)).toBe(true);
      expect(onTenth.some((order) => order.orderId === dayOrderIds.attr_order_prev)).toBe(false);
      expect(onNinth.some((order) => order.orderId === dayOrderIds.attr_order_prev)).toBe(true);
      expect(onNinth.some((order) => order.orderId === dayOrderIds.attr_order_0030)).toBe(false);

      // Window probes: the exact 30-day edge is included, one second older is not. Both stay inside the
      // repository's wider fetch range, so the exclusion below is the service's per-order window, not the query.
      const { rows: windowCustomers } = await client.query(
        `INSERT INTO customers (external_id, first_channel_id, acquired_at)
         VALUES ('attr_window_customer', $1::bigint, '2026-09-01T00:00:00+03:00'),
                ('attr_fallback_customer', $1::bigint, '2026-09-01T00:00:00+03:00')
         RETURNING id::text AS id, external_id`,
        [fallbackChannelId],
      );
      const customerByExternalId = Object.fromEntries(
        windowCustomers.map((customer) => [customer.external_id, customer.id]),
      );
      const windowCustomerId = customerByExternalId.attr_window_customer;
      const fallbackCustomerId = customerByExternalId.attr_fallback_customer;

      const orderAt = new Date('2026-11-10T12:00:00+03:00');
      const { rows: windowOrders } = await client.query(
        `INSERT INTO orders (external_id, customer_id, occurred_at, revenue_cents, margin_cents)
         VALUES ('attr_order_window', $1::bigint, $2::timestamptz, 5000, 2000),
                ('attr_order_fallback', $3::bigint, $2::timestamptz, 4000, 1500)
         RETURNING id::text AS id, external_id`,
        [windowCustomerId, orderAt, fallbackCustomerId],
      );
      const windowOrderIds = Object.fromEntries(
        windowOrders.map((order) => [order.external_id, order.id]),
      );

      const edgeAt = new Date(orderAt.getTime() - 30 * 86_400_000);
      const tooOldAt = new Date(edgeAt.getTime() - 1_000);
      const { rows: probes } = await client.query(
        `INSERT INTO touchpoints (customer_id, channel_id, occurred_at, kind)
         VALUES ($1::bigint, $2::bigint, $3::timestamptz, 'click'),
                ($1::bigint, $4::bigint, $5::timestamptz, 'click')
         RETURNING id::text AS id`,
        [windowCustomerId, channelIds.yandex, edgeAt, channelIds.tiktok, tooOldAt],
      );

      const orders = (await scopedRepository.listOrdersInPeriod({ from: '2026-11-10', to: '2026-11-10' })).filter(
        (order) => [windowOrderIds.attr_order_window, windowOrderIds.attr_order_fallback].includes(order.orderId),
      );
      const touchpoints = await scopedRepository.listTouchpointsForOrders({
        from: '2026-11-10',
        to: '2026-11-10',
      });
      // Both probes survive the repository fetch; only the exact edge may survive the service window.
      const fetchedProbes = touchpoints.filter((touchpoint) =>
        probes.some((probe) => probe.id === touchpoint.touchpointId),
      );
      expect(fetchedProbes).toHaveLength(2);

      const firstTouch = attributeOrders({ orders, touchpoints, model: 'first_touch' });
      expect(firstTouch).toEqual(
        expect.arrayContaining([
          { orderId: windowOrderIds.attr_order_window, channelId: channelIds.yandex, amountCents: 5000n },
          {
            orderId: windowOrderIds.attr_order_fallback,
            channelId: fallbackChannelId,
            amountCents: 4000n,
          },
        ]),
      );

      for (const model of MODELS) {
        const allocations = attributeOrders({ orders, touchpoints, model });
        const byOrder = new Map();
        for (const allocation of allocations) {
          byOrder.set(
            allocation.orderId,
            (byOrder.get(allocation.orderId) ?? 0n) + allocation.amountCents,
          );
        }
        expect(byOrder.get(windowOrderIds.attr_order_window)).toBe(5000n);
        expect(byOrder.get(windowOrderIds.attr_order_fallback)).toBe(4000n);
        // The 30-day + 1 s touch belongs to the same customer, so a broken window would move first-touch/linear.
        expect(allocations.some((allocation) => allocation.channelId === channelIds.tiktok)).toBe(false);
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('keeps an order with sub-millisecond digits at the end of the day inside that day', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: customers } = await client.query(
        `INSERT INTO customers (external_id, first_channel_id, acquired_at)
         VALUES ('attr_frac_customer', $1::bigint, '2026-09-01T00:00:00+03:00')
         RETURNING id::text AS id`,
        [channelIds.instagram],
      );
      const { rows: orders } = await client.query(
        `INSERT INTO orders (external_id, customer_id, occurred_at, revenue_cents, margin_cents)
         VALUES ('attr_order_frac', $1::bigint, '2026-11-10T23:59:59.9995+03:00'::timestamptz, 3300, 1200)
         RETURNING id::text AS id`,
        [customers[0].id],
      );

      // `minskDayEnd` stops at .999, so an inclusive `<=` bound would silently drop this row. The half-open
      // `[dayStart, nextDayStart)` bound keeps it while still excluding the first instant of the next day.
      const scopedRepository = createAttributionRepository(client);
      const onTenth = await scopedRepository.listOrdersInPeriod({ from: '2026-11-10', to: '2026-11-10' });
      const onEleventh = await scopedRepository.listOrdersInPeriod({ from: '2026-11-11', to: '2026-11-11' });

      expect(onTenth.some((order) => order.orderId === orders[0].id)).toBe(true);
      expect(onEleventh.some((order) => order.orderId === orders[0].id)).toBe(false);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('attributes a sub-millisecond touchpoint of the last day through the half-open bound', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: customers } = await client.query(
        `INSERT INTO customers (external_id, first_channel_id, acquired_at)
         VALUES ('attr_frac_touch_customer', $1::bigint, '2026-09-01T00:00:00+03:00')
         RETURNING id::text AS id`,
        [channelIds.instagram],
      );
      const customerId = customers[0].id;
      await client.query(
        `INSERT INTO orders (external_id, customer_id, occurred_at, revenue_cents, margin_cents)
         VALUES ('attr_frac_touch_order', $1::bigint, '2026-11-10T23:59:59.9999+03:00'::timestamptz, 4400, 2000)`,
        [customerId],
      );
      const { rows: probes } = await client.query(
        `INSERT INTO touchpoints (customer_id, channel_id, occurred_at, kind)
         VALUES ($1::bigint, $2::bigint, '2026-11-10T23:59:59.9995+03:00'::timestamptz, 'click')
         RETURNING id::text AS id`,
        [customerId, channelIds.yandex],
      );

      const scopedRepository = createAttributionRepository(client);
      const touchpoints = await scopedRepository.listTouchpointsForOrders({
        from: '2026-11-10',
        to: '2026-11-10',
      });

      expect(touchpoints.some((touchpoint) => touchpoint.touchpointId === probes[0].id)).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
