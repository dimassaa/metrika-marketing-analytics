import { describe, expect, it, vi } from 'vitest';
import { addDays } from '../../src/lib/dates.js';
import { createChannelListService } from '../../src/services/metrics/channel-list.service.js';
import { resolveWeekRange } from '../../src/services/metrics/weekly-series.js';
import { METRICS_CONFIG } from '../../src/config/metrics.js';

const PERIOD = { from: '2026-10-23', to: '2026-11-21', days: 30 };

/**
 * @param {object} [overrides]
 * @returns {object} A complete health row.
 */
function healthRow(overrides = {}) {
  return {
    channelId: '1',
    code: 'alpha',
    name: 'Alpha',
    spendCents: '100000',
    revenueCents: '200000',
    newCustomers: 10,
    cacCents: '10000',
    cacLabel: '100,00',
    ltv12Cents: '150000',
    ltvLabel: '1 500,00',
    romiPct: 100,
    romiLabel: '+100,0%',
    paybackMonths: 8,
    paybackLabel: '8 мес.',
    ltvCacRatio: 2,
    ratioLabel: '2,000',
    status: 'healthy',
    statusLabel: 'В норме',
    ...overrides,
  };
}

/** @returns {object[]} Six rankable channels and two `no_data` channels. */
function eightRows() {
  return [
    healthRow({ channelId: '1', code: 'instagram', name: 'Instagram', cacCents: '4000', romiPct: 300 }),
    healthRow({ channelId: '2', code: 'google', name: 'Google Ads', cacCents: '6000', romiPct: 180 }),
    healthRow({ channelId: '3', code: 'yandex', name: 'Яндекс', cacCents: '7000', romiPct: 150 }),
    healthRow({ channelId: '4', code: 'tiktok', name: 'TikTok', cacCents: '12000', romiPct: 40, status: 'risk', statusLabel: 'Риск' }),
    healthRow({ channelId: '5', code: 'telegram', name: 'Telegram', cacCents: '5000', romiPct: 220 }),
    healthRow({ channelId: '6', code: 'bloggers', name: 'Блогеры', cacCents: '15000', romiPct: 20, status: 'watch', statusLabel: 'Наблюдать' }),
    healthRow({
      channelId: '7',
      code: 'email',
      name: 'Email',
      spendCents: '0',
      revenueCents: '0',
      newCustomers: 5,
      cacCents: '0',
      romiPct: null,
      ltv12Cents: null,
      paybackMonths: null,
      ltvCacRatio: null,
      status: 'no_data',
      statusLabel: 'Мало данных',
    }),
    healthRow({
      channelId: '8',
      code: 'seo',
      name: 'SEO',
      spendCents: '0',
      revenueCents: '0',
      newCustomers: 4,
      cacCents: '0',
      romiPct: null,
      ltv12Cents: null,
      paybackMonths: null,
      ltvCacRatio: null,
      status: 'no_data',
      statusLabel: 'Мало данных',
    }),
  ];
}

/** @returns {object[]} M2 channel metadata for the same ids. */
function metaRows() {
  const kinds = ['paid', 'paid', 'paid', 'paid', 'paid', 'paid', 'owned', 'earned'];
  return eightRows().map((row, index) => ({
    id: row.channelId,
    code: row.code,
    name: row.name,
    kind: kinds[index],
    isActive: row.code !== 'tiktok',
  }));
}

/** @param {object[]} rows @param {object[]} [meta] */
function makeService(rows, meta = metaRows()) {
  const blended = healthRow({
    code: 'blended',
    name: 'Все каналы',
    channelId: undefined,
    spendCents: '500000',
    revenueCents: '1000000',
    newCustomers: 40,
    cacCents: '12500',
    romiPct: 100,
  });
  delete blended.channelId;

  const first = resolveWeekRange(PERIOD.to, METRICS_CONFIG.dashboard.weeks).firstWeekStart;
  const healthService = {
    getChannelHealthReport: vi.fn(async () => ({
      period: PERIOD,
      rows,
      blended,
      availableChannels: rows.map((row) => ({
        channelId: row.channelId,
        code: row.code,
        name: row.name,
      })),
    })),
  };
  const metricsRepository = {
    listChannelWeeklyCacInputs: vi.fn(async () => [
      { channelId: rows[0]?.channelId ?? '1', weekStart: first, spendCents: 1000n, newCustomers: 1 },
      { channelId: rows[0]?.channelId ?? '1', weekStart: addDays(first, 7), spendCents: 500n, newCustomers: 0 },
    ]),
  };
  const channelsRepository = {
    listChannels: vi.fn(async () => meta),
  };

  return {
    service: createChannelListService({ healthService, metricsRepository, channelsRepository }),
    healthService,
    metricsRepository,
    channelsRepository,
  };
}

describe('channel list service', () => {
  it('runs the health report once for eight channels and fills kind/isActive from one M2 read', async () => {
    const rows = eightRows();
    const { service, healthService, channelsRepository, metricsRepository } = makeService(rows);

    const list = await service.getChannelList({ anchor: '2026-11-21' });

    expect(healthService.getChannelHealthReport).toHaveBeenCalledTimes(1);
    expect(channelsRepository.listChannels).toHaveBeenCalledTimes(1);
    expect(metricsRepository.listChannelWeeklyCacInputs).toHaveBeenCalledTimes(1);
    expect(list.rows).toHaveLength(8);
    expect(list.rows.find((row) => row.code === 'instagram')).toMatchObject({
      kind: 'paid',
      isActive: true,
      kindLabel: 'Платный',
    });
    expect(list.rows.find((row) => row.code === 'email')).toMatchObject({ kind: 'owned', isActive: true });
    expect(list.weightsBasisPoints).toEqual({ cac: 300, romi: 300, ltvCac: 250, newCustomers: 150 });
  });

  it('keeps no_data rows in the table with null rank/score and explains them in excluded', async () => {
    const { service } = makeService(eightRows());

    const list = await service.getChannelList({ anchor: '2026-11-21' });
    const email = list.rows.find((row) => row.code === 'email');

    expect(email).toMatchObject({ rank: null, score: null, status: 'no_data' });
    expect(email.contributions).toEqual([]);
    expect(email.stack).toEqual([]);
    expect(list.excluded).toContainEqual({
      channelId: '7',
      code: 'email',
      name: 'Email',
      reason: 'no_data',
      reasonLabel: 'Мало данных',
    });
    expect(list.excluded.at(-1)).toMatchObject({ code: 'blended', reason: 'blended' });
    expect(list.rows.some((row) => row.code === 'blended')).toBe(false);
  });

  it('does not change ranks when a status filter hides rows', async () => {
    const { service } = makeService(eightRows());
    const all = await service.getChannelList({ anchor: '2026-11-21' });
    const archived = await service.getChannelList({ anchor: '2026-11-21', status: 'archived' });

    const rankByCode = new Map(all.rows.map((row) => [row.code, row.rank]));
    expect(archived.rows.map((row) => row.code)).toEqual(['tiktok']);
    expect(archived.rows[0].rank).toBe(rankByCode.get('tiktok'));
    // Every row removed from the table was active; the archived one keeps its earned rank.
    expect(archived.rows.length).toBeLessThan(all.rows.length);
  });

  it('builds twelve weekly sparkline points and keeps a gap for a week without customers', async () => {
    const { service } = makeService(eightRows());

    const list = await service.getChannelList({ anchor: '2026-11-21' });
    const sparkline = list.sparklines['1'];

    expect(sparkline).toHaveLength(12);
    expect(sparkline[0].value).toBe(1000);
    expect(sparkline[1].value).toBeNull();
    expect(sparkline.every((point) => typeof point.weekLabel === 'string')).toBe(true);
    expect(Object.keys(list.sparklines)).toHaveLength(8);
  });

  it('applies custom weights to the ranking without a second health call', async () => {
    const rows = [
      healthRow({ channelId: '1', code: 'cheap', cacCents: '100', romiPct: 10 }),
      healthRow({ channelId: '2', code: 'romantic', cacCents: '1000', romiPct: 200 }),
    ];
    const { service, healthService } = makeService(rows, [
      { id: '1', code: 'cheap', name: 'Alpha', kind: 'paid', isActive: true },
      { id: '2', code: 'romantic', name: 'Beta', kind: 'paid', isActive: true },
    ]);

    const byDefault = await service.getChannelList({ anchor: '2026-11-21' });
    const byRomi = await service.getChannelList({
      anchor: '2026-11-21',
      weights: { cac: 0, romi: 1, ltvCac: 0, newCustomers: 0 },
    });

    expect(byDefault.rows[0].code).toBe('cheap');
    expect(byRomi.rows[0].code).toBe('romantic');
    expect(byRomi.weights).toEqual({ cac: 0, romi: 1, ltvCac: 0, newCustomers: 0 });
    expect(byRomi.weightsBasisPoints).toEqual({ cac: 0, romi: 1000, ltvCac: 0, newCustomers: 0 });
    expect(healthService.getChannelHealthReport).toHaveBeenCalledTimes(2);
  });

  it('runs one health report when the report has a single channel', async () => {
    const rows = [eightRows()[0]];
    const { service, healthService } = makeService(rows, [
      { id: '1', code: 'instagram', name: 'Instagram', kind: 'paid', isActive: true },
    ]);

    const list = await service.getChannelList({ anchor: '2026-11-21' });

    expect(healthService.getChannelHealthReport).toHaveBeenCalledTimes(1);
    expect(list.rows).toHaveLength(1);
  });

  it('rejects an unknown filter instead of returning a wider report', async () => {
    const { service } = makeService(eightRows());

    await expect(service.getChannelList({ anchor: '2026-11-21', status: 'bogus' })).rejects.toThrow(
      'Неизвестный фильтр статуса',
    );
    await expect(service.getChannelList({ anchor: '2026-11-21', kind: 'bogus' })).rejects.toThrow(
      'Неизвестный фильтр типа',
    );
  });
});
