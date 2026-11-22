import { describe, expect, it, vi } from 'vitest';
import { addDays, isoWeekStart } from '../../src/lib/dates.js';
import { createDashboardService } from '../../src/services/metrics/dashboard.service.js';

/**
 * Fixed anchor, the same one the other metrics suites use. `2026-11-21` is a Saturday, so the week that starts on
 * `2026-11-16` is still incomplete and must be dropped; the last full week starts on `2026-11-09`.
 */
const ANCHOR = '2026-11-21';
const PERIOD = { from: '2026-10-23', to: '2026-11-21', days: 30 };
const LAST_WEEK = '2026-11-09';
const FIRST_WEEK = addDays(LAST_WEEK, -7 * 11);

/** A complete blended health row; the dashboard copies KPI and verdict from exactly this object. */
const BLENDED = {
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
 *   service: ReturnType<typeof createDashboardService>,
 *   healthService: object,
 *   metricsRepository: object,
 *   attributionService: object,
 * }}
 */
function serviceWith({
  blended = BLENDED,
  weeklyRows = [
    { weekStart: LAST_WEEK, spendCents: 100000n, newCustomers: 10 },
    { weekStart: FIRST_WEEK, spendCents: 0n, newCustomers: 0 },
  ],
  attributedRows = [{ weekStart: LAST_WEEK, revenueCents: '150000' }],
} = {}) {
  const healthService = {
    getChannelHealthReport: vi.fn().mockResolvedValue({ period: { ...PERIOD }, rows: [], blended }),
  };
  const metricsRepository = {
    listWeeklySeries: vi.fn().mockResolvedValue(weeklyRows),
  };
  const attributionService = {
    getAttributionSeries: vi.fn().mockResolvedValue(attributedRows),
  };

  return {
    service: createDashboardService({ healthService, metricsRepository, attributionService }),
    healthService,
    metricsRepository,
    attributionService,
  };
}

describe('dashboard summary', () => {
  it('copies KPI from the blended health row and labels the money for display', async () => {
    const { service } = serviceWith();

    const summary = await service.getDashboardSummary({ anchor: ANCHOR });

    expect(summary.kpis).toEqual({
      spendCents: '1150770',
      spendLabel: '11 507,70',
      newCustomers: 263,
      newCustomersLabel: '263',
      cacCents: '4376',
      cacLabel: '43,76',
      romiPct: 713.11,
      romiLabel: '713,11%',
    });
    expect(summary.period).toEqual({ from: PERIOD.from, to: PERIOD.to, days: 30, anchor: ANCHOR });
  });

  it('asks every source for the same explicit period and the last 12 full weeks', async () => {
    const { service, healthService, metricsRepository, attributionService } = serviceWith();

    await service.getDashboardSummary({ anchor: ANCHOR });

    expect(healthService.getChannelHealthReport).toHaveBeenCalledExactlyOnceWith({
      anchor: ANCHOR,
      from: PERIOD.from,
      to: PERIOD.to,
    });
    expect(metricsRepository.listWeeklySeries).toHaveBeenCalledExactlyOnceWith({
      from: FIRST_WEEK,
      to: PERIOD.to,
    });
    expect(attributionService.getAttributionSeries).toHaveBeenCalledExactlyOnceWith({
      from: FIRST_WEEK,
      to: PERIOD.to,
    });
  });

  it('builds complete Monday-to-Sunday weeks, sorted, with no partial week at the end', async () => {
    const { service } = serviceWith();

    const { weeklySeries } = await service.getDashboardSummary({ anchor: ANCHOR });

    expect(weeklySeries).toHaveLength(12);
    expect(weeklySeries[0].weekStart).toBe(FIRST_WEEK);
    expect(weeklySeries.at(-1).weekStart).toBe(LAST_WEEK);
    for (const bucket of weeklySeries) {
      expect(bucket.weekStart).toBe(isoWeekStart(bucket.weekStart));
      // A complete bucket ends on Sunday no later than the reporting date.
      expect(addDays(bucket.weekStart, 6) <= PERIOD.to).toBe(true);
    }
    const starts = weeklySeries.map((bucket) => bucket.weekStart);
    expect(starts).toEqual([...starts].sort());
    expect(weeklySeries.at(-1)).toMatchObject({
      weekStart: LAST_WEEK,
      weekLabel: '09.11.2026',
      spendCents: '100000',
      newCustomers: 10,
      cacCents: '10000',
      romiPct: 50,
    });
  });

  it('filters out a partial week even if a source returns one', async () => {
    const partialWeek = addDays(LAST_WEEK, 7);
    const { service } = serviceWith({
      weeklyRows: [
        { weekStart: LAST_WEEK, spendCents: 100000n, newCustomers: 10 },
        { weekStart: partialWeek, spendCents: 50000n, newCustomers: 5 },
      ],
      attributedRows: [
        { weekStart: LAST_WEEK, revenueCents: '150000' },
        { weekStart: partialWeek, revenueCents: '70000' },
      ],
    });

    const { weeklySeries } = await service.getDashboardSummary({ anchor: ANCHOR });

    expect(weeklySeries.map((bucket) => bucket.weekStart)).not.toContain(partialWeek);
    expect(weeklySeries).toHaveLength(12);
  });

  it('keeps a zero-spend bucket at null CAC/ROMI instead of NaN', async () => {
    const { service } = serviceWith({
      weeklyRows: [
        { weekStart: LAST_WEEK, spendCents: 0n, newCustomers: 0 },
        { weekStart: FIRST_WEEK, spendCents: 0n, newCustomers: 4 },
      ],
    });

    const { weeklySeries } = await service.getDashboardSummary({ anchor: ANCHOR });

    expect(weeklySeries.at(-1)).toMatchObject({ cacCents: null, romiPct: null });
    // A free week with customers has a real zero CAC, but ROMI is still undefined without spend.
    expect(weeklySeries[0]).toMatchObject({ spendCents: '0', newCustomers: 4, cacCents: '0', romiPct: null });
    expect(JSON.stringify(weeklySeries)).not.toMatch(/NaN|Infinity/);
  });

  it('takes the verdict status and label from the blended health row', async () => {
    const { service } = serviceWith();

    const { verdict } = await service.getDashboardSummary({ anchor: ANCHOR });

    expect(verdict.status).toBe('healthy');
    expect(verdict.label).toBe('В норме');
    expect(verdict.reason.length).toBeGreaterThan(0);
  });

  it('explains each status with a short Russian reason and no new thresholds', async () => {
    const reasons = new Map();
    for (const status of ['healthy', 'watch', 'risk']) {
      const { service } = serviceWith({ blended: { ...BLENDED, status } });
      const { verdict } = await service.getDashboardSummary({ anchor: ANCHOR });
      expect(verdict.status).toBe(status);
      reasons.set(status, verdict.reason);
    }

    expect(new Set(reasons.values()).size).toBe(3);
    for (const reason of reasons.values()) {
      expect(reason).toMatch(/[А-Яа-яЁё]/);
    }
  });

  it('reports no_data with an empty dataset and still returns the full zero axis', async () => {
    const { service } = serviceWith({
      blended: { ...BLENDED, spendCents: '0', cacCents: null, cacLabel: '—', romiPct: null, romiLabel: '—', newCustomers: 0, status: 'no_data' },
      weeklyRows: [],
      attributedRows: [],
    });

    const summary = await service.getDashboardSummary({ anchor: ANCHOR });

    expect(summary.verdict.status).toBe('no_data');
    expect(summary.kpis).toMatchObject({ spendCents: '0', newCustomers: 0, cacCents: null, romiPct: null });
    expect(summary.weeklySeries).toHaveLength(12);
    expect(summary.weeklySeries.every((bucket) => bucket.spendCents === '0' && bucket.cacCents === null)).toBe(true);
  });

  it('serialises without a bigint, NaN or Infinity', async () => {
    const { service } = serviceWith();

    const summary = await service.getDashboardSummary({ anchor: ANCHOR });

    expect(() => JSON.stringify(summary)).not.toThrow();
    expect(hasBigInt(summary)).toBe(false);
    expect(JSON.stringify(summary)).not.toMatch(/NaN|Infinity/);
  });

  it('rejects a non-positive week count before touching a dependency', async () => {
    const { service, healthService } = serviceWith();

    await expect(service.getDashboardSummary({ anchor: ANCHOR, weeks: 0 })).rejects.toThrow(
      'Количество недель должно быть целым положительным числом',
    );
    expect(healthService.getChannelHealthReport).not.toHaveBeenCalled();
  });
});
