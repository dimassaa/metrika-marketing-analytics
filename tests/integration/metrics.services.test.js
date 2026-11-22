import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_PRNG, seed } from '../../db/seed/seed.js';
import { addDays, addMonths, minskDayStart, minskDayEnd, startOfMonth } from '../../src/lib/dates.js';
import { roundNumber } from '../../src/lib/metrics-math.js';
import { resolvePeriod } from '../../src/lib/periods.js';
import { createReferenceRepository } from '../../src/repositories/reference.repo.js';
import { createAttributionRepository } from '../../src/repositories/attribution.repo.js';
import { createCampaignsRepository } from '../../src/repositories/campaigns.repo.js';
import { createChannelsRepository } from '../../src/repositories/channels.repo.js';
import { createCohortsRepository } from '../../src/repositories/cohorts.repo.js';
import { createGoalsRepository } from '../../src/repositories/goals.repo.js';
import { createMetricsRepository } from '../../src/repositories/metrics.repo.js';
import { createAttributionService } from '../../src/services/metrics/attribution.service.js';
import { createCacService } from '../../src/services/metrics/cac.service.js';
import { createChannelPassportService } from '../../src/services/metrics/channel-passport.service.js';
import { createDashboardService } from '../../src/services/metrics/dashboard.service.js';
import { createGoalsProgressService } from '../../src/services/metrics/goals-progress.service.js';
import { createLtvService } from '../../src/services/metrics/ltv.service.js';
import { createRankingService } from '../../src/services/metrics/ranking.service.js';
import { createChannelHealthService, deriveHealth } from '../../src/services/metrics/romi.service.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';

/**
 * The one calendar literal of this suite. It is mirrored by `tests/fixtures/m3-golden.json`; every other date is
 * derived through `resolvePeriod`/`addDays`, so a fixture recapture cannot leave two spellings of the anchor behind.
 */
const SEED_ANCHOR = '2026-11-20';

const GOLDEN = JSON.parse(
  readFileSync(new URL('../fixtures/m3-golden.json', import.meta.url), 'utf8'),
);
const GOLDEN_CASE = GOLDEN.cases[0];
const PERIOD = resolvePeriod({ anchor: SEED_ANCHOR });

/** @type {import('pg').Pool} */
let pool;
/** @type {ReturnType<typeof createMetricsRepository>} */
let metricsRepository;
/** @type {ReturnType<typeof createCacService>} */
let cacService;
/** @type {ReturnType<typeof createLtvService>} */
let ltvService;
/** @type {ReturnType<typeof createAttributionService>} */
let attributionService;
/** @type {ReturnType<typeof createChannelHealthService>} */
let healthService;
/** @type {ReturnType<typeof createRankingService>} */
let rankingService;
/** @type {ReturnType<typeof createDashboardService>} */
let dashboardService;
/** @type {ReturnType<typeof createChannelPassportService>} */
let passportService;
/** @type {ReturnType<typeof createGoalsProgressService>} */
let goalsProgressService;
/** @type {Record<string, string>} */
let channelIds;

beforeAll(async () => {
  await resetTestDatabase();
  await seed({ anchorDate: SEED_ANCHOR });
  pool = getTestPool();

  metricsRepository = createMetricsRepository(pool);
  const channelsRepository = createChannelsRepository(pool);
  const campaignsRepository = createCampaignsRepository(pool);
  const goalsRepository = createGoalsRepository(pool);

  cacService = createCacService({ metricsRepository });
  ltvService = createLtvService({ cohortsRepository: createCohortsRepository(pool) });
  attributionService = createAttributionService({
    attributionRepository: createAttributionRepository(pool),
    metricsRepository,
    channelsRepository,
  });
  healthService = createChannelHealthService({
    cacService,
    ltvService,
    attributionService,
    channelsRepository,
  });
  rankingService = createRankingService({ healthService });
  dashboardService = createDashboardService({ healthService, metricsRepository, attributionService });
  passportService = createChannelPassportService({
    healthService,
    metricsRepository,
    attributionService,
    channelsRepository,
    campaignsRepository,
  });
  goalsProgressService = createGoalsProgressService({ goalsRepository, healthService });

  const { rows } = await pool.query('SELECT id::text AS id, code FROM channels ORDER BY code');
  channelIds = Object.fromEntries(rows.map((row) => [row.code, row.id]));
});

afterAll(async () => {
  await closeTestPool();
});

/**
 * Rounds positive kopecks/count half-up, the rule every money division in the metrics engine uses.
 * This is the only re-implementation in the suite: it turns a direct SQL aggregate into the value a service must
 * return, so the assertion compares two independent readings rather than calling the service again.
 * @param {bigint} totalCents
 * @param {number} count
 * @returns {bigint | null} `null` when the count is zero: CAC and LTV are undefined, not zero.
 */
function divideHalfUp(totalCents, count) {
  if (count === 0) return null;
  const divisor = BigInt(count);
  return (totalCents * 2n + divisor) / (2n * divisor);
}

/**
 * @param {Array<{ channelCode: string, revenueCents: string }>} rows
 * @returns {bigint}
 */
function sumRevenue(rows) {
  return rows.reduce((total, row) => total + BigInt(row.revenueCents), 0n);
}

describe('golden numbers', () => {
  it('pins the fixture to the seed generator and to the resolved default period', () => {
    expect(GOLDEN.seedPrng).toBe(SEED_PRNG);
    expect(GOLDEN.capturedFromSeed).toBe(String(SEED_PRNG));
    expect(GOLDEN_CASE.anchor).toBe(SEED_ANCHOR);
    expect({ from: GOLDEN_CASE.from, to: GOLDEN_CASE.to, days: PERIOD.days }).toEqual(PERIOD);
    expect(GOLDEN_CASE).toMatchObject({ model: 'last_touch', horizonMonths: 12 });
  });

  it('matches the exact CAC values of the seeded stand', async () => {
    const expected = GOLDEN_CASE.expected;
    const report = await cacService.getCacReport({ anchor: SEED_ANCHOR });
    const instagram = report.rows.find((row) => row.channelId === channelIds.instagram);

    expect(report.period).toEqual(PERIOD);
    expect(instagram).toMatchObject({
      spendCents: expected.instagramSpendCents,
      newCustomers: expected.instagramNewCustomers,
      cacCents: expected.instagramCacCents,
    });
    expect(report.blended).toMatchObject({
      spendCents: expected.blendedSpendCents,
      newCustomers: expected.blendedNewCustomers,
      cacCents: expected.blendedCacCents,
    });
  });

  it('matches the exact LTV12 values of the completed cohorts', async () => {
    const expected = GOLDEN_CASE.expected;
    const report = await ltvService.getChannelLtv({
      anchor: SEED_ANCHOR,
      horizonMonths: GOLDEN_CASE.horizonMonths,
    });
    const instagram = report.rows.find((row) => row.channelCode === 'instagram');

    expect(instagram).toMatchObject({
      ltvCents: expected.ltv12Cents,
      customerCount: expected.ltv12CustomerCount,
      cohortCount: expected.ltv12CohortCount,
    });
    expect(report.blended).toMatchObject({
      ltvCents: expected.blendedLtv12Cents,
      customerCount: expected.blendedLtv12CustomerCount,
      cohortCount: expected.blendedLtv12CohortCount,
    });
  });

  it('matches the exact attributed revenue of every model', async () => {
    const expected = GOLDEN_CASE.expected;
    const report = await attributionService.getAttributionReport({
      from: GOLDEN_CASE.from,
      to: GOLDEN_CASE.to,
    });

    for (const model of ['last_touch', 'first_touch', 'linear']) {
      expect(report.models[model].totalRevenueCents).toBe(expected.totalRevenueCents);
      expect(report.models[model].totalAttributedCents).toBe(expected.attributionTotalsByModel[model]);
      const instagram = report.models[model].revenueByChannel.find((row) => row.channelCode === 'instagram');
      expect(instagram.revenueCents).toBe(expected.attributionInstagramCentsByModel[model]);
    }
  });

  it('matches the exact blended health row', async () => {
    const expected = GOLDEN_CASE.expected;
    const report = await healthService.getChannelHealthReport({
      anchor: SEED_ANCHOR,
      from: GOLDEN_CASE.from,
      to: GOLDEN_CASE.to,
    });

    expect(report.blended).toMatchObject({
      romiPct: expected.blendedRomiPct,
      paybackMonths: expected.blendedPaybackMonths,
      ltvCacRatio: expected.blendedLtvCacRatio,
      status: expected.blendedHealthStatus,
      revenueCents: expected.attributionTotalsByModel.last_touch,
      newCustomers: expected.blendedNewCustomers,
      cacCents: expected.blendedCacCents,
    });
  });

  it('matches the exact ranking endpoints', async () => {
    const expected = GOLDEN_CASE.expected;
    const report = await rankingService.getRankingReport({
      anchor: SEED_ANCHOR,
      from: GOLDEN_CASE.from,
      to: GOLDEN_CASE.to,
    });

    expect(report.ranked[0]).toMatchObject({ code: expected.rankingTopCode, score: expected.rankingTopScore });
    expect(report.ranked.at(-1)).toMatchObject({
      code: expected.rankingBottomCode,
      score: expected.rankingBottomScore,
    });
  });

  it('matches the exact dashboard KPI values', async () => {
    const expected = GOLDEN_CASE.expected;
    const summary = await dashboardService.getDashboardSummary({ anchor: SEED_ANCHOR });

    expect(summary.kpis).toMatchObject({
      spendCents: expected.dashboardSpendCents,
      newCustomers: expected.dashboardNewCustomers,
      cacCents: expected.dashboardCacCents,
      romiPct: expected.dashboardRomiPct,
    });
  });
});

describe('CAC against direct SQL', () => {
  /**
   * @returns {Promise<Record<string, { spendCents: bigint, newCustomers: number }>>}
   */
  async function directCacInputs() {
    const { rows } = await pool.query(
      `SELECT c.id::text AS channel_id,
              (SELECT coalesce(sum(ds.spend_cents), 0)::bigint::text
                 FROM campaigns cp
                 JOIN daily_stats ds ON ds.campaign_id = cp.id
                WHERE cp.channel_id = c.id
                  AND ds.stat_date BETWEEN $1::date AND $2::date) AS spend_cents,
              (SELECT count(*)::int
                 FROM customers cu
                WHERE cu.first_channel_id = c.id
                  AND cu.first_order_at >= $3::timestamptz
                  AND cu.first_order_at <= $4::timestamptz) AS new_customers
         FROM channels c`,
      [GOLDEN_CASE.from, GOLDEN_CASE.to, minskDayStart(GOLDEN_CASE.from), minskDayEnd(GOLDEN_CASE.to)],
    );
    return Object.fromEntries(
      rows.map((row) => [
        row.channel_id,
        { spendCents: BigInt(row.spend_cents), newCustomers: row.new_customers },
      ]),
    );
  }

  it('computes Instagram and blended CAC from the same aggregates as a direct query', async () => {
    const direct = await directCacInputs();
    const report = await cacService.getCacReport({ anchor: SEED_ANCHOR });

    for (const row of report.rows) {
      const expected = direct[row.channelId];
      expect(row.spendCents).toBe(expected.spendCents.toString());
      expect(row.newCustomers).toBe(expected.newCustomers);
      const cac = divideHalfUp(expected.spendCents, expected.newCustomers);
      expect(row.cacCents).toBe(cac === null ? null : cac.toString());
    }

    const totalSpend = Object.values(direct).reduce((sum, entry) => sum + entry.spendCents, 0n);
    const totalCustomers = Object.values(direct).reduce((sum, entry) => sum + entry.newCustomers, 0);
    expect(report.blended.spendCents).toBe(totalSpend.toString());
    expect(report.blended.newCustomers).toBe(totalCustomers);
    expect(report.blended.cacCents).toBe(divideHalfUp(totalSpend, totalCustomers).toString());
  });

  it('never mixes campaigns of different channels', async () => {
    const channelReport = await cacService.getCacReport({ anchor: SEED_ANCHOR });
    const campaignReport = await cacService.getCacReport({ anchor: SEED_ANCHOR, groupBy: 'campaign' });

    const { rows } = await pool.query('SELECT id::text AS id, channel_id::text AS channel_id FROM campaigns');
    const channelByCampaign = new Map(rows.map((row) => [row.id, row.channel_id]));

    const spendByChannel = new Map();
    const customersByChannel = new Map();
    for (const campaign of campaignReport.rows) {
      const channelId = channelByCampaign.get(campaign.campaignId);
      expect(channelId).toBeDefined();
      spendByChannel.set(channelId, (spendByChannel.get(channelId) ?? 0n) + BigInt(campaign.spendCents));
      customersByChannel.set(channelId, (customersByChannel.get(channelId) ?? 0) + campaign.newCustomers);
    }

    for (const channel of channelReport.rows) {
      expect(spendByChannel.get(channel.channelId)?.toString() ?? '0').toBe(channel.spendCents);
      expect(customersByChannel.get(channel.channelId) ?? 0).toBe(channel.newCustomers);
    }
  });

  it('returns zero spend for a channel without daily stats instead of an error', async () => {
    const { rows } = await pool.query(
      `INSERT INTO channels (code, name, kind)
       VALUES ('zz_probe_empty', 'Пустой канал', 'paid')
       RETURNING id::text AS id`,
    );

    try {
      const report = await cacService.getCacReport({ anchor: SEED_ANCHOR });
      const probe = report.rows.find((row) => row.channelId === rows[0].id);

      expect(probe).toMatchObject({ spendCents: '0', newCustomers: 0, cacCents: null, status: 'no_data' });
    } finally {
      await pool.query('DELETE FROM channels WHERE id = $1::bigint', [rows[0].id]);
    }
  });

  it('marks free channels as free and keeps their zero CAC', async () => {
    const report = await cacService.getCacReport({ anchor: SEED_ANCHOR });
    for (const code of ['email', 'seo']) {
      const row = report.rows.find((entry) => entry.channelId === channelIds[code]);
      expect(row).toMatchObject({ spendCents: '0', cacCents: '0', status: 'free' });
      expect(row.newCustomers).toBeGreaterThan(0);
    }
  });
});

describe('LTV against direct SQL', () => {
  /**
   * @param {string | null} channelId `null` for the blended row.
   * @returns {Promise<{ customerCount: number, marginCents: bigint }>}
   */
  async function directCompletedLtv(channelId) {
    const anchorEnd = minskDayStart(addDays(SEED_ANCHOR, 1));
    const { rows } = await pool.query(
      `WITH cohort AS (
         SELECT c.id,
                c.first_channel_id,
                date_trunc('month', c.first_order_at AT TIME ZONE 'Europe/Minsk')::date AS cohort_month
           FROM customers c
          WHERE c.first_order_at IS NOT NULL
            AND c.first_order_at < $2::timestamptz
       ),
       completed AS (
         SELECT * FROM cohort WHERE cohort_month + interval '12 months' <= $1::date
       )
       SELECT (SELECT count(*)::int
                 FROM completed
                WHERE $3::bigint IS NULL OR first_channel_id = $3::bigint) AS customer_count,
              (SELECT coalesce(sum(o.margin_cents), 0)::bigint::text
                 FROM completed co
                 JOIN orders o ON o.customer_id = co.id
                WHERE ($3::bigint IS NULL OR co.first_channel_id = $3::bigint)
                  AND o.occurred_at >= (co.cohort_month::timestamp AT TIME ZONE 'Europe/Minsk')
                  AND o.occurred_at < $2::timestamptz
                  AND ((date_part('year', o.occurred_at AT TIME ZONE 'Europe/Minsk')
                        - date_part('year', co.cohort_month)) * 12
                       + date_part('month', o.occurred_at AT TIME ZONE 'Europe/Minsk')
                       - date_part('month', co.cohort_month)) < $4::int) AS margin_cents`,
      [SEED_ANCHOR, anchorEnd, channelId, 12],
    );
    return { customerCount: rows[0].customer_count, marginCents: BigInt(rows[0].margin_cents) };
  }

  it('averages only completed cohorts and matches a direct margin/customer aggregate', async () => {
    const report = await ltvService.getChannelLtv({ anchor: SEED_ANCHOR, horizonMonths: 12 });
    const instagram = report.rows.find((row) => row.channelCode === 'instagram');
    const direct = await directCompletedLtv(channelIds.instagram);

    expect(instagram.customerCount).toBe(direct.customerCount);
    expect(instagram.ltvCents).toBe(divideHalfUp(direct.marginCents, direct.customerCount).toString());

    const blended = await directCompletedLtv(null);
    expect(report.blended.customerCount).toBe(blended.customerCount);
    expect(report.blended.ltvCents).toBe(divideHalfUp(blended.marginCents, blended.customerCount).toString());
  });

  it('keeps old completed cohorts when the lower bound is null', async () => {
    const matrix = await ltvService.getCohortMatrix({ anchor: SEED_ANCHOR, horizonMonths: 12 });
    const report = await ltvService.getChannelLtv({ anchor: SEED_ANCHOR, horizonMonths: 12 });

    const oldest = matrix.cohorts[0];
    expect(oldest).toMatchObject({
      cohortMonth: addMonths(startOfMonth(SEED_ANCHOR), -13),
      isComplete: true,
    });
    // Two complete cohorts (Oct and Nov 2025) contribute their whole N to the channel average.
    expect(report.blended.cohortCount).toBe(2);
    expect(report.rows.find((row) => row.channelCode === 'instagram').cohortCount).toBe(2);
  });

  it('shows the anchor month as an incomplete cohort in the matrix', async () => {
    const matrix = await ltvService.getCohortMatrix({ anchor: SEED_ANCHOR, horizonMonths: 12 });
    const anchorCohort = matrix.cohorts.find((cohort) => cohort.cohortMonth === startOfMonth(SEED_ANCHOR));

    expect(anchorCohort).toBeDefined();
    expect(anchorCohort.isComplete).toBe(false);
    expect(matrix.excludedIncomplete.map((cohort) => cohort.cohortMonth)).toContain(
      startOfMonth(SEED_ANCHOR),
    );
  });

  it('ignores a fresh incomplete cohort when averaging LTV12', async () => {
    const before = await ltvService.getChannelLtv({ anchor: SEED_ANCHOR, horizonMonths: 12 });
    const orderAt = new Date(`${SEED_ANCHOR}T10:00:00+03:00`);
    const { rows: customers } = await pool.query(
      `INSERT INTO customers (external_id, first_channel_id, acquired_at, first_order_at)
       VALUES ('zz_probe_fresh_cohort', $1::bigint, $2, $2)
       RETURNING id::text AS id`,
      [channelIds.instagram, orderAt.toISOString()],
    );

    try {
      await pool.query(
        `INSERT INTO orders (external_id, customer_id, occurred_at, revenue_cents, margin_cents)
         VALUES ('zz_probe_fresh_order', $1::bigint, $2, 10000000, 7777777)`,
        [customers[0].id, orderAt.toISOString()],
      );

      const after = await ltvService.getChannelLtv({ anchor: SEED_ANCHOR, horizonMonths: 12 });
      expect(after).toEqual(before);
    } finally {
      await pool.query('DELETE FROM orders WHERE customer_id = $1::bigint', [customers[0].id]);
      await pool.query('DELETE FROM customers WHERE id = $1::bigint', [customers[0].id]);
    }
  });

  it('assigns a 00:30 Minsk order to the new month, not the UTC month', async () => {
    const { rows: channels } = await pool.query(
      `INSERT INTO channels (code, name, kind)
       VALUES ('zz_probe_minsk', 'Проверка Минска', 'paid')
       RETURNING id::text AS id`,
    );
    const channelId = channels[0].id;
    // Five months back from the anchor month: a 00:30 Minsk timestamp on the 1st is still the previous UTC day.
    const june = addMonths(startOfMonth(SEED_ANCHOR), -5);
    const may = addMonths(june, -1);
    const occurredAt = `${june}T00:30:00+03:00`;
    const { rows: customers } = await pool.query(
      `INSERT INTO customers (external_id, first_channel_id, acquired_at, first_order_at)
       VALUES ('zz_probe_minsk_customer', $1::bigint, $2, $2)
       RETURNING id::text AS id`,
      [channelId, occurredAt],
    );

    try {
      await pool.query(
        `INSERT INTO orders (external_id, customer_id, occurred_at, revenue_cents, margin_cents)
         VALUES ('zz_probe_minsk_order', $1::bigint, $2, 2000000, 1234567)`,
        [customers[0].id, occurredAt],
      );

      const juneReport = await ltvService.getCohortMatrix({
        anchor: SEED_ANCHOR,
        horizonMonths: 12,
        fromCohortMonth: june,
        toCohortMonth: june,
        channelId,
      });
      expect(juneReport.cohorts).toHaveLength(1);
      expect(juneReport.cohorts[0]).toMatchObject({
        cohortMonth: june,
        cohortSize: 1,
        ltvCents: '1234567',
        isComplete: false,
      });

      const mayReport = await ltvService.getCohortMatrix({
        anchor: SEED_ANCHOR,
        horizonMonths: 12,
        fromCohortMonth: may,
        toCohortMonth: may,
        channelId,
      });
      expect(mayReport.cohorts).toEqual([]);
    } finally {
      await pool.query('DELETE FROM orders WHERE customer_id = $1::bigint', [customers[0].id]);
      await pool.query('DELETE FROM customers WHERE id = $1::bigint', [customers[0].id]);
      await pool.query('DELETE FROM channels WHERE id = $1::bigint', [channelId]);
    }
  });
});

describe('attribution invariants', () => {
  /**
   * @param {string} from
   * @param {string} to
   * @returns {Promise<Record<string, Map<string, bigint>>>} Model → channel id → revenue.
   */
  async function reportByModel(from, to) {
    const report = await attributionService.getAttributionReport({ from, to });
    return Object.fromEntries(
      Object.entries(report.models).map(([model, view]) => [
        model,
        new Map(view.revenueByChannel.map((row) => [row.channelId, BigInt(row.revenueCents)])),
      ]),
    );
  }

  it('attributes every order kopeck under all three models', async () => {
    const { rows } = await pool.query(
      `SELECT coalesce(sum(revenue_cents), 0)::bigint::text AS revenue_cents
         FROM orders
        WHERE occurred_at >= $1::timestamptz
          AND occurred_at < $2::timestamptz`,
      [minskDayStart(GOLDEN_CASE.from), minskDayStart(addDays(GOLDEN_CASE.to, 1))],
    );
    const totalRevenue = BigInt(rows[0].revenue_cents);
    const report = await attributionService.getAttributionReport({
      from: GOLDEN_CASE.from,
      to: GOLDEN_CASE.to,
    });

    for (const model of ['last_touch', 'first_touch', 'linear']) {
      expect(sumRevenue(report.models[model].revenueByChannel)).toBe(totalRevenue);
      expect(report.models[model].totalAttributedCents).toBe(totalRevenue.toString());
      expect(report.models[model].totalRevenueCents).toBe(totalRevenue.toString());
    }
  });

  it('falls back to the acquisition channel for an order without touchpoints', async () => {
    const orderAt = `${SEED_ANCHOR}T12:00:00+03:00`;
    const baseline = await reportByModel(SEED_ANCHOR, SEED_ANCHOR);
    const { rows: customers } = await pool.query(
      `INSERT INTO customers (external_id, first_channel_id, acquired_at, first_order_at)
       VALUES ('zz_probe_no_touch', $1::bigint, $2, $2)
       RETURNING id::text AS id`,
      [channelIds.instagram, orderAt],
    );

    try {
      await pool.query(
        `INSERT INTO orders (external_id, customer_id, occurred_at, revenue_cents, margin_cents)
         VALUES ('zz_probe_no_touch_order', $1::bigint, $2, 12345, 5000)`,
        [customers[0].id, orderAt],
      );

      const after = await reportByModel(SEED_ANCHOR, SEED_ANCHOR);
      for (const model of ['last_touch', 'first_touch', 'linear']) {
        expect(after[model].get(channelIds.instagram) - baseline[model].get(channelIds.instagram)).toBe(12345n);
      }
    } finally {
      await pool.query('DELETE FROM orders WHERE customer_id = $1::bigint', [customers[0].id]);
      await pool.query('DELETE FROM customers WHERE id = $1::bigint', [customers[0].id]);
    }
  });

  it('keeps an order and touchpoint on the Minsk day boundary inside the period', async () => {
    const previousDay = addDays(SEED_ANCHOR, -1);
    // 21:00 UTC on the previous calendar day is exactly 00:00 Europe/Minsk on the anchor day.
    const boundary = `${previousDay}T21:00:00Z`;
    const baselineInside = await reportByModel(SEED_ANCHOR, SEED_ANCHOR);
    const baselineOutside = await reportByModel(previousDay, previousDay);
    const { rows: customers } = await pool.query(
      `INSERT INTO customers (external_id, first_channel_id, acquired_at, first_order_at)
       VALUES ('zz_probe_boundary', $1::bigint, $2, $2)
       RETURNING id::text AS id`,
      [channelIds.instagram, boundary],
    );

    try {
      await pool.query(
        `INSERT INTO orders (external_id, customer_id, occurred_at, revenue_cents, margin_cents)
         VALUES ('zz_probe_boundary_order', $1::bigint, $2, 22222, 11111)`,
        [customers[0].id, boundary],
      );
      await pool.query(
        `INSERT INTO touchpoints (customer_id, channel_id, occurred_at, kind)
         VALUES ($1::bigint, $2::bigint, $3, 'click')`,
        [customers[0].id, channelIds.instagram, boundary],
      );

      const inside = await reportByModel(SEED_ANCHOR, SEED_ANCHOR);
      const outside = await reportByModel(previousDay, previousDay);
      for (const model of ['last_touch', 'first_touch', 'linear']) {
        expect(inside[model].get(channelIds.instagram) - baselineInside[model].get(channelIds.instagram)).toBe(22222n);
        expect(outside[model]).toEqual(baselineOutside[model]);
      }
    } finally {
      await pool.query('DELETE FROM touchpoints WHERE customer_id = $1::bigint', [customers[0].id]);
      await pool.query('DELETE FROM orders WHERE customer_id = $1::bigint', [customers[0].id]);
      await pool.query('DELETE FROM customers WHERE id = $1::bigint', [customers[0].id]);
    }
  });
});

describe('health report', () => {
  it('gives every channel one of the four statuses and marks free channels as no_data', async () => {
    const report = await healthService.getChannelHealthReport({
      anchor: SEED_ANCHOR,
      from: GOLDEN_CASE.from,
      to: GOLDEN_CASE.to,
    });
    const allowed = new Set(['healthy', 'watch', 'risk', 'no_data']);

    expect(report.rows).toHaveLength(8);
    for (const row of report.rows) expect(allowed.has(row.status)).toBe(true);
    for (const code of ['email', 'seo']) {
      expect(report.rows.find((row) => row.code === code)).toMatchObject({
        spendCents: '0',
        cacCents: '0',
        status: 'no_data',
      });
    }
    expect(report.blended).toMatchObject({ code: 'blended', status: GOLDEN_CASE.expected.blendedHealthStatus });
  });

  it('keeps payback 12 and ratio 2.9996 out of healthy, and payback 12.004 in risk', () => {
    // Exact kopecks: nothing is rounded before the status is decided. `revenue >= spend` keeps ROMI non-negative so
    // the payback/LTV:CAC thresholds are the clauses that fire.
    expect(
      deriveHealth({
        cacCents: 12000n,
        ltv12Cents: 12000n,
        revenueCents: 100000n,
        spendCents: 100000n,
      }),
    ).toBe('watch');
    expect(
      deriveHealth({
        cacCents: 12004n,
        ltv12Cents: 12000n,
        revenueCents: 100000n,
        spendCents: 100000n,
      }),
    ).toBe('risk');
    expect(
      deriveHealth({
        cacCents: 10000n,
        ltv12Cents: 29996n,
        revenueCents: 100000n,
        spendCents: 100000n,
      }),
    ).toBe('watch');
    expect(
      deriveHealth({
        cacCents: 12000n,
        ltv12Cents: 36000n,
        revenueCents: 200000n,
        spendCents: 100000n,
      }),
    ).toBe('healthy');
  });
});

describe('ranking', () => {
  it('sums contributions into the score and excludes blended and no_data rows', async () => {
    const report = await rankingService.getRankingReport({
      anchor: SEED_ANCHOR,
      from: GOLDEN_CASE.from,
      to: GOLDEN_CASE.to,
    });
    const { weightsBasisPoints } = report;

    for (const row of report.ranked) {
      const exact = row.contributions.reduce(
        (total, contribution) =>
          total + (weightsBasisPoints[contribution.criterion] / 1000) * 100 * contribution.scored,
        0,
      );
      expect(roundNumber(exact, 2)).toBe(row.score);
      const displaySum = row.contributions.reduce((total, contribution) => total + contribution.contribution, 0);
      // Each contribution is rounded on its own before display, so the visible sum can differ by one hundredth.
      expect(Math.abs(displaySum - row.score)).toBeLessThanOrEqual(0.05);
    }

    expect(report.excluded.map((row) => [row.code, row.reason])).toEqual([
      ['email', 'no_data'],
      ['seo', 'no_data'],
      ['blended', 'blended'],
    ]);
  });

  it('puts the cheapest channel first', async () => {
    const report = await rankingService.getRankingReport({
      anchor: SEED_ANCHOR,
      from: GOLDEN_CASE.from,
      to: GOLDEN_CASE.to,
    });
    const health = await healthService.getChannelHealthReport({
      anchor: SEED_ANCHOR,
      from: GOLDEN_CASE.from,
      to: GOLDEN_CASE.to,
    });
    const rankable = health.rows.filter((row) => row.status !== 'no_data');
    const cheapest = rankable.reduce((min, row) =>
      BigInt(row.cacCents) < BigInt(min.cacCents) ? row : min,
    );

    expect(cheapest.code).toBe('instagram');
    expect(report.ranked[0]).toMatchObject({ code: cheapest.code, rank: 1 });
  });
});

describe('dashboard, passport and goals consistency', () => {
  it('copies every KPI from the blended health row', async () => {
    const summary = await dashboardService.getDashboardSummary({ anchor: SEED_ANCHOR });
    const health = await healthService.getChannelHealthReport({
      anchor: SEED_ANCHOR,
      from: GOLDEN_CASE.from,
      to: GOLDEN_CASE.to,
    });

    expect(summary.kpis.spendCents).toBe(health.blended.spendCents);
    expect(summary.kpis.spendLabel).toEqual(expect.any(String));
    expect(summary.kpis.newCustomers).toBe(health.blended.newCustomers);
    expect(summary.kpis.newCustomersLabel).toEqual(expect.any(String));
    expect(summary.kpis.cacCents).toBe(health.blended.cacCents);
    expect(summary.kpis.cacLabel).toBe(health.blended.cacLabel);
    expect(summary.kpis.romiPct).toBe(health.blended.romiPct);
    expect(summary.kpis.romiLabel).toBe(health.blended.romiLabel);
    expect(summary.verdict).toMatchObject({ status: health.blended.status, label: health.blended.statusLabel });
  });

  it('plots only complete weeks and matches the attributed total of its own window', async () => {
    const summary = await dashboardService.getDashboardSummary({ anchor: SEED_ANCHOR });
    expect(summary.weeklySeries).toHaveLength(12);
    for (const bucket of summary.weeklySeries) {
      expect(addDays(bucket.weekStart, 6) <= GOLDEN_CASE.to).toBe(true);
    }

    const firstWeekStart = summary.weeklySeries[0].weekStart;
    const series = await attributionService.getAttributionSeries({
      from: firstWeekStart,
      to: GOLDEN_CASE.to,
    });
    const report = await attributionService.getAttributionReport({
      from: firstWeekStart,
      to: GOLDEN_CASE.to,
    });
    const seriesTotal = series.reduce((total, bucket) => total + BigInt(bucket.revenueCents), 0n);

    expect(seriesTotal).toBe(BigInt(report.models.last_touch.totalAttributedCents));
  });

  it('computes the channel passport funnel from the same direct aggregates', async () => {
    const channelId = channelIds.instagram;
    const passport = await passportService.getChannelPassport({
      anchor: SEED_ANCHOR,
      channelId,
      from: GOLDEN_CASE.from,
      to: GOLDEN_CASE.to,
    });

    const { rows } = await pool.query(
      `SELECT (SELECT coalesce(sum(ds.impressions), 0)::int
                 FROM daily_stats ds
                 JOIN campaigns cp ON cp.id = ds.campaign_id
                WHERE cp.channel_id = $1::bigint
                  AND ds.stat_date BETWEEN $2::date AND $3::date) AS impressions,
              (SELECT coalesce(sum(ds.clicks), 0)::int
                 FROM daily_stats ds
                 JOIN campaigns cp ON cp.id = ds.campaign_id
                WHERE cp.channel_id = $1::bigint
                  AND ds.stat_date BETWEEN $2::date AND $3::date) AS clicks,
              (SELECT coalesce(sum(ds.leads), 0)::int
                 FROM daily_stats ds
                 JOIN campaigns cp ON cp.id = ds.campaign_id
                WHERE cp.channel_id = $1::bigint
                  AND ds.stat_date BETWEEN $2::date AND $3::date) AS leads,
              (SELECT count(*)::int
                 FROM customers cu
                WHERE cu.first_channel_id = $1::bigint
                  AND cu.first_order_at >= $4::timestamptz
                  AND cu.first_order_at <= $5::timestamptz) AS new_customers,
              (SELECT count(*)::int
                 FROM orders o
                 JOIN customers cu ON cu.id = o.customer_id
                WHERE cu.first_channel_id = $1::bigint
                  AND o.occurred_at >= $4::timestamptz
                  AND o.occurred_at <= $5::timestamptz) AS orders`,
      [
        channelId,
        GOLDEN_CASE.from,
        GOLDEN_CASE.to,
        minskDayStart(GOLDEN_CASE.from),
        minskDayEnd(GOLDEN_CASE.to),
      ],
    );

    expect(passport.funnel).toEqual({
      impressions: rows[0].impressions,
      clicks: rows[0].clicks,
      leads: rows[0].leads,
      newCustomers: rows[0].new_customers,
      orders: rows[0].orders,
    });
  });

  it('uses the channel health row as the fact of a channel goal for the same period', async () => {
    const channelId = channelIds.instagram;
    const { rows } = await pool.query(
      `INSERT INTO goals (metric, channel_id, target_value, period_start, period_end)
       VALUES ('cac', $1::bigint, 50, $2::date, $3::date)
       RETURNING id::text AS id`,
      [channelId, GOLDEN_CASE.from, GOLDEN_CASE.to],
    );

    try {
      const progress = await goalsProgressService.getGoalsProgress({
        anchor: SEED_ANCHOR,
        from: GOLDEN_CASE.from,
        to: GOLDEN_CASE.to,
      });
      const health = await healthService.getChannelHealthReport({
        anchor: SEED_ANCHOR,
        from: GOLDEN_CASE.from,
        to: GOLDEN_CASE.to,
      });
      const healthRow = health.rows.find((row) => row.channelId === channelId);
      const goal = progress.rows.find((row) => row.goalId === rows[0].id);

      expect(goal).toMatchObject({
        metric: 'cac',
        channelId,
        channelLabel: 'Instagram',
        fact: { value: healthRow.cacCents, unit: 'cents' },
      });
    } finally {
      await pool.query('DELETE FROM goals WHERE id = $1::bigint', [rows[0].id]);
    }
  });
});
