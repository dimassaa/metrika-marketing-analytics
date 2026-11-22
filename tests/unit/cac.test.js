import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../src/lib/errors.js';
import { computeCac, createCacService } from '../../src/services/metrics/cac.service.js';

const PERIOD = { from: '2026-10-01', to: '2026-10-31' };

describe('computeCac', () => {
  it('divides spend by new customers and rounds to the kopeck half up', () => {
    expect(computeCac({ spendCents: 420000n, newCustomers: 84 })).toEqual({
      cacCents: 5000n,
      status: 'ok',
    });
    // 2/3 of a kopeck rounds up, 1/3 rounds down.
    expect(computeCac({ spendCents: 2n, newCustomers: 3 })).toEqual({ cacCents: 1n, status: 'ok' });
    expect(computeCac({ spendCents: 1n, newCustomers: 3 })).toEqual({ cacCents: 0n, status: 'ok' });
  });

  it('returns no_data rather than Infinity when nobody was acquired', () => {
    expect(computeCac({ spendCents: 420000n, newCustomers: 0 })).toEqual({ cacCents: null, status: 'no_data' });
    expect(computeCac({ spendCents: 0n, newCustomers: 0 })).toEqual({ cacCents: null, status: 'no_data' });
  });

  it('marks a free channel when customers arrived without spend', () => {
    expect(computeCac({ spendCents: 0n, newCustomers: 5 })).toEqual({ cacCents: 0n, status: 'free' });
  });

  it('rejects negative or fractional money and customer counts instead of guessing', () => {
    expect(() => computeCac({ spendCents: -1n, newCustomers: 2 })).toThrow(TypeError);
    expect(() => computeCac({ spendCents: 100n, newCustomers: 1.5 })).toThrow(TypeError);
    expect(() => computeCac({ spendCents: 100n, newCustomers: -1 })).toThrow(TypeError);
  });
});

/**
 * @param {object} [overrides]
 * @returns {ReturnType<typeof createCacService>}
 */
function serviceWith(overrides = {}) {
  const repository = {
    listChannelCacInputs: vi.fn().mockResolvedValue([
      {
        channelId: '1',
        channelCode: 'instagram',
        channelName: 'Instagram',
        spendCents: 420000n,
        newCustomers: 84,
      },
      {
        channelId: '2',
        channelCode: 'email',
        channelName: 'Email',
        spendCents: 0n,
        newCustomers: 10,
      },
      {
        channelId: '3',
        channelCode: 'empty',
        channelName: 'Пустой канал',
        spendCents: 0n,
        newCustomers: 0,
      },
    ]),
    listCampaignCacInputs: vi.fn().mockResolvedValue([
      {
        campaignId: '7',
        channelId: '1',
        campaignCode: 'instagram_retarget',
        campaignName: 'Instagram — ретаргетинг',
        spendCents: 210000n,
        newCustomers: 42,
      },
    ]),
    totals: vi.fn().mockResolvedValue({ spendCents: 900000n, newCustomers: 180 }),
    listChannelSpend: vi.fn(),
    ...overrides,
  };
  return { service: createCacService({ metricsRepository: repository }), repository };
}

describe('createCacService', () => {
  it('builds channel rows with exact kopeck strings and labels', async () => {
    const { service, repository } = serviceWith();

    const report = await service.getCacReport(PERIOD);

    expect(repository.listChannelCacInputs).toHaveBeenCalledWith(PERIOD);
    expect(report.period).toEqual({ from: '2026-10-01', to: '2026-10-31', days: 31 });
    expect(report.blended).toEqual({
      spendCents: '900000',
      newCustomers: 180,
      cacCents: '5000',
      cacLabel: '50,00',
      status: 'ok',
    });
    expect(report.rows).toEqual([
      {
        key: 'channel:1',
        channelId: '1',
        label: 'Instagram',
        spendCents: '420000',
        newCustomers: 84,
        cacCents: '5000',
        cacLabel: '50,00',
        status: 'ok',
      },
      {
        key: 'channel:2',
        channelId: '2',
        label: 'Email',
        spendCents: '0',
        newCustomers: 10,
        cacCents: '0',
        cacLabel: '0,00',
        status: 'free',
      },
      {
        key: 'channel:3',
        channelId: '3',
        label: 'Пустой канал',
        spendCents: '0',
        newCustomers: 0,
        cacCents: null,
        cacLabel: '—',
        status: 'no_data',
      },
    ]);
  });

  it('builds campaign rows without mixing in another channel', async () => {
    const { service, repository } = serviceWith();

    const report = await service.getCacReport({ ...PERIOD, groupBy: 'campaign' });

    expect(repository.listCampaignCacInputs).toHaveBeenCalledWith({ ...PERIOD, channelId: null });
    expect(report.rows).toEqual([
      {
        key: 'campaign:7',
        channelId: '1',
        campaignId: '7',
        label: 'Instagram — ретаргетинг',
        spendCents: '210000',
        newCustomers: 42,
        cacCents: '5000',
        cacLabel: '50,00',
        status: 'ok',
      },
    ]);
  });

  it('passes a validated channel filter to the campaign query', async () => {
    const { service, repository } = serviceWith();

    await service.getCacReport({ ...PERIOD, groupBy: 'campaign', channelId: '007' });

    expect(repository.listCampaignCacInputs).toHaveBeenCalledWith({ ...PERIOD, channelId: '7' });
  });

  it('rejects an unknown grouping, a bad channel id and a reversed period', async () => {
    const { service } = serviceWith();

    await expect(service.getCacReport({ ...PERIOD, groupBy: 'day' })).rejects.toThrow(ValidationError);
    await expect(service.getCacReport({ ...PERIOD, groupBy: 'campaign', channelId: 'abc' })).rejects.toThrow(
      ValidationError,
    );
    await expect(service.getCacReport({ from: '2026-10-31', to: '2026-10-01' })).rejects.toThrow(ValidationError);
    await expect(service.getCacReport({ from: '2026-10-01' })).rejects.toThrow(ValidationError);
  });

  it('never leaks NaN or Infinity into the view model', async () => {
    const { service } = serviceWith({
      totals: vi.fn().mockResolvedValue({ spendCents: 100n, newCustomers: 0 }),
    });

    const report = await service.getCacReport(PERIOD);
    const serialised = JSON.stringify(report);

    expect(report.blended.cacCents).toBe(null);
    expect(report.blended.status).toBe('no_data');
    expect(serialised).not.toMatch(/NaN|Infinity/);
  });
});
