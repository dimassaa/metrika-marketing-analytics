import { describe, expect, it, vi } from 'vitest';
import { addDays, formatDateRu, isoWeekStart } from '../../src/lib/dates.js';
import { NotFoundError, ValidationError } from '../../src/lib/errors.js';
import { CAMPAIGN_LIST_LIMIT } from '../../src/repositories/campaigns.repo.js';
import { createChannelPassportService } from '../../src/services/metrics/channel-passport.service.js';

const ANCHOR = '2026-11-21';
const PERIOD = { from: '2026-10-23', to: '2026-11-21', days: 30 };
const LAST_WEEK = '2026-11-09';
const FIRST_WEEK = addDays(LAST_WEEK, -7 * 11);

const CHANNEL = {
  id: '4',
  code: 'instagram',
  name: 'Instagram',
  kind: 'paid',
  isActive: true,
  targetCacCents: 4500n,
  targetRomiPct: '120.00',
  createdAt: null,
  campaignCount: 4,
  activeCampaignCount: 4,
};

const HEALTH_ROW = {
  channelId: '4',
  code: 'instagram',
  name: 'Instagram',
  spendCents: '295953',
  revenueCents: '2176622',
  newCustomers: 68,
  cacCents: '4352',
  cacLabel: '43,52',
  ltv12Cents: '14903',
  ltvLabel: '149,03',
  romiPct: 635.46,
  romiLabel: '+635,5%',
  paybackMonths: 3.5,
  paybackLabel: '3,5 мес.',
  ltvCacRatio: 3.424,
  ratioLabel: '3,424',
  status: 'healthy',
  statusLabel: 'В норме',
};

/**
 * @param {unknown} value
 * @returns {boolean} True when a `bigint` sits anywhere in the value.
 */
function hasBigInt(value) {
  if (typeof value === 'bigint') return true;
  if (Array.isArray(value)) return value.some(hasBigInt);
  if (value !== null && typeof value === 'object') return Object.values(value).some(hasBigInt);
  return false;
}

/**
 * @param {object} [overrides]
 * @returns {{
 *   service: ReturnType<typeof createChannelPassportService>,
 *   healthService: object,
 *   metricsRepository: object,
 *   attributionService: object,
 *   channelsRepository: object,
 *   campaignsRepository: object,
 * }}
 */
function serviceWith({
  channel = CHANNEL,
  healthRow = HEALTH_ROW,
  weeklyRows = [{ weekStart: LAST_WEEK, spendCents: 100000n, newCustomers: 10 }],
  attributedRows = [{ weekStart: LAST_WEEK, revenueCents: '150000' }],
  funnel = { impressions: 120000, clicks: 3200, leads: 160, newCustomers: 10, orders: 14 },
  campaignRows = [
    { id: '41', channelId: '4', code: 'ig_warm', name: 'Instagram тёплый', status: 'active', spendCents: 999999n },
    { id: '42', channelId: '4', code: 'ig_cold', name: 'Instagram холодный', status: 'paused', spendCents: 5n },
  ],
  campaignCacRows = [
    { campaignId: '41', channelId: '4', campaignCode: 'ig_warm', campaignName: 'Instagram тёплый', spendCents: 60000n, newCustomers: 6 },
  ],
} = {}) {
  const healthService = {
    getChannelHealthReport: vi.fn().mockResolvedValue({
      period: { ...PERIOD },
      rows: healthRow === null ? [] : [healthRow],
      blended: { ...HEALTH_ROW, code: 'blended', name: 'Все каналы', newCustomers: 263 },
    }),
  };
  const metricsRepository = {
    listWeeklySeries: vi.fn().mockResolvedValue(weeklyRows),
    getChannelFunnel: vi.fn().mockResolvedValue(funnel),
    listCampaignCacInputs: vi.fn().mockResolvedValue(campaignCacRows),
  };
  const attributionService = {
    getAttributionSeries: vi.fn().mockResolvedValue(attributedRows),
  };
  const channelsRepository = {
    findChannelById: vi.fn().mockResolvedValue(channel),
  };
  const campaignsRepository = {
    listCampaigns: vi.fn().mockResolvedValue(campaignRows),
  };

  return {
    service: createChannelPassportService({
      healthService,
      metricsRepository,
      attributionService,
      channelsRepository,
      campaignsRepository,
    }),
    healthService,
    metricsRepository,
    attributionService,
    channelsRepository,
    campaignsRepository,
  };
}

describe('channel passport', () => {
  it('describes the channel with money strings and a numeric ROMI target', async () => {
    const { service } = serviceWith();

    const passport = await service.getChannelPassport({ anchor: ANCHOR, channelId: '4' });

    expect(passport.channel).toEqual({
      id: '4',
      code: 'instagram',
      name: 'Instagram',
      kind: 'paid',
      targetCacCents: '4500',
      targetRomiPct: 120,
    });
    expect(passport.period).toEqual({ from: PERIOD.from, to: PERIOD.to, days: 30, anchor: ANCHOR });
  });

  it('reuses the health row for the channel instead of recomputing it', async () => {
    const { service, healthService } = serviceWith();

    const passport = await service.getChannelPassport({ anchor: ANCHOR, channelId: '4' });

    expect(healthService.getChannelHealthReport).toHaveBeenCalledExactlyOnceWith({
      anchor: ANCHOR,
      from: PERIOD.from,
      to: PERIOD.to,
    });
    expect(passport.health).toEqual(HEALTH_ROW);
  });

  it('scopes both weekly sources to the requested channel', async () => {
    const { service, metricsRepository, attributionService } = serviceWith();

    const passport = await service.getChannelPassport({ anchor: ANCHOR, channelId: '4' });

    expect(metricsRepository.listWeeklySeries).toHaveBeenCalledExactlyOnceWith({
      from: FIRST_WEEK,
      to: PERIOD.to,
      channelIds: ['4'],
    });
    expect(attributionService.getAttributionSeries).toHaveBeenCalledExactlyOnceWith({
      from: FIRST_WEEK,
      to: PERIOD.to,
      channelId: '4',
    });
    expect(passport.series).toHaveLength(12);
    expect(passport.series.at(-1)).toMatchObject({
      weekStart: LAST_WEEK,
      weekLabel: formatDateRu(LAST_WEEK),
      spendCents: '100000',
      newCustomers: 10,
      cacCents: '10000',
      romiPct: 50,
    });
  });

  it('keeps the funnel stages ordered and as integers', async () => {
    const { service } = serviceWith();

    const { funnel } = await service.getChannelPassport({ anchor: ANCHOR, channelId: '4' });

    expect(Object.keys(funnel)).toEqual(['impressions', 'clicks', 'leads', 'newCustomers', 'orders']);
    for (const value of Object.values(funnel)) {
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(funnel.impressions).toBeGreaterThanOrEqual(funnel.clicks);
    expect(funnel.clicks).toBeGreaterThanOrEqual(funnel.leads);
  });

  it('lists campaigns once, joins CAC inputs in memory and never queries per campaign', async () => {
    const { service, metricsRepository, campaignsRepository } = serviceWith();

    const { campaigns } = await service.getChannelPassport({ anchor: ANCHOR, channelId: '4' });

    expect(campaignsRepository.listCampaigns).toHaveBeenCalledExactlyOnceWith({ channelId: '4' });
    expect(metricsRepository.listCampaignCacInputs).toHaveBeenCalledExactlyOnceWith({
      from: PERIOD.from,
      to: PERIOD.to,
      channelId: '4',
    });
    expect(campaigns).toEqual([
      {
        id: '41',
        code: 'ig_warm',
        name: 'Instagram тёплый',
        status: 'active',
        spendCents: '60000',
        newCustomers: 6,
        cacCents: '10000',
      },
      // A campaign missing from the CAC input list keeps a real zero spend and a null CAC.
      {
        id: '42',
        code: 'ig_cold',
        name: 'Instagram холодный',
        status: 'paused',
        spendCents: '0',
        newCustomers: 0,
        cacCents: null,
      },
    ]);
  });

  it('fails loudly when the health report is missing the channel', async () => {
    const { service } = serviceWith({ healthRow: null });

    await expect(service.getChannelPassport({ anchor: ANCHOR, channelId: '4' })).rejects.toThrow(TypeError);
  });

  it('reports an unknown but well-formed channel id as not found', async () => {
    const { service, channelsRepository, metricsRepository } = serviceWith({ channel: null });

    await expect(service.getChannelPassport({ anchor: ANCHOR, channelId: '999' })).rejects.toThrow(NotFoundError);
    expect(channelsRepository.findChannelById).toHaveBeenCalledExactlyOnceWith('999');
    expect(metricsRepository.listWeeklySeries).not.toHaveBeenCalled();
  });

  it('rejects a malformed id and a zero id before SQL', async () => {
    for (const channelId of ['abc', '0']) {
      const { service, channelsRepository, metricsRepository } = serviceWith();
      await expect(service.getChannelPassport({ anchor: ANCHOR, channelId })).rejects.toThrow(Error);
      expect(channelsRepository.findChannelById).not.toHaveBeenCalled();
      expect(metricsRepository.listWeeklySeries).not.toHaveBeenCalled();
    }

    const { service } = serviceWith();
    await expect(service.getChannelPassport({ anchor: ANCHOR, channelId: 'abc' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.getChannelPassport({ anchor: ANCHOR, channelId: '0' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reports absent channel targets as null instead of a zero', async () => {
    const { service } = serviceWith({
      channel: { ...CHANNEL, targetCacCents: null, targetRomiPct: null },
    });

    const passport = await service.getChannelPassport({ anchor: ANCHOR, channelId: '4' });

    expect(passport.channel).toMatchObject({ targetCacCents: null, targetRomiPct: null });
  });

  it('uses an explicit from/to pair for every period-scoped read', async () => {
    const { service, healthService, metricsRepository, attributionService } = serviceWith();
    const from = '2026-10-01';
    const to = '2026-10-30';

    const passport = await service.getChannelPassport({ anchor: ANCHOR, channelId: '4', from, to });

    expect(passport.period).toEqual({ from, to, days: 30, anchor: ANCHOR });
    expect(healthService.getChannelHealthReport).toHaveBeenCalledExactlyOnceWith({ anchor: ANCHOR, from, to });
    expect(metricsRepository.getChannelFunnel).toHaveBeenCalledExactlyOnceWith({ from, to, channelId: '4' });
    expect(metricsRepository.listCampaignCacInputs).toHaveBeenCalledExactlyOnceWith({ from, to, channelId: '4' });
    // 2026-10-30 is Friday, so the weekly axis ends on the complete week that starts on 2026-10-19.
    expect(metricsRepository.listWeeklySeries).toHaveBeenCalledExactlyOnceWith({
      from: addDays('2026-10-19', -7 * 11),
      to,
      channelIds: ['4'],
    });
    expect(attributionService.getAttributionSeries).toHaveBeenCalledExactlyOnceWith({
      from: addDays('2026-10-19', -7 * 11),
      to,
      channelId: '4',
    });
  });

  it('drops the truncation sentinel so the screen never renders limit + 1 campaigns', async () => {
    const campaignRows = Array.from({ length: CAMPAIGN_LIST_LIMIT + 1 }, (_, index) => ({
      id: String(1000 + index),
      channelId: '4',
      code: `ig_${index}`,
      name: `Кампания ${index}`,
      status: 'active',
      spendCents: 0n,
    }));
    const { service } = serviceWith({ campaignRows, campaignCacRows: [] });

    const { campaigns } = await service.getChannelPassport({ anchor: ANCHOR, channelId: '4' });

    expect(campaigns).toHaveLength(CAMPAIGN_LIST_LIMIT);
    expect(campaigns.at(-1).id).toBe(String(1000 + CAMPAIGN_LIST_LIMIT - 1));
    // The sentinel row is not joined to a CAC input and would have rendered as `cacCents: null`.
    expect(campaigns.some((campaign) => campaign.id === String(1000 + CAMPAIGN_LIST_LIMIT))).toBe(false);
  });

  it('serialises without a bigint, NaN or Infinity', async () => {
    const { service } = serviceWith();

    const passport = await service.getChannelPassport({ anchor: ANCHOR, channelId: '4' });

    expect(() => JSON.stringify(passport)).not.toThrow();
    expect(hasBigInt(passport)).toBe(false);
    expect(JSON.stringify(passport)).not.toMatch(/NaN|Infinity/);
  });
});
