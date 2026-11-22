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
import { createChannelHealthService } from '../../src/services/metrics/romi.service.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';

/**
 * Fixed anchor so the seeded stand produces golden numbers. The default 30-day window ends on the anchor, which keeps
 * these rows comparable with the CAC and attribution integration suites.
 */
const ANCHOR = '2026-11-21';
const FROM = addDays(ANCHOR, -29);
const TO = ANCHOR;

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
/** @type {Record<string, string>} */
let channelIds;

beforeAll(async () => {
  await resetTestDatabase();
  await seed({ anchorDate: ANCHOR });
  pool = getTestPool();

  const channelsRepository = createChannelsRepository(pool);
  metricsRepository = createMetricsRepository(pool);
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

  const { rows } = await pool.query('SELECT id::text AS id, code FROM channels ORDER BY code');
  channelIds = Object.fromEntries(rows.map((row) => [row.code, row.id]));
});

afterAll(async () => {
  await closeTestPool();
});

describe('channel health against the seeded stand', () => {
  it('reports the Instagram channel with exact money, rounded display values and a healthy status', async () => {
    const report = await healthService.getChannelHealthReport({ anchor: ANCHOR, from: FROM, to: TO });

    expect(report.period).toEqual({ from: FROM, to: TO, days: 30 });
    expect(report.rows.find((row) => row.channelId === channelIds.instagram)).toEqual({
      channelId: channelIds.instagram,
      code: 'instagram',
      name: 'Instagram',
      spendCents: '295953',
      // Last-touch attributed revenue for the period, not raw order revenue.
      revenueCents: '2176622',
      newCustomers: 68,
      cacCents: '4352',
      cacLabel: '43,52',
      ltv12Cents: '14903',
      ltvLabel: '149,03',
      romiPct: 635.46,
      romiLabel: '635,46%',
      paybackMonths: 3.5,
      paybackLabel: '3,5 мес.',
      ltvCacRatio: 3.424,
      ratioLabel: '3,424',
      status: 'healthy',
      statusLabel: 'В норме',
    });
  });

  it('reports the blended row from company totals with no channelId', async () => {
    const report = await healthService.getChannelHealthReport({ anchor: ANCHOR, from: FROM, to: TO });

    expect(report.blended).toEqual({
      code: 'blended',
      name: 'Все каналы',
      spendCents: '1150770',
      revenueCents: '9356994',
      newCustomers: 263,
      cacCents: '4376',
      cacLabel: '43,76',
      ltv12Cents: '14345',
      ltvLabel: '143,45',
      romiPct: 713.11,
      romiLabel: '713,11%',
      paybackMonths: 3.66,
      paybackLabel: '3,66 мес.',
      ltvCacRatio: 3.278,
      ratioLabel: '3,278',
      status: 'healthy',
      statusLabel: 'В норме',
    });
    expect(report.blended).not.toHaveProperty('channelId');
  });

  it('keeps a channel below the ratio threshold in watch', async () => {
    const report = await healthService.getChannelHealthReport({ anchor: ANCHOR, from: FROM, to: TO });

    expect(report.rows.find((row) => row.channelId === channelIds.bloggers)).toMatchObject({
      spendCents: '90800',
      revenueCents: '607975',
      ltv12Cents: '13780',
      // 13 780 / 5 044 = 2.731959, displayed as 2,732 and never promoted to healthy.
      ltvCacRatio: 2.732,
      ratioLabel: '2,732',
      status: 'watch',
      statusLabel: 'Наблюдать',
    });
  });

  it('marks an owned channel without spend as no_data', async () => {
    const report = await healthService.getChannelHealthReport({ anchor: ANCHOR, from: FROM, to: TO });

    expect(report.rows.find((row) => row.channelId === channelIds.email)).toMatchObject({
      spendCents: '0',
      revenueCents: '919161',
      cacCents: '0',
      ltv12Cents: '12871',
      romiPct: null,
      romiLabel: '—',
      paybackMonths: 0,
      paybackLabel: '0 мес.',
      ltvCacRatio: null,
      ratioLabel: '—',
      status: 'no_data',
      statusLabel: 'Мало данных',
    });
  });

  it('reconciles every row with the CAC, LTV and attribution reports it was built from', async () => {
    const report = await healthService.getChannelHealthReport({ anchor: ANCHOR, from: FROM, to: TO });
    const cac = await cacService.getCacReport({ anchor: ANCHOR, from: FROM, to: TO });
    const ltv = await ltvService.getChannelLtv({ anchor: ANCHOR, horizonMonths: 12 });
    const attribution = await attributionService.getAttributionReport({ from: FROM, to: TO });

    expect(report.rows.map((row) => row.code)).toEqual([
      'bloggers',
      'email',
      'google',
      'instagram',
      'seo',
      'telegram',
      'tiktok',
      'yandex',
    ]);

    let attributedTotal = 0n;
    for (const row of report.rows) {
      const cacRow = cac.rows.find((entry) => entry.channelId === row.channelId);
      const ltvRow = ltv.rows.find((entry) => entry.channelId === row.channelId);
      const revenueRow = attribution.models.last_touch.revenueByChannel.find(
        (entry) => entry.channelId === row.channelId,
      );

      expect(row.spendCents).toBe(cacRow.spendCents);
      expect(row.newCustomers).toBe(cacRow.newCustomers);
      expect(row.cacCents).toBe(cacRow.cacCents);
      expect(row.revenueCents).toBe(revenueRow.revenueCents);
      expect(row.ltv12Cents).toBe(ltvRow.ltvCents);
      attributedTotal += BigInt(row.revenueCents);
    }

    expect(attributedTotal).toBe(BigInt(attribution.models.last_touch.totalAttributedCents));
    expect(report.blended).toMatchObject({
      spendCents: cac.blended.spendCents,
      newCustomers: cac.blended.newCustomers,
      cacCents: cac.blended.cacCents,
      ltv12Cents: ltv.blended.ltvCents,
      revenueCents: attribution.models.last_touch.totalAttributedCents,
    });
  });

  it('recomputes revenue and ROMI with the selected attribution model', async () => {
    const lastTouch = await healthService.getChannelHealthReport({ anchor: ANCHOR, from: FROM, to: TO });
    const linear = await healthService.getChannelHealthReport({
      anchor: ANCHOR,
      from: FROM,
      to: TO,
      attributionModel: 'linear',
    });
    const attribution = await attributionService.getAttributionReport({ from: FROM, to: TO, models: ['linear'] });

    const lastTouchRow = lastTouch.rows.find((row) => row.channelId === channelIds.instagram);
    const linearRow = linear.rows.find((row) => row.channelId === channelIds.instagram);
    const expected = attribution.models.linear.revenueByChannel.find(
      (entry) => entry.channelId === channelIds.instagram,
    );

    expect(linearRow.revenueCents).toBe(expected.revenueCents);
    expect(linearRow.revenueCents).not.toBe(lastTouchRow.revenueCents);
    expect(linearRow.romiPct).toBe(625.11);
    // Spend, CAC and LTV do not depend on the attribution model.
    expect(linearRow).toMatchObject({
      spendCents: lastTouchRow.spendCents,
      cacCents: lastTouchRow.cacCents,
      ltv12Cents: lastTouchRow.ltv12Cents,
      ltvCacRatio: lastTouchRow.ltvCacRatio,
      status: 'healthy',
    });
  });

  it('uses the default 30-day window from an explicit anchor', async () => {
    const explicit = await healthService.getChannelHealthReport({ anchor: ANCHOR });
    const defaultWindow = await cacService.getCacReport({ anchor: ANCHOR });

    expect(explicit.period).toEqual(defaultWindow.period);
    expect(explicit.period).toEqual({ from: FROM, to: TO, days: 30 });
  });

  it('reports a channel with no spend and no history as no_data, keeping revenue at a real zero', async () => {
    const { rows } = await pool.query(
      `INSERT INTO channels (code, name, kind) VALUES ('romi_empty_test', 'Пустой канал', 'paid')
       RETURNING id::text AS id`,
    );
    const channelId = rows[0].id;

    try {
      const report = await healthService.getChannelHealthReport({ anchor: ANCHOR, from: FROM, to: TO });

      expect(report.rows.find((row) => row.channelId === channelId)).toMatchObject({
        spendCents: '0',
        revenueCents: '0',
        newCustomers: 0,
        cacCents: null,
        ltv12Cents: null,
        romiPct: null,
        paybackMonths: null,
        ltvCacRatio: null,
        status: 'no_data',
      });
    } finally {
      await pool.query('DELETE FROM channels WHERE id = $1::bigint', [channelId]);
    }
  });

  it('serialises without NaN, Infinity or bigint', async () => {
    const report = await healthService.getChannelHealthReport({ anchor: ANCHOR, from: FROM, to: TO });

    expect(() => JSON.stringify(report)).not.toThrow();
    expect(JSON.stringify(report)).not.toMatch(/NaN|Infinity/);
    for (const row of [...report.rows, report.blended]) {
      for (const key of ['romiPct', 'paybackMonths', 'ltvCacRatio']) {
        expect(row[key] === null || Number.isFinite(row[key])).toBe(true);
      }
    }
  });
});
