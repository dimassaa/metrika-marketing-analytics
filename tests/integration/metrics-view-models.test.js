import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../../db/seed/seed.js';
import { addDays, addMonths, isoWeekStart, minskDayEnd, minskDayStart, startOfMonth } from '../../src/lib/dates.js';
import { NotFoundError } from '../../src/lib/errors.js';
import { roundNumber } from '../../src/lib/metrics-math.js';
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
import { computeRomi, createChannelHealthService } from '../../src/services/metrics/romi.service.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';

/**
 * Explicit anchor, matching the CAC/attribution/ROMI integration suites so the numbers on one screen can be
 * compared with the numbers of another. The default 30-day window ends on the anchor.
 */
const ANCHOR = '2026-11-21';
const FROM = addDays(ANCHOR, -29);
const TO = ANCHOR;
/** The seeded goals cover the last twelve months, which is the only period they can be compared over. */
const GOAL_PERIOD_START = startOfMonth(addMonths(ANCHOR, -11));

/** @type {import('pg').Pool} */
let pool;
/** @type {ReturnType<typeof createMetricsRepository>} */
let metricsRepository;
/** @type {ReturnType<typeof createChannelsRepository>} */
let channelsRepository;
/** @type {ReturnType<typeof createCampaignsRepository>} */
let campaignsRepository;
/** @type {ReturnType<typeof createGoalsRepository>} */
let goalsRepository;
/** @type {ReturnType<typeof createChannelHealthService>} */
let healthService;
/** @type {ReturnType<typeof createAttributionService>} */
let attributionService;
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
  await seed({ anchorDate: ANCHOR });
  pool = getTestPool();

  channelsRepository = createChannelsRepository(pool);
  campaignsRepository = createCampaignsRepository(pool);
  goalsRepository = createGoalsRepository(pool);
  metricsRepository = createMetricsRepository(pool);
  const cacService = createCacService({ metricsRepository });
  const ltvService = createLtvService({ cohortsRepository: createCohortsRepository(pool) });
  attributionService = createAttributionService({
    attributionRepository: createAttributionRepository(pool),
    metricsRepository,
    channelsRepository,
  });
  healthService = createChannelHealthService({ cacService, ltvService, attributionService, channelsRepository });
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

describe('dashboard summary against the seeded stand', () => {
  it('copies every KPI from the blended health row of the same period', async () => {
    const summary = await dashboardService.getDashboardSummary({ anchor: ANCHOR });
    const health = await healthService.getChannelHealthReport({ anchor: ANCHOR, from: FROM, to: TO });

    expect(summary.period).toEqual({ from: FROM, to: TO, days: 30, anchor: ANCHOR });
    expect(summary.kpis).toEqual({
      spendCents: health.blended.spendCents,
      spendLabel: '11 507,70',
      newCustomers: health.blended.newCustomers,
      newCustomersLabel: '263',
      cacCents: health.blended.cacCents,
      cacLabel: health.blended.cacLabel,
      romiPct: health.blended.romiPct,
      romiLabel: health.blended.romiLabel,
    });
    expect(summary.verdict).toMatchObject({ status: health.blended.status, label: health.blended.statusLabel });
  });

  it('returns twelve complete Monday weeks whose spend matches a direct weekly SQL aggregate', async () => {
    const summary = await dashboardService.getDashboardSummary({ anchor: ANCHOR });
    const firstWeekStart = summary.weeklySeries[0].weekStart;

    const { rows } = await pool.query(
      `SELECT date_trunc('week', ds.stat_date)::date::text AS week_start,
              coalesce(sum(ds.spend_cents), 0)::bigint::text AS spend_cents
         FROM daily_stats ds
        WHERE ds.stat_date BETWEEN $1::date AND $2::date
        GROUP BY 1
        ORDER BY 1`,
      [firstWeekStart, TO],
    );
    const completeWeeks = rows.filter((row) => addDays(row.week_start, 6) <= TO);

    expect(summary.weeklySeries).toHaveLength(12);
    expect(summary.weeklySeries.map((bucket) => bucket.spendCents)).toEqual(
      completeWeeks.map((row) => row.spend_cents),
    );
    for (const bucket of summary.weeklySeries) {
      expect(bucket.weekStart).toBe(isoWeekStart(bucket.weekStart));
      expect(addDays(bucket.weekStart, 6) <= TO).toBe(true);
      expect(bucket.weekLabel).toBe(bucket.weekStart.split('-').reverse().join('.'));
    }
    const starts = summary.weeklySeries.map((bucket) => bucket.weekStart);
    expect(starts).toEqual([...starts].sort());
    // The week containing the anchor (2026-11-16) is incomplete and must not be plotted.
    expect(starts.at(-1)).toBe('2026-11-09');
  });

  it('computes weekly ROMI from attributed revenue, not from raw order revenue', async () => {
    const summary = await dashboardService.getDashboardSummary({ anchor: ANCHOR });
    const firstWeekStart = summary.weeklySeries[0].weekStart;
    const attributed = await attributionService.getAttributionSeries({ from: firstWeekStart, to: TO });
    const revenueByWeek = new Map(attributed.map((row) => [row.weekStart, BigInt(row.revenueCents)]));

    for (const bucket of summary.weeklySeries) {
      const revenueCents = revenueByWeek.get(bucket.weekStart) ?? 0n;
      const expected = roundNumber(
        computeRomi({ revenueCents, spendCents: BigInt(bucket.spendCents) }),
        2,
      );
      expect(bucket.romiPct).toBe(expected);
    }
  });

  it('serialises without a bigint', async () => {
    const summary = await dashboardService.getDashboardSummary({ anchor: ANCHOR });
    expect(() => JSON.stringify(summary)).not.toThrow();
  });
});

describe('channel passport against the seeded stand', () => {
  it('reuses the health row and computes the funnel from a single direct aggregate', async () => {
    const channelId = channelIds.instagram;
    const passport = await passportService.getChannelPassport({ anchor: ANCHOR, channelId });
    const health = await healthService.getChannelHealthReport({ anchor: ANCHOR, from: FROM, to: TO });
    const healthRow = health.rows.find((row) => row.channelId === channelId);

    expect(passport.health).toEqual(healthRow);
    expect(passport.channel).toMatchObject({
      id: channelId,
      code: 'instagram',
      name: 'Instagram',
      kind: 'paid',
      targetCacCents: '4500',
      targetRomiPct: 120,
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
                  AND cu.first_order_at BETWEEN $4::timestamptz AND $5::timestamptz) AS new_customers,
              (SELECT count(*)::int
                 FROM orders o
                 JOIN customers cu ON cu.id = o.customer_id
                WHERE cu.first_channel_id = $1::bigint
                  AND o.occurred_at BETWEEN $4::timestamptz AND $5::timestamptz) AS orders`,
      [channelId, FROM, TO, minskDayStart(FROM), minskDayEnd(TO)],
    );

    expect(passport.funnel).toEqual({
      impressions: rows[0].impressions,
      clicks: rows[0].clicks,
      leads: rows[0].leads,
      newCustomers: rows[0].new_customers,
      orders: rows[0].orders,
    });
    // The funnel narrows at every stage, so the chart cannot draw a widening shape.
    expect(passport.funnel.impressions).toBeGreaterThanOrEqual(passport.funnel.clicks);
    expect(passport.funnel.clicks).toBeGreaterThanOrEqual(passport.funnel.leads);
    expect(passport.funnel.leads).toBeGreaterThanOrEqual(passport.funnel.newCustomers);
    expect(passport.funnel.orders).toBeGreaterThanOrEqual(passport.funnel.newCustomers);
  });

  it('scopes the weekly series and campaign spend to the channel and the period', async () => {
    const channelId = channelIds.instagram;
    const passport = await passportService.getChannelPassport({ anchor: ANCHOR, channelId });
    const firstWeekStart = passport.series[0].weekStart;

    const { rows: weekly } = await pool.query(
      `SELECT date_trunc('week', ds.stat_date)::date::text AS week_start,
              coalesce(sum(ds.spend_cents), 0)::bigint::text AS spend_cents
         FROM daily_stats ds
         JOIN campaigns cp ON cp.id = ds.campaign_id
        WHERE cp.channel_id = $1::bigint
          AND ds.stat_date BETWEEN $2::date AND $3::date
        GROUP BY 1
        ORDER BY 1`,
      [channelId, firstWeekStart, TO],
    );
    const completeWeeks = new Map(
      weekly.filter((row) => addDays(row.week_start, 6) <= TO).map((row) => [row.week_start, row.spend_cents]),
    );
    for (const bucket of passport.series) {
      expect(bucket.spendCents).toBe(completeWeeks.get(bucket.weekStart) ?? '0');
    }

    const { rows: campaignSpend } = await pool.query(
      `SELECT cp.id::text AS id, coalesce(sum(ds.spend_cents), 0)::bigint::text AS spend_cents
         FROM campaigns cp
         LEFT JOIN daily_stats ds
           ON ds.campaign_id = cp.id
          AND ds.stat_date BETWEEN $2::date AND $3::date
        WHERE cp.channel_id = $1::bigint
        GROUP BY cp.id`,
      [channelId, FROM, TO],
    );
    const expectedSpend = new Map(campaignSpend.map((row) => [row.id, row.spend_cents]));

    const listed = await campaignsRepository.listCampaigns({ channelId });
    expect(passport.campaigns.map((campaign) => campaign.id)).toEqual(listed.map((campaign) => campaign.id));
    for (const campaign of passport.campaigns) {
      expect(campaign.spendCents).toBe(expectedSpend.get(campaign.id));
    }
  });

  it('rejects an unknown channel id', async () => {
    await expect(
      passportService.getChannelPassport({ anchor: ANCHOR, channelId: '9223372036854775807' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('goals progress against the seeded stand', () => {
  it('compares the seeded twelve-month goals over their own period and uses the blended fact', async () => {
    const progress = await goalsProgressService.getGoalsProgress({
      anchor: ANCHOR,
      from: GOAL_PERIOD_START,
      to: TO,
    });
    const health = await healthService.getChannelHealthReport({
      anchor: ANCHOR,
      from: GOAL_PERIOD_START,
      to: TO,
    });

    expect(progress.period).toEqual({
      from: GOAL_PERIOD_START,
      to: TO,
      days: 356,
      anchor: ANCHOR,
    });
    expect(progress.rows).toHaveLength(4);
    expect(progress.rows.every((row) => row.channelId === null)).toBe(true);

    const cac = progress.rows.find((row) => row.metric === 'cac');
    expect(cac).toMatchObject({
      metricLabel: 'CAC',
      channelLabel: 'Вся компания',
      target: { value: '5000', unit: 'cents', label: '50,00' },
      fact: { value: health.blended.cacCents, unit: 'cents', label: health.blended.cacLabel },
      direction: 'lower_is_better',
      // The status is derived from the same numbers the assertion reads; it is not a hard-coded golden value.
      status: BigInt(health.blended.cacCents) <= 5000n ? 'on_track' : 'off_track',
    });
    // The deviation is the exact kopeck gap, not a rounded float.
    expect(BigInt(cac.deviation.abs)).toBe(BigInt(health.blended.cacCents) - 5000n);

    expect(progress.rows.find((row) => row.metric === 'romi')).toMatchObject({
      fact: { value: health.blended.romiPct, unit: 'percent' },
      direction: 'higher_is_better',
    });
    expect(progress.rows.find((row) => row.metric === 'ltv_cac')).toMatchObject({
      fact: { value: health.blended.ltvCacRatio, unit: 'ratio' },
      direction: 'higher_is_better',
    });
    expect(progress.rows.find((row) => row.metric === 'payback')).toMatchObject({
      target: { value: 12, unit: 'months', label: '12 мес.' },
      fact: { value: health.blended.paybackMonths, unit: 'months' },
      direction: 'lower_is_better',
    });
  });

  it('leaves a shorter reporting period without rows instead of comparing different windows', async () => {
    const progress = await goalsProgressService.getGoalsProgress({ anchor: ANCHOR, from: FROM, to: TO });
    expect(progress.rows).toEqual([]);
  });

  it('uses the channel health row for a channel goal and matches the dashboard fact', async () => {
    const channelId = channelIds.instagram;
    const { rows } = await pool.query(
      `INSERT INTO goals (metric, channel_id, target_value, period_start, period_end)
       VALUES ('cac', $1::bigint, 50, $2::date, $3::date)
       RETURNING id::text AS id`,
      [channelId, FROM, TO],
    );

    try {
      const progress = await goalsProgressService.getGoalsProgress({ anchor: ANCHOR, from: FROM, to: TO });
      const health = await healthService.getChannelHealthReport({ anchor: ANCHOR, from: FROM, to: TO });
      const row = progress.rows.find((entry) => entry.goalId === rows[0].id);

      expect(progress.rows).toHaveLength(1);
      expect(row).toMatchObject({
        metric: 'cac',
        channelId,
        channelLabel: 'Instagram',
        fact: {
          value: health.rows.find((entry) => entry.channelId === channelId).cacCents,
          unit: 'cents',
        },
        target: { value: '5000', unit: 'cents' },
      });
    } finally {
      await pool.query('DELETE FROM goals WHERE id = $1::bigint', [rows[0].id]);
    }
  });

  it('filters by metric without a second health report', async () => {
    const progress = await goalsProgressService.getGoalsProgress({
      anchor: ANCHOR,
      from: GOAL_PERIOD_START,
      to: TO,
      metric: 'romi',
    });

    expect(progress.rows.map((row) => row.metric)).toEqual(['romi']);
  });

  it('serialises without a bigint', async () => {
    const progress = await goalsProgressService.getGoalsProgress({
      anchor: ANCHOR,
      from: GOAL_PERIOD_START,
      to: TO,
    });
    expect(() => JSON.stringify(progress)).not.toThrow();
  });
});
