import { describe, expect, it } from 'vitest';
import { addDays, isoWeekStart } from '../../src/lib/dates.js';
import { ValidationError } from '../../src/lib/errors.js';
import { buildWeeklySeries, resolveWeekRange } from '../../src/services/metrics/weekly-series.js';

describe('resolveWeekRange', () => {
  it('keeps the complete week when the reporting date is its Sunday', () => {
    // 2026-11-22 is Sunday: the week 11-16..11-22 is fully observed and must be plotted.
    const { firstWeekStart, lastWeekStart } = resolveWeekRange('2026-11-22', 12);

    expect(lastWeekStart).toBe('2026-11-16');
    expect(addDays(lastWeekStart, 6)).toBe('2026-11-22');
    expect(firstWeekStart).toBe(addDays('2026-11-16', -7 * 11));
    expect(firstWeekStart).toBe(isoWeekStart(firstWeekStart));
  });

  it('drops the running week when the reporting date is not Sunday', () => {
    // 2026-11-21 is Saturday: 11-16..11-22 is still incomplete, so the last full week is 11-09..11-15.
    const { firstWeekStart, lastWeekStart } = resolveWeekRange('2026-11-21', 12);

    expect(lastWeekStart).toBe('2026-11-09');
    expect(addDays(lastWeekStart, 6)).toBe('2026-11-15');
    expect(firstWeekStart).toBe(addDays('2026-11-09', -7 * 11));
  });

  it('accepts the inclusive 1–52 bounds and rejects everything else before any work', () => {
    expect(resolveWeekRange('2026-11-22', 1)).toEqual({
      firstWeekStart: '2026-11-16',
      lastWeekStart: '2026-11-16',
    });
    expect(resolveWeekRange('2026-11-22', 52).firstWeekStart).toBe(addDays('2026-11-16', -7 * 51));

    for (const weeks of [0, -1, 1.5, 53, 1000]) {
      expect(() => resolveWeekRange('2026-11-22', weeks)).toThrow(ValidationError);
    }
  });
});

describe('buildWeeklySeries', () => {
  it('renders one bucket per complete week and keeps the Sunday bucket', () => {
    const { firstWeekStart } = resolveWeekRange('2026-11-22', 12);

    const series = buildWeeklySeries({
      firstWeekStart,
      weeks: 12,
      weeklyRows: [{ weekStart: '2026-11-16', spendCents: 70000n, newCustomers: 7 }],
      attributedRows: [{ weekStart: '2026-11-16', revenueCents: '140000' }],
    });

    expect(series).toHaveLength(12);
    expect(series.at(-1)).toEqual({
      weekStart: '2026-11-16',
      weekLabel: '16.11.2026',
      spendCents: '70000',
      newCustomers: 7,
      cacCents: '10000',
      romiPct: 100,
      attributedCents: '140000',
      attributedLabel: '1 400,00',
    });
  });

  it('ignores an attributed week outside the complete range instead of extending the axis', () => {
    const { firstWeekStart } = resolveWeekRange('2026-11-21', 2);

    const series = buildWeeklySeries({
      firstWeekStart,
      weeks: 2,
      weeklyRows: [],
      // The attribution service may return the running week 11-16..11-22; it is not part of a Saturday axis.
      attributedRows: [
        { weekStart: '2026-11-09', revenueCents: '50000' },
        { weekStart: '2026-11-16', revenueCents: '90000' },
      ],
    });

    expect(series.map((bucket) => bucket.weekStart)).toEqual(['2026-11-02', '2026-11-09']);
    expect(series[1].romiPct).toBeNull();
    expect(series[0].cacCents).toBeNull();
  });

  it('rejects an unbounded week count', () => {
    expect(() => buildWeeklySeries({ firstWeekStart: '2026-11-16', weeks: 53 })).toThrow(ValidationError);
  });
});
