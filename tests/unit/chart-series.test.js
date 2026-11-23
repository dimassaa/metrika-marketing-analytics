import { describe, expect, it } from 'vitest';
import {
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
