import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../../db/seed/seed.js';
import { addDays, addMonths, startOfMonth } from '../../src/lib/dates.js';
import { resolvePeriod } from '../../src/lib/periods.js';
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
import { createChannelHealthService } from '../../src/services/metrics/romi.service.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { wrapDb } from '../helpers/queryCounter.js';

const SEED_ANCHOR = '2026-11-20';
const PERIOD = resolvePeriod({ anchor: SEED_ANCHOR });
const GOAL_PERIOD_START = startOfMonth(addMonths(SEED_ANCHOR, -11));

/**
 * Query ceilings measured with `wrapDb`, which counts every statement sent to PostgreSQL, including the
 * `BEGIN`/`COMMIT` around the LTV snapshot and the EXPLAIN probes.
 *
 * The plan's numbers (CAC 2, health 8, ranking 8, dashboard 11, passport 15, goals 9) assumed that
 * `getAttributionReport` performed 2 reads. It performs 4 (orders, touchpoints, channel spend, channel list), so
 * every ceiling that includes a health report is 2 higher, and the LTV snapshot adds its 2 transaction statements
 * to the LTV and all downstream ceilings. The values below are the measured flat costs, not a growth allowance:
 * the invariant is that they do not move when the number of channels grows.
 */
const BUDGETS = Object.freeze({
  cac: 2,
  ltv: 5,
  attribution: 4,
  health: 12,
  ranking: 12,
  dashboard: 15,
  passport: 19,
  goals: 13,
});

/** @type {import('pg').Pool} */
let pool;
/** @type {ReturnType<typeof wrapDb>} */
let counter;
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
/** @type {ReturnType<typeof createMetricsRepository>} */
let metricsRepository;
/** @type {Record<string, string>} */
let channelIds;

beforeAll(async () => {
  await resetTestDatabase();
  await seed({ anchorDate: SEED_ANCHOR });
  pool = getTestPool();
  counter = wrapDb(pool);

  metricsRepository = createMetricsRepository(counter.db);
  const channelsRepository = createChannelsRepository(counter.db);
  const campaignsRepository = createCampaignsRepository(counter.db);
  const goalsRepository = createGoalsRepository(counter.db);

  cacService = createCacService({ metricsRepository });
  ltvService = createLtvService({ cohortsRepository: createCohortsRepository(counter.db) });
  attributionService = createAttributionService({
    attributionRepository: createAttributionRepository(counter.db),
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
 * Runs one service call with a fresh counter.
 * @template T
 * @param {() => Promise<T>} call
 * @returns {Promise<{ result: T, queries: number }>}
 */
async function measure(call) {
  counter.reset();
  const result = await call();
  return { result, queries: counter.count() };
}

/**
 * Records the last SQL statement a repository sends. The statement and its parameters are then used for EXPLAIN,
 * so the plan belongs to the query the service really runs instead of a hand-copied duplicate.
 * @param {import('pg').Pool} target
 * @returns {{ db: { query: Function }, last: () => { text: string, params: unknown[] } | null }}
 */
function captureDatabase(target) {
  /** @type {{ text: string, params: unknown[] } | null} */
  let last = null;
  return {
    db: {
      async query(text, params) {
        last = { text, params };
        return target.query(text, params);
      },
    },
    last: () => last,
  };
}

/**
 * @param {unknown} node
 * @param {Set<string>} names
 * @returns {Set<string>}
 */
function collectIndexNames(node, names = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectIndexNames(item, names);
    return names;
  }
  if (!node || typeof node !== 'object') return names;
  if (typeof node['Index Name'] === 'string') names.add(node['Index Name']);
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') collectIndexNames(value, names);
  }
  return names;
}

/**
 * Explains one captured statement on a dedicated client with `enable_seqscan` disabled in the same transaction.
 * The settings are `SET LOCAL`, so they disappear with the rollback and cannot leak into another test.
 * @param {{ text: string, params: unknown[] }} captured
 * @returns {Promise<Set<string>>}
 */
async function explainIndexes(captured) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query(
      `EXPLAIN (FORMAT JSON, COSTS OFF) ${captured.text}`,
      captured.params,
    );
    await client.query('ROLLBACK');

    const raw = rows[0]['QUERY PLAN'];
    return collectIndexNames(typeof raw === 'string' ? JSON.parse(raw) : raw);
  } finally {
    client.release();
  }
}

describe('query budgets per service call', () => {
  it('CAC channel report stays within two reads', async () => {
    const { queries } = await measure(() => cacService.getCacReport({ anchor: SEED_ANCHOR }));
    expect(queries).toBe(BUDGETS.cac);
  });

  it('LTV reads its cohort snapshot in a fixed number of statements', async () => {
    const { queries } = await measure(() => ltvService.getChannelLtv({ anchor: SEED_ANCHOR }));
    expect(queries).toBe(BUDGETS.ltv);
  });

  it('attribution loads orders, touchpoints, spend and channels once', async () => {
    const { queries } = await measure(() =>
      attributionService.getAttributionReport({ from: PERIOD.from, to: PERIOD.to }),
    );
    expect(queries).toBe(BUDGETS.attribution);
  });

  it('health report does not add a query per channel', async () => {
    const { queries } = await measure(() => healthService.getChannelHealthReport({ anchor: SEED_ANCHOR }));
    expect(queries).toBe(BUDGETS.health);
  });

  it('ranking adds no SQL on top of the health report', async () => {
    const health = await measure(() => healthService.getChannelHealthReport({ anchor: SEED_ANCHOR }));
    const ranking = await measure(() => rankingService.getRankingReport({ anchor: SEED_ANCHOR }));

    expect(ranking.queries).toBe(BUDGETS.ranking);
    expect(ranking.queries).toBe(health.queries);
  });

  it('dashboard adds the weekly spend and attributed series on top of health', async () => {
    const health = await measure(() => healthService.getChannelHealthReport({ anchor: SEED_ANCHOR }));
    const dashboard = await measure(() => dashboardService.getDashboardSummary({ anchor: SEED_ANCHOR }));

    expect(dashboard.queries).toBe(BUDGETS.dashboard);
    // 1 weekly series + 2 attribution reads; the attributed series reuses no health data.
    expect(dashboard.queries).toBe(health.queries + 3);
  });

  it('passport adds its own channel, series, funnel and campaign reads once', async () => {
    const health = await measure(() => healthService.getChannelHealthReport({ anchor: SEED_ANCHOR }));
    const passport = await measure(() =>
      passportService.getChannelPassport({ anchor: SEED_ANCHOR, channelId: channelIds.instagram }),
    );

    expect(passport.queries).toBe(BUDGETS.passport);
    // channel + weekly series + 2 attribution reads + funnel + campaigns + campaign CAC inputs
    expect(passport.queries).toBe(health.queries + 7);
  });

  it('goals progress reads the goal list once and the health report once', async () => {
    const health = await measure(() => healthService.getChannelHealthReport({ anchor: SEED_ANCHOR }));
    const goals = await measure(() =>
      goalsProgressService.getGoalsProgress({
        anchor: SEED_ANCHOR,
        from: GOAL_PERIOD_START,
        to: SEED_ANCHOR,
      }),
    );

    expect(goals.queries).toBe(BUDGETS.goals);
    expect(goals.queries).toBe(health.queries + 1);
  });
});

describe('index usage', () => {
  it('cohort margins of one channel use orders_customer_idx', async () => {
    const capture = captureDatabase(pool);
    const repository = createCohortsRepository(capture.db);
    await repository.listCohortMonthlyMargins({
      fromCohortMonth: null,
      toCohortMonth: startOfMonth(SEED_ANCHOR),
      channelId: channelIds.instagram,
      anchor: SEED_ANCHOR,
    });

    const indexes = await explainIndexes(capture.last());
    expect(indexes).toContain('orders_customer_idx');
  });

  it('the touchpoint window uses touchpoints_time_idx', async () => {
    const capture = captureDatabase(pool);
    const repository = createAttributionRepository(capture.db);
    await repository.listTouchpointsForOrders({ from: PERIOD.from, to: PERIOD.to });

    const indexes = await explainIndexes(capture.last());
    expect(indexes).toContain('touchpoints_time_idx');
  });

  it('the weekly series uses daily_stats_date_idx', async () => {
    const capture = captureDatabase(pool);
    const repository = createMetricsRepository(capture.db);
    await repository.listWeeklySeries({ from: addDays(PERIOD.to, -83), to: PERIOD.to });

    const indexes = await explainIndexes(capture.last());
    expect(indexes).toContain('daily_stats_date_idx');
  });

  it('the company-wide CAC inputs scan customers by first order date', async () => {
    const capture = captureDatabase(pool);
    const repository = createMetricsRepository(capture.db);
    await repository.listChannelCacInputs({ from: PERIOD.from, to: PERIOD.to });

    // The company-wide aggregate reads every channel, so the planner prefers the narrower first_order_at index.
    // The composite from migration 004 exists for the per-channel read, asserted below.
    const indexes = await explainIndexes(capture.last());
    expect(indexes).toContain('customers_first_order_idx');
  });

  it('the channel-scoped customer read uses customers_channel_first_order_idx', async () => {
    const capture = captureDatabase(pool);
    const repository = createMetricsRepository(capture.db);
    await repository.getChannelFunnel({
      from: PERIOD.from,
      to: PERIOD.to,
      channelId: channelIds.instagram,
    });

    const indexes = await explainIndexes(capture.last());
    expect(indexes).toContain('customers_channel_first_order_idx');
  });
});

describe('query count does not grow with the channel count', () => {
  /** @type {{ health: number, ranking: number, dashboard: number } | null} */
  let eightChannels = null;
  let instagramId;

  beforeAll(async () => {
    eightChannels = {
      health: (await measure(() => healthService.getChannelHealthReport({ anchor: SEED_ANCHOR }))).queries,
      ranking: (await measure(() => rankingService.getRankingReport({ anchor: SEED_ANCHOR }))).queries,
      dashboard: (await measure(() => dashboardService.getDashboardSummary({ anchor: SEED_ANCHOR }))).queries,
    };
    instagramId = channelIds.instagram;

    // Reduce the stand to one channel in dependency order. Foreign keys are RESTRICT, so references to the
    // channels/campaigns being removed are cleared before the dimension rows go away.
    await pool.query('BEGIN');
    try {
      await pool.query(
        'DELETE FROM orders WHERE customer_id IN (SELECT id FROM customers WHERE first_channel_id <> $1::bigint)',
        [instagramId],
      );
      await pool.query(
        'DELETE FROM touchpoints WHERE customer_id IN (SELECT id FROM customers WHERE first_channel_id <> $1::bigint)',
        [instagramId],
      );
      await pool.query('DELETE FROM touchpoints WHERE channel_id <> $1::bigint', [instagramId]);
      await pool.query('DELETE FROM customers WHERE first_channel_id <> $1::bigint', [instagramId]);
      await pool.query(
        `UPDATE customers SET first_campaign_id = NULL
          WHERE first_channel_id = $1::bigint
            AND first_campaign_id IN (SELECT id FROM campaigns WHERE channel_id <> $1::bigint)`,
        [instagramId],
      );
      await pool.query(
        `UPDATE orders SET campaign_id = NULL
          WHERE campaign_id IN (SELECT id FROM campaigns WHERE channel_id <> $1::bigint)`,
        [instagramId],
      );
      await pool.query(
        `UPDATE touchpoints SET campaign_id = NULL
          WHERE campaign_id IN (SELECT id FROM campaigns WHERE channel_id <> $1::bigint)`,
        [instagramId],
      );
      await pool.query(
        'DELETE FROM daily_stats WHERE campaign_id IN (SELECT id FROM campaigns WHERE channel_id <> $1::bigint)',
        [instagramId],
      );
      await pool.query('DELETE FROM campaigns WHERE channel_id <> $1::bigint', [instagramId]);
      await pool.query('DELETE FROM channels WHERE id <> $1::bigint', [instagramId]);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  });

  afterAll(async () => {
    // Restore the stand so a watch-mode rerun of this file starts from the same data.
    await seed({ anchorDate: SEED_ANCHOR });
  });

  it('keeps the health, ranking and dashboard budgets flat', async () => {
    expect(eightChannels).not.toBeNull();
    const health = await measure(() => healthService.getChannelHealthReport({ anchor: SEED_ANCHOR }));
    const ranking = await measure(() => rankingService.getRankingReport({ anchor: SEED_ANCHOR }));
    const dashboard = await measure(() => dashboardService.getDashboardSummary({ anchor: SEED_ANCHOR }));

    expect(health.queries).toBe(eightChannels.health);
    expect(ranking.queries).toBe(eightChannels.ranking);
    expect(dashboard.queries).toBe(eightChannels.dashboard);
  });
});
