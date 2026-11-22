import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../../db/seed/seed.js';
import { addDays } from '../../src/lib/dates.js';
import { createAttributionRepository } from '../../src/repositories/attribution.repo.js';
import { createChannelsRepository } from '../../src/repositories/channels.repo.js';
import { createCohortsRepository } from '../../src/repositories/cohorts.repo.js';
import { createMetricsRepository } from '../../src/repositories/metrics.repo.js';
import { createAttributionService } from '../../src/services/metrics/attribution.service.js';
import { createCacService } from '../../src/services/metrics/cac.service.js';
import { createLtvService } from '../../src/services/metrics/ltv.service.js';
import { createRankingService } from '../../src/services/metrics/ranking.service.js';
import { createChannelHealthService } from '../../src/services/metrics/romi.service.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';

/** Same anchor and window as the CAC, attribution and health suites, so the golden numbers stay comparable. */
const ANCHOR = '2026-11-21';
const FROM = addDays(ANCHOR, -29);
const TO = ANCHOR;

/** @type {import('pg').Pool} */
let pool;
/** @type {ReturnType<typeof createRankingService>} */
let rankingService;
/** @type {Record<string, string>} */
let channelIds;

beforeAll(async () => {
  await resetTestDatabase();
  await seed({ anchorDate: ANCHOR });
  pool = getTestPool();

  const channelsRepository = createChannelsRepository(pool);
  const metricsRepository = createMetricsRepository(pool);
  const healthService = createChannelHealthService({
    cacService: createCacService({ metricsRepository }),
    ltvService: createLtvService({ cohortsRepository: createCohortsRepository(pool) }),
    attributionService: createAttributionService({
      attributionRepository: createAttributionRepository(pool),
      metricsRepository,
      channelsRepository,
    }),
    channelsRepository,
  });
  rankingService = createRankingService({ healthService });

  const { rows } = await pool.query('SELECT id::text AS id, code FROM channels ORDER BY code');
  channelIds = Object.fromEntries(rows.map((row) => [row.code, row.id]));
});

afterAll(async () => {
  await closeTestPool();
});

describe('channel ranking against the seeded stand', () => {
  it('ranks the seeded channels by the default weights, with Instagram first', async () => {
    const report = await rankingService.getRankingReport({ anchor: ANCHOR, from: FROM, to: TO });

    expect(report.period).toEqual({ from: FROM, to: TO, days: 30 });
    expect(report.weights).toEqual({ cac: 0.3, romi: 0.3, ltvCac: 0.25, newCustomers: 0.15 });
    expect(report.weightsBasisPoints).toEqual({ cac: 300, romi: 300, ltvCac: 250, newCustomers: 150 });
    expect(report.ranked.map((row) => [row.rank, row.code])).toEqual([
      [1, 'instagram'],
      [2, 'telegram'],
      [3, 'google'],
      [4, 'bloggers'],
      [5, 'yandex'],
      [6, 'tiktok'],
    ]);
    // Scores are strictly descending; no tie-break is doing the work in this fixture.
    const scores = report.ranked.map((row) => row.score);
    expect([...scores].sort((left, right) => right - left)).toEqual(scores);
  });

  it('gives cheap traffic more CAC points than expensive traffic and puts Instagram above TikTok', async () => {
    const report = await rankingService.getRankingReport({ anchor: ANCHOR, from: FROM, to: TO });
    const instagram = report.ranked.find((row) => row.code === 'instagram');
    const tiktok = report.ranked.find((row) => row.code === 'tiktok');

    expect(instagram.rank).toBe(1);
    expect(tiktok.rank).toBe(6);
    expect(instagram.score).toBeGreaterThan(tiktok.score);

    // Instagram has the cheapest CAC of the stand and TikTok the most expensive one: the scored value is inverted
    // relative to the raw normalisation, which is exactly the bug the sign test protects against.
    const instagramCac = instagram.contributions.find((entry) => entry.criterion === 'cac');
    const tiktokCac = tiktok.contributions.find((entry) => entry.criterion === 'cac');
    expect(instagramCac).toMatchObject({ rawValue: '4352', normalized: 0, scored: 1, contribution: 30 });
    expect(tiktokCac).toMatchObject({ rawValue: '5871', normalized: 1, scored: 0, contribution: 0 });
  });

  it('explains every contribution and totals to the score within display rounding', async () => {
    const report = await rankingService.getRankingReport({ anchor: ANCHOR, from: FROM, to: TO });
    const instagram = report.ranked[0];

    expect(instagram.contributions.map((entry) => entry.criterion)).toEqual([
      'cac',
      'romi',
      'ltvCac',
      'newCustomers',
    ]);
    expect(instagram.contributions.map((entry) => entry.rawValue)).toEqual(['4352', 635.46, 3.424, 68]);
    for (const row of report.ranked) {
      const sum = row.contributions.reduce((total, entry) => total + entry.contribution, 0);
      // Four independently rounded display terms can drift from the once-rounded score by up to 0.02.
      expect(Math.abs(sum - row.score)).toBeLessThanOrEqual(0.02 + 1e-9);
    }
  });

  it('lists no_data channels and the blended row as not ranked', async () => {
    const report = await rankingService.getRankingReport({ anchor: ANCHOR, from: FROM, to: TO });

    expect(report.excluded).toEqual([
      { channelId: channelIds.email, code: 'email', reason: 'no_data', reasonLabel: 'Мало данных' },
      { channelId: channelIds.seo, code: 'seo', reason: 'no_data', reasonLabel: 'Мало данных' },
      { code: 'blended', reason: 'blended', reasonLabel: 'Сводная строка' },
    ]);
    expect(report.ranked.map((row) => row.code)).not.toContain('email');
    expect(report.ranked.map((row) => row.code)).not.toContain('blended');
  });

  it('changes the order when the weights favour another criterion', async () => {
    const byRomi = await rankingService.getRankingReport({
      anchor: ANCHOR,
      from: FROM,
      to: TO,
      weights: { cac: 0, romi: 1, ltvCac: 0, newCustomers: 0 },
    });

    expect(byRomi.weights).toEqual({ cac: 0, romi: 1, ltvCac: 0, newCustomers: 0 });
    expect(byRomi.weights.cac + byRomi.weights.romi + byRomi.weights.ltvCac + byRomi.weights.newCustomers).toBeCloseTo(
      1,
      12,
    );
    expect(byRomi.weightsBasisPoints).toEqual({ cac: 0, romi: 1000, ltvCac: 0, newCustomers: 0 });
    for (const entry of byRomi.ranked[0].contributions) {
      // The reported weights are the scored weights: no second rounding pass may shift them.
      expect(entry.weight).toBe(byRomi.weights[entry.criterion]);
    }
    expect(byRomi.ranked.map((row) => row.code)).toEqual([
      'telegram',
      'instagram',
      'bloggers',
      'tiktok',
      'yandex',
      'google',
    ]);
    expect(byRomi.ranked[0]).toMatchObject({ code: 'telegram', score: 100 });
    expect(byRomi.ranked.at(-1)).toMatchObject({ code: 'google', score: 0 });
  });

  it('serialises without NaN, Infinity or bigint', async () => {
    const report = await rankingService.getRankingReport({ anchor: ANCHOR, from: FROM, to: TO });

    expect(() => JSON.stringify(report)).not.toThrow();
    expect(JSON.stringify(report)).not.toMatch(/NaN|Infinity/);
    for (const row of report.ranked) {
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(100);
      for (const entry of row.contributions) {
        expect(Number.isFinite(entry.contribution)).toBe(true);
        expect(Number.isFinite(entry.normalized)).toBe(true);
        expect(Number.isFinite(entry.scored)).toBe(true);
      }
    }
  });

  it('rejects invalid weights before running the health report', async () => {
    let called = false;
    const spyService = createRankingService({
      healthService: {
        async getChannelHealthReport() {
          called = true;
          throw new Error('health report must not run');
        },
      },
    });

    await expect(
      spyService.getRankingReport({ anchor: ANCHOR, weights: { cac: -1, romi: 1, ltvCac: 1, newCustomers: 1 } }),
    ).rejects.toThrow('Вес критерия «cac» не может быть отрицательным');
    expect(called).toBe(false);
  });
});
