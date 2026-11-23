import { describe, expect, it } from 'vitest';
import { buildRomiByChannelChart, toSparklinePoints } from '../../src/services/metrics/chart-series.js';

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
