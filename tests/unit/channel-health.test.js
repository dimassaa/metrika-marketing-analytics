import { describe, expect, it, vi } from 'vitest';
import { createChannelHealthService } from '../../src/services/metrics/romi.service.js';

const ANCHOR = '2026-11-21';

/**
 * @param {object} [options]
 * @returns {{
 *   service: ReturnType<typeof createChannelHealthService>,
 *   ltvService: object,
 * }}
 */
function serviceWith({ ltvBlended = { ltvCents: '450' } } = {}) {
  const cacService = {
    getCacReport: vi.fn().mockResolvedValue({
      period: { from: '2026-10-23', to: ANCHOR, days: 30 },
      blended: { spendCents: '300', newCustomers: 3, cacCents: '100', cacLabel: '1,00' },
      rows: [
        { channelId: '1', spendCents: '100', newCustomers: 1, cacCents: '100', cacLabel: '1,00' },
        { channelId: '2', spendCents: '200', newCustomers: 2, cacCents: '100', cacLabel: '1,00' },
      ],
    }),
  };
  const ltvService = {
    getChannelLtv: vi.fn().mockResolvedValue({
      rows: [{ channelId: '1', ltvCents: '500' }],
      blended: ltvBlended,
    }),
  };
  const attributionService = {
    getAttributionReport: vi.fn().mockResolvedValue({
      models: {
        last_touch: {
          revenueByChannel: [
            { channelId: '1', revenueCents: '400' },
            { channelId: '2', revenueCents: '200' },
          ],
          totalAttributedCents: '600',
        },
      },
    }),
  };
  const channelsRepository = {
    listChannels: vi.fn().mockResolvedValue([
      { id: '1', code: 'instagram', name: 'Instagram' },
      { id: '2', code: 'google', name: 'Google Ads' },
    ]),
  };

  return {
    service: createChannelHealthService({
      cacService,
      ltvService,
      attributionService,
      channelsRepository,
    }),
    ltvService,
  };
}

describe('channel health filter', () => {
  it('recomputes the blended row from the selected channels only', async () => {
    const { service, ltvService } = serviceWith();

    const report = await service.getChannelHealthReport({ anchor: ANCHOR, channelIds: ['1'] });

    expect(report.rows.map((row) => row.channelId)).toEqual(['1']);
    expect(report.blended).toMatchObject({
      code: 'blended',
      spendCents: '100',
      revenueCents: '400',
      newCustomers: 1,
      cacCents: '100',
      ltv12Cents: '450',
    });
    // LTV is the exact filtered aggregate, not an average of the rounded channel value.
    expect(ltvService.getChannelLtv).toHaveBeenCalledWith({
      anchor: ANCHOR,
      horizonMonths: 12,
      channelIds: ['1'],
    });
  });

  it('keeps the full channel dimension for the filter control', async () => {
    const { service } = serviceWith();

    const report = await service.getChannelHealthReport({ anchor: ANCHOR, channelIds: ['1'] });

    expect(report.availableChannels).toEqual([
      { channelId: '2', code: 'google', name: 'Google Ads' },
      { channelId: '1', code: 'instagram', name: 'Instagram' },
    ]);
  });

  it('divides CAC from the summed spend and customers instead of averaging channel CAC', async () => {
    const { service } = serviceWith();

    const report = await service.getChannelHealthReport({ anchor: ANCHOR, channelIds: ['1', '2'] });

    // (100 + 200) / (1 + 2) = 100 kopecks, not the average of the two rounded CAC values.
    expect(report.blended.spendCents).toBe('300');
    expect(report.blended.newCustomers).toBe(3);
    expect(report.blended.cacCents).toBe('100');
  });

  it('returns honest zeros for a filter that matches no channel', async () => {
    const { service } = serviceWith({ ltvBlended: { ltvCents: null } });

    const report = await service.getChannelHealthReport({ anchor: ANCHOR, channelIds: ['999'] });

    expect(report.rows).toEqual([]);
    expect(report.blended).toMatchObject({
      spendCents: '0',
      revenueCents: '0',
      newCustomers: 0,
      cacCents: null,
      romiPct: null,
      status: 'no_data',
    });
  });

  it('rejects an empty or malformed channel list before querying', async () => {
    const { service } = serviceWith();

    await expect(service.getChannelHealthReport({ anchor: ANCHOR, channelIds: [] })).rejects.toThrow(
      /канал/,
    );
    await expect(
      service.getChannelHealthReport({ anchor: ANCHOR, channelIds: ['abc'] }),
    ).rejects.toThrow(/канал/);
  });
});
