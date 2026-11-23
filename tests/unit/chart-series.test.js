import { describe, expect, it } from 'vitest';
import {
  buildCumulativeLtvCurve,
  buildFunnelSteps,
  buildRomiByChannelChart,
  toSparklinePoints,
} from '../../src/services/metrics/chart-series.js';

describe('toSparklinePoints', () => {
  it('keeps week order and a null gap', () => {
    const points = toSparklinePoints([
      { weekLabel: '03.11.2026', cacCents: '10000' },
      { weekLabel: '10.11.2026', cacCents: null },
      { weekLabel: '17.11.2026', cacCents: '0' },
    ]);

    expect(points).toEqual([
      { weekLabel: '03.11.2026', value: 10000 },
      { weekLabel: '10.11.2026', value: null },
      { weekLabel: '17.11.2026', value: 0 },
    ]);
  });

  it('returns an empty array for an empty series', () => {
    expect(toSparklinePoints([])).toEqual([]);
  });

  it('rejects a malformed kopeck value instead of drawing it', () => {
    expect(() => toSparklinePoints([{ weekLabel: '03.11.2026', cacCents: '1.5' }])).toThrow(
      'integer',
    );
  });
});

describe('buildRomiByChannelChart', () => {
  it('plots every channel with a measured ROMI, highest first, and keeps the rest out', () => {
    const chart = buildRomiByChannelChart({
      channels: [
        { channelId: '1', name: 'Alpha', romiPct: 120 },
        { channelId: '2', name: 'Beta', romiPct: 340 },
        { channelId: '3', name: 'Gamma', romiPct: null },
      ],
      periodLabel: '30 дней',
    });

    expect(chart.hasData).toBe(true);
    expect(chart.series.map((row) => row.name)).toEqual(['Beta', 'Alpha']);
    expect(chart.series[0]).toMatchObject({ channelId: '2', highlight: true, romi: 340 });
    expect(chart.series[1].highlight).toBe(false);
    expect(chart.caption).toContain('2 канала');
    expect(chart.caption).toContain('лидер Beta');
    expect(chart.caption).toContain('30 дней');
    expect(chart.table.rows.map((row) => row.cells.channel)).toEqual(['Beta', 'Alpha']);
    expect(chart.unit).toBe('%');
  });

  it('is empty when no channel has ROMI', () => {
    const chart = buildRomiByChannelChart({
      channels: [{ channelId: '1', name: 'Alpha', romiPct: null }],
    });

    expect(chart.hasData).toBe(false);
    expect(chart.series).toEqual([]);
    expect(chart.caption).toContain('нет каналов с измеренным ROMI');
  });
});

describe('buildCumulativeLtvCurve', () => {
  /**
   * @param {object} [overrides]
   * @returns {object} One cohort row in the M3 matrix shape.
   */
  function cohort({
    cohortMonth = '2026-01-01',
    cohortSize = 100,
    isComplete = true,
    values = ['1000', '2000'],
  } = {}) {
    return {
      cohortMonth,
      cohortLabel: cohortMonth.slice(0, 7),
      cohortSize,
      isComplete,
      cells: values.map((cumLtvCents, monthOffset) => ({
        monthOffset,
        retentionPct: 100 - monthOffset,
        cumLtvCents,
      })),
    };
  }

  it('excludes incomplete cohorts and weights the completed ones by cohort size', () => {
    const curve = buildCumulativeLtvCurve({
      horizonMonths: 2,
      cohorts: [
        cohort({ cohortSize: 100, values: ['1000', '2000'] }),
        cohort({ cohortSize: 400, cohortMonth: '2026-02-01', values: ['0', '500'] }),
        // A partial cohort with huge values must not enter the average.
        cohort({ cohortSize: 999, cohortMonth: '2026-03-01', isComplete: false, values: ['999999', '999999'] }),
      ],
    });

    // (100 × 1 000 + 400 × 0) / 500 = 200; (100 × 2 000 + 400 × 500) / 500 = 800.
    expect(curve).toEqual([
      { monthOffset: 0, ltvCents: '200', ltvLabel: '2,00', cohortCount: 2 },
      { monthOffset: 1, ltvCents: '800', ltvLabel: '8,00', cohortCount: 2 },
    ]);
  });

  it('lets a completed cohort with no observed margin contribute zero and its size', () => {
    const curve = buildCumulativeLtvCurve({
      horizonMonths: 1,
      cohorts: [
        cohort({ cohortSize: 100, values: [null] }),
        cohort({ cohortSize: 400, cohortMonth: '2026-02-01', values: ['100'] }),
      ],
    });

    // (100 × 0 + 400 × 100) / 500 = 80, not the 100 that dropping the null cohort would produce.
    expect(curve[0]).toEqual({ monthOffset: 0, ltvCents: '80', ltvLabel: '0,80', cohortCount: 2 });
  });

  it('is null only when no completed cohort is observable at an offset', () => {
    const curve = buildCumulativeLtvCurve({
      horizonMonths: 2,
      cohorts: [cohort({ isComplete: false, values: ['1000', '2000'] })],
    });

    expect(curve).toEqual([
      { monthOffset: 0, ltvCents: null, ltvLabel: '—', cohortCount: 0 },
      { monthOffset: 1, ltvCents: null, ltvLabel: '—', cohortCount: 0 },
    ]);
  });

  it('reports a measured aggregate zero when every completed cohort lacks margin rows', () => {
    const curve = buildCumulativeLtvCurve({
      horizonMonths: 1,
      cohorts: [cohort({ cohortSize: 100, values: [null] }), cohort({ cohortSize: 400, values: [null] })],
    });

    // The aggregation rule turns a missing margin row into zero at the cohort level; an empty denominator is the
    // only honest null.
    expect(curve[0]).toMatchObject({ ltvCents: '0', ltvLabel: '0,00', cohortCount: 2 });
  });

  it('emits one kopeck-string point per month offset in the requested horizon', () => {
    const curve = buildCumulativeLtvCurve({
      horizonMonths: 3,
      cohorts: [cohort({ values: ['1000', '2500', '4000'] })],
    });

    expect(curve.map((point) => point.monthOffset)).toEqual([0, 1, 2]);
    expect(curve.map((point) => point.ltvCents)).toEqual(['1000', '2500', '4000']);
    expect(curve.map((point) => point.cohortCount)).toEqual([1, 1, 1]);
    expect(curve.every((point) => typeof point.ltvCents === 'string')).toBe(true);
  });
});

describe('buildFunnelSteps', () => {
  it('keeps the five stages in their fixed acquisition order', () => {
    const funnel = buildFunnelSteps({
      impressions: 120000,
      clicks: 3200,
      leads: 160,
      newCustomers: 10,
      orders: 14,
    });

    expect(funnel.stages.map((stage) => stage.key)).toEqual([
      'impressions',
      'clicks',
      'leads',
      'newCustomers',
      'orders',
    ]);
    expect(funnel.stages.map((stage) => stage.label)).toEqual([
      'Показы',
      'Клики',
      'Лиды',
      'Новые клиенты',
      'Заказы',
    ]);
    expect(funnel.stages.map((stage) => stage.value)).toEqual([120000, 3200, 160, 10, 14]);
    expect(funnel.stages[0].sharePct).toBe(100);
    expect(funnel.stages[1].sharePct).toBeCloseTo(2.67, 2);
    expect(funnel.scaleMax).toBe(120000);
    expect(funnel.meterMax).toBe(120000);
    expect(funnel.hasData).toBe(true);
  });

  it('has no share and a usable meter when impressions are zero', () => {
    const funnel = buildFunnelSteps({
      impressions: 0,
      clicks: 0,
      leads: 0,
      newCustomers: 0,
      orders: 0,
    });

    expect(funnel.stages.every((stage) => stage.sharePct === null)).toBe(true);
    expect(funnel.stages.every((stage) => stage.shareLabel === '—')).toBe(true);
    // `<meter max="0">` is invalid HTML and would make every stage look full; the meter keeps a real maximum.
    expect(funnel.stages.every((stage) => stage.meterMax >= 1)).toBe(true);
    expect(funnel.scaleMax).toBe(0);
    expect(funnel.meterMax).toBe(1);
    expect(funnel.hasData).toBe(false);
  });

  it('does not clip a later stage above 100% because stages come from different sources', () => {
    const funnel = buildFunnelSteps({
      impressions: 100,
      clicks: 90,
      leads: 10,
      newCustomers: 120,
      orders: 5,
    });

    const customers = funnel.stages.find((stage) => stage.key === 'newCustomers');
    expect(customers.sharePct).toBe(120);
    expect(customers.shareLabel).toBe('120,0%');
  });

  it('keeps a monotonic display maximum at least one even for a single measured stage', () => {
    const funnel = buildFunnelSteps({
      impressions: 0,
      clicks: 5,
      leads: 0,
      newCustomers: 0,
      orders: 0,
    });

    expect(funnel.scaleMax).toBe(5);
    expect(funnel.meterMax).toBe(5);
    expect(funnel.stages.find((stage) => stage.key === 'clicks').sharePct).toBeNull();
  });

  it('rejects a negative or fractional counter instead of drawing an impossible stage', () => {
    expect(() =>
      buildFunnelSteps({ impressions: -1, clicks: 0, leads: 0, newCustomers: 0, orders: 0 }),
    ).toThrow(TypeError);
    expect(() =>
      buildFunnelSteps({ impressions: 1.5, clicks: 0, leads: 0, newCustomers: 0, orders: 0 }),
    ).toThrow(TypeError);
  });
});
