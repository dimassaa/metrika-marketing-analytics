import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../../db/seed/seed.js';
import { addDays, minskDayStart } from '../../src/lib/dates.js';
import { createMetricsRepository } from '../../src/repositories/metrics.repo.js';
import { createCacService } from '../../src/services/metrics/cac.service.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';

/**
 * Fixed anchor instead of "yesterday": the seed is deterministic for a fixed date, so these are real golden values
 * and not a mirror of the implementation. The period is the default 30 inclusive days ending on the anchor.
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
/** @type {Record<string, string>} */
let channelIds;
/** @type {Record<string, string>} */
let campaignIds;

beforeAll(async () => {
  await resetTestDatabase();
  await seed({ anchorDate: ANCHOR });
  pool = getTestPool();
  metricsRepository = createMetricsRepository(pool);
  cacService = createCacService({ metricsRepository });

  const { rows: channels } = await pool.query('SELECT id::text AS id, code FROM channels ORDER BY code');
  channelIds = Object.fromEntries(channels.map((row) => [row.code, row.id]));
  const { rows: campaigns } = await pool.query('SELECT id::text AS id, code FROM campaigns ORDER BY code');
  campaignIds = Object.fromEntries(campaigns.map((row) => [row.code, row.id]));
});

afterAll(async () => {
  await closeTestPool();
});

describe('CAC against the seeded stand', () => {
  it('reports the Instagram channel from spend and first-touch customers', async () => {
    const report = await cacService.getCacReport({ anchor: ANCHOR, from: FROM, to: TO });

    expect(report.period).toEqual({ from: FROM, to: TO, days: 30 });
    expect(report.rows.find((row) => row.channelId === channelIds.instagram)).toMatchObject({
      key: `channel:${channelIds.instagram}`,
      label: 'Instagram',
      // 2 959,53 BYN of daily_stats spend divided by 68 customers with first_order_at in the period.
      spendCents: '295953',
      newCustomers: 68,
      cacCents: '4352',
      cacLabel: '43,52',
      status: 'ok',
    });
  });

  it('computes the blended CAC from company totals, not from per-channel averages, using the default anchor window', async () => {
    const report = await cacService.getCacReport({ anchor: ANCHOR });

    expect(report.period).toEqual({ from: FROM, to: TO, days: 30 });
    expect(report.blended).toEqual({
      spendCents: '1150770',
      newCustomers: 263,
      cacCents: '4376',
      cacLabel: '43,76',
      status: 'ok',
    });
  });

  it('attributes a campaign only to customers whose first campaign it was', async () => {
    const report = await cacService.getCacReport({ anchor: ANCHOR, from: FROM, to: TO, groupBy: 'campaign' });

    expect(report.rows.find((row) => row.campaignId === campaignIds.instagram_retarget)).toMatchObject({
      key: `campaign:${campaignIds.instagram_retarget}`,
      channelId: channelIds.instagram,
      label: 'Instagram — ретаргетинг',
      spendCents: '84785',
      newCustomers: 13,
      cacCents: '6522',
      cacLabel: '65,22',
      status: 'ok',
    });

    const filtered = await cacService.getCacReport({
      anchor: ANCHOR,
      from: FROM,
      to: TO,
      groupBy: 'campaign',
      campaignId: campaignIds.instagram_retarget,
    });
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0]).toMatchObject({
      campaignId: campaignIds.instagram_retarget,
      newCustomers: 13,
      cacCents: '6522',
    });
  });

  it('marks an owned channel with customers but no spend as free', async () => {
    const report = await cacService.getCacReport({ anchor: ANCHOR, from: FROM, to: TO });

    expect(report.rows.find((row) => row.channelId === channelIds.email)).toMatchObject({
      spendCents: '0',
      newCustomers: 18,
      cacCents: '0',
      cacLabel: '0,00',
      status: 'free',
    });
  });

  it('reports a channel without statistics as zero spend, not as missing data', async () => {
    const { rows } = await pool.query(
      `INSERT INTO channels (code, name, kind) VALUES ('empty_test', 'Пустой канал', 'paid')
       RETURNING id::text AS id`,
    );
    const channelId = rows[0].id;

    try {
      const inputs = await metricsRepository.listChannelCacInputs({ from: FROM, to: TO });
      const input = inputs.find((row) => row.channelId === channelId);
      expect(input).toMatchObject({ spendCents: 0n, newCustomers: 0 });

      const report = await cacService.getCacReport({ anchor: ANCHOR, from: FROM, to: TO });
      expect(report.rows.find((row) => row.channelId === channelId)).toMatchObject({
        spendCents: '0',
        newCustomers: 0,
        cacCents: null,
        cacLabel: '—',
        status: 'no_data',
      });
    } finally {
      await pool.query('DELETE FROM channels WHERE id = $1::bigint', [channelId]);
    }
  });

  it('counts an order at 00:30 Minsk on the day it happened, not on the previous day', async () => {
    const day = '2026-11-10';
    const previousDay = addDays(day, -1);
    const at0030 = new Date(minskDayStart(day).getTime() + 30 * 60_000);

    const before = await metricsRepository.listChannelCacInputs({ from: day, to: day });
    const beforePrevious = await metricsRepository.listChannelCacInputs({ from: previousDay, to: previousDay });

    const { rows } = await pool.query(
      `INSERT INTO customers (external_id, first_channel_id, first_campaign_id, acquired_at, first_order_at)
       VALUES ('cac_boundary_customer', $1::bigint, $2::bigint, $3::timestamptz, $3::timestamptz)
       RETURNING id::text AS id`,
      [channelIds.instagram, campaignIds.instagram_retarget, at0030],
    );

    try {
      const after = await metricsRepository.listChannelCacInputs({ from: day, to: day });
      const afterPrevious = await metricsRepository.listChannelCacInputs({
        from: previousDay,
        to: previousDay,
      });

      const customersOn = (rowsToSearch) =>
        rowsToSearch.find((row) => row.channelId === channelIds.instagram)?.newCustomers ?? 0;
      expect(customersOn(after)).toBe(customersOn(before) + 1);
      expect(customersOn(afterPrevious)).toBe(customersOn(beforePrevious));
    } finally {
      await pool.query('DELETE FROM customers WHERE id = $1::bigint', [rows[0].id]);
    }
  });

  it('returns the same spend through the standalone channel-spend query', async () => {
    const spend = await metricsRepository.listChannelSpend({ from: FROM, to: TO });

    expect(spend.find((row) => row.channelId === channelIds.instagram)).toMatchObject({
      channelCode: 'instagram',
      spendCents: 295953n,
    });
  });
});
