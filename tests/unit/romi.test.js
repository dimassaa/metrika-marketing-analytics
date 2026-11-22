import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../src/lib/errors.js';
import {
  computeLtvCac,
  computePayback,
  computeRomi,
  createChannelHealthService,
  deriveHealth,
} from '../../src/services/metrics/romi.service.js';

/**
 * Fixed anchor and window, the same ones the CAC and attribution suites use. The period resolver expands the
 * default 30-day window, so the stubs below assert the exact bounds the health service passes on.
 */
const PERIOD = { anchor: '2026-11-21', from: null, to: null };
const RESOLVED = { from: '2026-10-23', to: '2026-11-21', days: 30 };

describe('computeRomi', () => {
  it('returns a percentage of spend, keeping four decimals of guard precision', () => {
    expect(computeRomi({ revenueCents: 150000n, spendCents: 100000n })).toBe(50);
    expect(computeRomi({ revenueCents: 0n, spendCents: 100000n })).toBe(-100);
    // -4 c of 100 000 c is -0.004 %: the guard digits are exactly what keeps this from becoming 0.
    expect(computeRomi({ revenueCents: 99996n, spendCents: 100000n })).toBe(-0.004);
  });

  it('is undefined without spend, instead of Infinity', () => {
    expect(computeRomi({ revenueCents: 150000n, spendCents: 0n })).toBeNull();
    expect(computeRomi({ revenueCents: null, spendCents: 100000n })).toBeNull();
    expect(computeRomi({ revenueCents: 100000n, spendCents: null })).toBeNull();
  });

  it('rejects negative or non-bigint money', () => {
    expect(() => computeRomi({ revenueCents: -1n, spendCents: 100n })).toThrow(TypeError);
    expect(() => computeRomi({ revenueCents: 100, spendCents: 100n })).toThrow(TypeError);
    expect(() => computeRomi({ revenueCents: 100n, spendCents: -100n })).toThrow(TypeError);
  });
});

describe('computePayback', () => {
  it('divides CAC by the twelfth of LTV12', () => {
    expect(computePayback({ cacCents: 5000n, ltv12Cents: 12000n })).toBe(5);
    // 12 004 * 12 / 12 000 = 12.004: six guard digits survive for the health comparison.
    expect(computePayback({ cacCents: 12004n, ltv12Cents: 12000n })).toBe(12.004);
    expect(computePayback({ cacCents: 18000n, ltv12Cents: 12000n })).toBe(18);
  });

  it('is undefined when CAC, LTV or the monthly margin is missing', () => {
    expect(computePayback({ cacCents: null, ltv12Cents: 12000n })).toBeNull();
    expect(computePayback({ cacCents: 5000n, ltv12Cents: null })).toBeNull();
    expect(computePayback({ cacCents: 5000n, ltv12Cents: 0n })).toBeNull();
  });

  it('rejects negative or non-bigint money', () => {
    expect(() => computePayback({ cacCents: -1n, ltv12Cents: 12000n })).toThrow(TypeError);
    expect(() => computePayback({ cacCents: 5000n, ltv12Cents: '12000' })).toThrow(TypeError);
  });
});

describe('computeLtvCac', () => {
  it('returns the LTV12 to CAC coefficient with six guard digits', () => {
    expect(computeLtvCac({ ltv12Cents: 36000n, cacCents: 10000n })).toBe(3.6);
    expect(computeLtvCac({ ltv12Cents: 29996n, cacCents: 10000n })).toBe(2.9996);
  });

  it('is undefined without LTV or with a zero CAC denominator', () => {
    expect(computeLtvCac({ ltv12Cents: null, cacCents: 10000n })).toBeNull();
    expect(computeLtvCac({ ltv12Cents: 36000n, cacCents: null })).toBeNull();
    expect(computeLtvCac({ ltv12Cents: 36000n, cacCents: 0n })).toBeNull();
  });

  it('rejects negative or non-bigint money', () => {
    expect(() => computeLtvCac({ ltv12Cents: -1n, cacCents: 10000n })).toThrow(TypeError);
    expect(() => computeLtvCac({ ltv12Cents: 36000, cacCents: 10000n })).toThrow(TypeError);
  });
});

describe('deriveHealth', () => {
  /** A revenue equal to spend keeps ROMI at exactly 0, so a fixture isolates the ratio/payback rules. */
  const NEUTRAL_REVENUE = 100000n;

  it('marks ratio 3 and a payback below 12 as healthy', () => {
    expect(
      deriveHealth({
        cacCents: 5000n,
        ltv12Cents: 15000n,
        revenueCents: NEUTRAL_REVENUE,
        spendCents: NEUTRAL_REVENUE,
      }),
    ).toBe('healthy');
  });

  it('keeps a ratio of 2.9996 in watch even though it displays as 3,000', () => {
    expect(
      deriveHealth({
        cacCents: 10000n,
        ltv12Cents: 29996n,
        revenueCents: NEUTRAL_REVENUE,
        spendCents: NEUTRAL_REVENUE,
      }),
    ).toBe('watch');
  });

  it('keeps a ratio of exactly 1.0 in watch and 0.999 in risk', () => {
    expect(
      deriveHealth({
        cacCents: 10000n,
        ltv12Cents: 10000n,
        revenueCents: NEUTRAL_REVENUE,
        spendCents: NEUTRAL_REVENUE,
      }),
    ).toBe('watch');
    expect(
      deriveHealth({
        cacCents: 10000n,
        ltv12Cents: 9990n,
        revenueCents: NEUTRAL_REVENUE,
        spendCents: NEUTRAL_REVENUE,
      }),
    ).toBe('risk');
  });

  it('never promotes a payback past 12 to healthy', () => {
    // Payback = 12 * CAC / LTV, so payback 12.004 means ratio 0.99967 < 1 and the *risk* clause fires. The brief
    // labels this fixture "watch", but watch requires ratio >= 1, which is arithmetically impossible here; what
    // matters for the guard is that it is not healthy.
    const status = deriveHealth({
      cacCents: 12004n,
      ltv12Cents: 12000n,
      revenueCents: NEUTRAL_REVENUE,
      spendCents: NEUTRAL_REVENUE,
    });
    expect(status).not.toBe('healthy');
    expect(status).toBe('risk');
    expect(computePayback({ cacCents: 12004n, ltv12Cents: 12000n })).toBe(12.004);
  });

  it('never promotes a payback of 18 or 18.0001 to healthy', () => {
    for (const cacCents of [18000n, 18001n]) {
      const status = deriveHealth({
        cacCents,
        ltv12Cents: 12000n,
        revenueCents: NEUTRAL_REVENUE,
        spendCents: NEUTRAL_REVENUE,
      });
      expect(status).not.toBe('healthy');
      expect(status).toBe('risk');
    }
  });

  it('treats any negative ROMI, even -0.004 %, as risk', () => {
    expect(
      deriveHealth({
        cacCents: 5000n,
        ltv12Cents: 15000n,
        revenueCents: 99996n,
        spendCents: 100000n,
      }),
    ).toBe('risk');
  });

  it('returns no_data when a required metric or the spend is missing', () => {
    const healthyInput = {
      cacCents: 5000n,
      ltv12Cents: 15000n,
      revenueCents: 150000n,
      spendCents: 100000n,
    };
    expect(deriveHealth({ ...healthyInput, cacCents: null })).toBe('no_data');
    expect(deriveHealth({ ...healthyInput, ltv12Cents: null })).toBe('no_data');
    expect(deriveHealth({ ...healthyInput, revenueCents: null })).toBe('no_data');
    expect(deriveHealth({ ...healthyInput, spendCents: null })).toBe('no_data');
    expect(deriveHealth({ ...healthyInput, spendCents: 0n })).toBe('no_data');
    // A free channel has CAC 0n but ROMI is undefined without spend: the spec's letter is no_data.
    expect(deriveHealth({ ...healthyInput, cacCents: 0n, spendCents: 0n })).toBe('no_data');
  });

  it('gives no_data priority over risk and risk priority over watch', () => {
    const negativeRomi = { cacCents: 5000n, ltv12Cents: 15000n, revenueCents: 99996n, spendCents: 100000n };
    expect(deriveHealth({ ...negativeRomi, ltv12Cents: null })).toBe('no_data');
    // Both ROMI < 0 and ratio < 3: risk wins over watch.
    expect(deriveHealth({ ...negativeRomi, ltv12Cents: 12000n })).toBe('risk');
    expect(
      deriveHealth({ cacCents: 10000n, ltv12Cents: 20000n, revenueCents: 100000n, spendCents: 100000n }),
    ).toBe('watch');
  });

  it('rejects malformed money instead of guessing', () => {
    expect(() =>
      deriveHealth({ cacCents: -1n, ltv12Cents: 15000n, revenueCents: 150000n, spendCents: 100000n }),
    ).toThrow(TypeError);
  });
});

/**
 * Builds a health service over plain fixtures and records every dependency call.
 *
 * @param {object} [fixture]
 * @returns {{
 *   service: ReturnType<typeof createChannelHealthService>,
 *   cacService: object,
 *   ltvService: object,
 *   attributionService: object,
 *   channelsRepository: object,
 * }}
 */
function serviceWith({
  channels = [{ id: '1', code: 'instagram', name: 'Instagram' }],
  cacRows = [],
  ltvRows = [],
  revenueRows = [],
  cacBlended = { spendCents: '0', newCustomers: 0, cacCents: null, cacLabel: '—', status: 'no_data' },
  ltvBlended = { ltvCents: null, customerCount: 0, cohortCount: 0, status: 'insufficient_history' },
  totalAttributedCents = '0',
} = {}) {
  const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
  const cacService = {
    getCacReport: vi.fn().mockResolvedValue({
      period: { ...RESOLVED },
      blended: cacBlended,
      rows: cacRows.map((row) => ({
        key: `channel:${row.channelId}`,
        label: channelsById.get(row.channelId)?.name ?? '',
        status: 'ok',
        ...row,
      })),
    }),
  };
  const ltvService = {
    getChannelLtv: vi.fn().mockResolvedValue({ rows: ltvRows, blended: ltvBlended }),
  };
  const attributionService = {
    getAttributionReport: vi.fn().mockResolvedValue({
      period: { from: RESOLVED.from, to: RESOLVED.to },
      models: {
        last_touch: {
          revenueByChannel: revenueRows,
          totalRevenueCents: totalAttributedCents,
          totalAttributedCents,
        },
      },
    }),
  };
  const channelsRepository = { listChannels: vi.fn().mockResolvedValue(channels) };

  return {
    service: createChannelHealthService({
      cacService,
      ltvService,
      attributionService,
      channelsRepository,
    }),
    cacService,
    ltvService,
    attributionService,
    channelsRepository,
  };
}

describe('createChannelHealthService', () => {
  it('builds the full row with rounded display values and a health decision made before rounding', async () => {
    const { service, cacService, ltvService, attributionService, channelsRepository } = serviceWith({
      cacRows: [{ channelId: '1', spendCents: '100000', newCustomers: 10, cacCents: '5000' }],
      ltvRows: [{ channelId: '1', channelCode: 'instagram', ltvCents: '15000' }],
      revenueRows: [{ channelId: '1', channelCode: 'instagram', revenueCents: '150000' }],
      cacBlended: { spendCents: '100000', newCustomers: 10, cacCents: '5000', cacLabel: '50,00', status: 'ok' },
      ltvBlended: { ltvCents: '15000', customerCount: 10, cohortCount: 1, status: 'ok' },
      totalAttributedCents: '150000',
    });

    const report = await service.getChannelHealthReport(PERIOD);

    expect(cacService.getCacReport).toHaveBeenCalledExactlyOnceWith({
      anchor: '2026-11-21',
      from: RESOLVED.from,
      to: RESOLVED.to,
    });
    expect(ltvService.getChannelLtv).toHaveBeenCalledExactlyOnceWith({ anchor: '2026-11-21', horizonMonths: 12 });
    expect(attributionService.getAttributionReport).toHaveBeenCalledExactlyOnceWith({
      from: RESOLVED.from,
      to: RESOLVED.to,
      models: ['last_touch'],
    });
    expect(channelsRepository.listChannels).toHaveBeenCalledTimes(1);

    expect(report.period).toEqual(RESOLVED);
    expect(report.rows).toEqual([
      {
        channelId: '1',
        code: 'instagram',
        name: 'Instagram',
        spendCents: '100000',
        revenueCents: '150000',
        newCustomers: 10,
        cacCents: '5000',
        cacLabel: '50,00',
        ltv12Cents: '15000',
        ltvLabel: '150,00',
        romiPct: 50,
        romiLabel: '50,0%',
        paybackMonths: 4,
        paybackLabel: '4 мес.',
        ltvCacRatio: 3,
        ratioLabel: '3,000',
        status: 'healthy',
        statusLabel: 'В норме',
      },
    ]);
    // The blended row has the same shape but deliberately no channelId: the ranking must be able to exclude it.
    expect(report.blended).toEqual({
      code: 'blended',
      name: 'Все каналы',
      spendCents: '100000',
      revenueCents: '150000',
      newCustomers: 10,
      cacCents: '5000',
      cacLabel: '50,00',
      ltv12Cents: '15000',
      ltvLabel: '150,00',
      romiPct: 50,
      romiLabel: '50,0%',
      paybackMonths: 4,
      paybackLabel: '4 мес.',
      ltvCacRatio: 3,
      ratioLabel: '3,000',
      status: 'healthy',
      statusLabel: 'В норме',
    });
    expect(report.blended).not.toHaveProperty('channelId');
  });

  it('keeps watch and risk on display-rounded boundaries', async () => {
    const { service } = serviceWith({
      channels: [
        { id: '1', code: 'watch', name: 'Наблюдать' },
        { id: '2', code: 'risk', name: 'Риск' },
        { id: '0', code: 'empty', name: 'Пустой' },
      ],
      cacRows: [
        { channelId: '1', spendCents: '100000', newCustomers: 10, cacCents: '10000' },
        { channelId: '2', spendCents: '100000', newCustomers: 20, cacCents: '5000' },
        { channelId: '0', spendCents: '0', newCustomers: 0, cacCents: null },
      ],
      ltvRows: [
        { channelId: '1', channelCode: 'watch', ltvCents: '29996' },
        { channelId: '2', channelCode: 'risk', ltvCents: '15000' },
      ],
      revenueRows: [
        { channelId: '1', channelCode: 'watch', revenueCents: '100000' },
        { channelId: '2', channelCode: 'risk', revenueCents: '99996' },
      ],
    });

    const report = await service.getChannelHealthReport(PERIOD);
    const watch = report.rows.find((row) => row.channelId === '1');
    const risk = report.rows.find((row) => row.channelId === '2');
    const empty = report.rows.find((row) => row.channelId === '0');

    // 29 996 / 10 000 = 2.9996: the display rounds to 3,000, the status must not become healthy.
    expect(watch).toMatchObject({ ltvCacRatio: 3, ratioLabel: '3,000', status: 'watch', statusLabel: 'Наблюдать' });
    // -4 c of 100 000 c is -0.004 %: the display rounds to 0,0%, the status must stay risk.
    expect(risk).toMatchObject({ romiPct: 0, romiLabel: '0,0%', status: 'risk', statusLabel: 'Риск' });
    expect(empty).toMatchObject({
      cacCents: null,
      cacLabel: '—',
      ltv12Cents: null,
      ltvLabel: '—',
      romiPct: null,
      romiLabel: '—',
      paybackMonths: null,
      paybackLabel: '—',
      ltvCacRatio: null,
      ratioLabel: '—',
      status: 'no_data',
      statusLabel: 'Мало данных',
    });
  });

  it('shows a free channel as no_data but still labels its payback and ratio honestly', async () => {
    const { service } = serviceWith({
      channels: [{ id: '6', code: 'email', name: 'Email' }],
      cacRows: [{ channelId: '6', spendCents: '0', newCustomers: 18, cacCents: '0' }],
      ltvRows: [{ channelId: '6', channelCode: 'email', ltvCents: '12871' }],
      revenueRows: [{ channelId: '6', channelCode: 'email', revenueCents: '919161' }],
    });

    const report = await service.getChannelHealthReport(PERIOD);

    expect(report.rows[0]).toMatchObject({
      spendCents: '0',
      revenueCents: '919161',
      cacCents: '0',
      ltv12Cents: '12871',
      romiPct: null,
      romiLabel: '—',
      // CAC 0 over a non-zero LTV is a real zero months, not a missing value; the ratio denominator is zero.
      paybackMonths: 0,
      paybackLabel: '0 мес.',
      ltvCacRatio: null,
      ratioLabel: '—',
      status: 'no_data',
    });
  });

  it('keeps a channel missing from attribution at zero revenue without masking a null LTV', async () => {
    const { service } = serviceWith({
      channels: [
        { id: '1', code: 'instagram', name: 'Instagram' },
        { id: '2', code: 'google', name: 'Google Ads' },
      ],
      cacRows: [
        { channelId: '1', spendCents: '100000', newCustomers: 10, cacCents: '10000' },
        { channelId: '2', spendCents: '200000', newCustomers: 20, cacCents: '10000' },
      ],
      ltvRows: [{ channelId: '1', channelCode: 'instagram', ltvCents: '15000' }],
      revenueRows: [{ channelId: '1', channelCode: 'instagram', revenueCents: '150000' }],
    });

    const report = await service.getChannelHealthReport(PERIOD);
    const google = report.rows.find((row) => row.channelId === '2');

    expect(google).toMatchObject({
      spendCents: '200000',
      revenueCents: '0',
      ltv12Cents: null,
      ltvLabel: '—',
      status: 'no_data',
    });
  });

  it('sorts channels by code so the report order does not depend on the repository', async () => {
    const { service } = serviceWith({
      channels: [
        { id: '2', code: 'google', name: 'Google Ads' },
        { id: '1', code: 'instagram', name: 'Instagram' },
      ],
    });

    const report = await service.getChannelHealthReport(PERIOD);

    expect(report.rows.map((row) => row.code)).toEqual(['google', 'instagram']);
  });

  it('rejects an unknown attribution model before touching any dependency', async () => {
    const { service, cacService, ltvService, attributionService, channelsRepository } = serviceWith();

    await expect(service.getChannelHealthReport({ ...PERIOD, attributionModel: 'magic' })).rejects.toThrow(
      ValidationError,
    );
    expect(cacService.getCacReport).not.toHaveBeenCalled();
    expect(ltvService.getChannelLtv).not.toHaveBeenCalled();
    expect(attributionService.getAttributionReport).not.toHaveBeenCalled();
    expect(channelsRepository.listChannels).not.toHaveBeenCalled();
  });

  it('passes the selected attribution model through and keeps revenue and LTV aligned by channel', async () => {
    const { service, attributionService } = serviceWith();
    attributionService.getAttributionReport.mockResolvedValue({
      period: { from: RESOLVED.from, to: RESOLVED.to },
      models: {
        linear: {
          revenueByChannel: [{ channelId: '1', channelCode: 'instagram', revenueCents: '150000' }],
          totalRevenueCents: '150000',
          totalAttributedCents: '150000',
        },
      },
    });

    const report = await service.getChannelHealthReport({ from: RESOLVED.from, to: RESOLVED.to, anchor: '2026-11-21', attributionModel: 'linear' });

    expect(attributionService.getAttributionReport).toHaveBeenCalledExactlyOnceWith({
      from: RESOLVED.from,
      to: RESOLVED.to,
      models: ['linear'],
    });
    expect(report.rows[0].revenueCents).toBe('150000');
    expect(report.blended.revenueCents).toBe('150000');
  });

  it('never leaks NaN, Infinity or bigint into the serialised view model', async () => {
    const { service } = serviceWith({
      channels: [{ id: '0', code: 'empty', name: 'Пустой' }],
      cacRows: [{ channelId: '0', spendCents: '0', newCustomers: 0, cacCents: null }],
      ltvRows: [],
      revenueRows: [],
    });

    const report = await service.getChannelHealthReport(PERIOD);

    expect(() => JSON.stringify(report)).not.toThrow();
    expect(JSON.stringify(report)).not.toMatch(/NaN|Infinity/);
    for (const row of [...report.rows, report.blended]) {
      for (const key of ['romiPct', 'paybackMonths', 'ltvCacRatio']) {
        expect(row[key] === null || Number.isFinite(row[key])).toBe(true);
      }
    }
  });
});
