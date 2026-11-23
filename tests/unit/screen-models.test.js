import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/lib/dates.js';
import { buildDashboardScreen, buildPeriodControl } from '../../src/services/metrics/screen-models.js';

const LAST_WEEK = '2026-11-09';
const FIRST_WEEK = addDays(LAST_WEEK, -7 * 11);

/**
 * @param {object} [overrides]
 * @returns {object} A dashboard summary with twelve complete weeks.
 */
function summaryWith({
  kpis = {
    spendCents: '1150770',
    spendLabel: '11 507,70',
    newCustomers: 263,
    newCustomersLabel: '263',
    cacCents: '4376',
    cacLabel: '43,76',
    romiPct: 713.11,
    romiLabel: '+713,1%',
  },
  verdict = { status: 'healthy', label: 'В норме', reason: 'Расходы окупаются.' },
  weeklySeries,
  channels = [],
  availableChannels = [
    { channelId: '1', code: 'instagram', name: 'Instagram' },
    { channelId: '2', code: 'google', name: 'Google Ads' },
  ],
} = {}) {
  const weeks =
    weeklySeries ??
    Array.from({ length: 12 }, (_, index) => ({
      weekStart: addDays(FIRST_WEEK, index * 7),
      weekLabel: `0${(index % 9) + 1}.11.2026`,
      spendCents: index === 11 ? '100000' : '90000',
      newCustomers: index === 11 ? 10 : 9,
      cacCents: index === 11 ? '10000' : '10000',
      cacLabel: '100,00',
      romiPct: 50,
      romiLabel: '+50,0%',
      attributedCents: index === 11 ? '150000' : '140000',
      attributedLabel: '1 400,00',
    }));

  return {
    period: { from: '2026-10-23', to: '2026-11-21', days: 30, anchor: '2026-11-21' },
    kpis,
    weeklySeries: weeks,
    channels,
    availableChannels,
    verdict,
  };
}

describe('dashboard screen model', () => {
  it('copies the KPI from the blended health row and labels the period and weeks', () => {
    const screen = buildDashboardScreen({ summary: summaryWith() });

    expect(screen.page).toBe('dashboard');
    expect(screen.kpis.spendLabel).toBe('11 507,70');
    expect(screen.kpis.newCustomersLabel).toBe('263');
    expect(screen.kpis.cacLabel).toBe('43,76');
    expect(screen.kpis.romiLabel).toBe('+713,1%');
    expect(screen.kpis.items.map((item) => item.id)).toEqual([
      'spend',
      'new-customers',
      'cac',
      'romi',
    ]);
    expect(screen.labels.period).toBe('30 дней');
    expect(screen.labels.weeks).toBe('12 недель');
    expect(screen.period.label).toBe('30 дней');
  });

  it('builds three charts with data, a factual caption and a duplicate table', () => {
    const screen = buildDashboardScreen({ summary: summaryWith() });

    expect(Object.keys(screen.charts)).toEqual(['cac', 'romi', 'spendRevenue']);
    expect(screen.charts.cac.hasData).toBe(true);
    expect(screen.charts.romi.hasData).toBe(true);
    expect(screen.charts.spendRevenue.hasData).toBe(true);

    expect(screen.charts.cac.unit).toBe('BYN');
    expect(screen.charts.romi.unit).toBe('%');
    expect(screen.charts.cac.caption).toContain('12 недель');
    expect(screen.charts.cac.caption).toContain('последняя 100,00 BYN');
    expect(screen.charts.cac.series.at(-1)).toMatchObject({ value: 10000, weekLabel: '03.11.2026' });
    expect(screen.charts.cac.table.columns.map((column) => column.key)).toEqual(['week', 'value']);
    expect(screen.charts.cac.table.rows).toHaveLength(12);
    expect(screen.charts.spendRevenue.table.columns.map((column) => column.key)).toEqual([
      'week',
      'spend',
      'revenue',
    ]);
  });

  it('keeps CAC and ROMI empty while a measured zero spend/revenue series still counts as data', () => {
    const weeklySeries = Array.from({ length: 12 }, (_, index) => ({
      weekStart: addDays(FIRST_WEEK, index * 7),
      weekLabel: `неделя ${index}`,
      spendCents: '0',
      newCustomers: 0,
      cacCents: null,
      cacLabel: '—',
      romiPct: null,
      romiLabel: '—',
      attributedCents: '0',
      attributedLabel: '0,00',
    }));
    const screen = buildDashboardScreen({ summary: summaryWith({ weeklySeries }) });

    expect(screen.charts.cac.hasData).toBe(false);
    expect(screen.charts.romi.hasData).toBe(false);
    // A zero is a measurement: the bars must render at zero instead of claiming there was no data.
    expect(screen.charts.spendRevenue.hasData).toBe(true);
    expect(screen.charts.cac.series.every((point) => point.value === null)).toBe(true);
    expect(screen.charts.cac.caption).toContain('последняя —');
  });

  it('marks spend/revenue empty only when the period has no weeks at all', () => {
    const screen = buildDashboardScreen({ summary: summaryWith({ weeklySeries: [] }) });

    expect(screen.charts.spendRevenue.hasData).toBe(false);
    expect(screen.charts.spendRevenue.series).toEqual([]);
  });

  it('keeps the honest empty dashboard: measured zeros stay zeros, CAC/ROMI stay dashes', () => {
    const screen = buildDashboardScreen({
      summary: summaryWith({
        kpis: {
          spendCents: '0',
          spendLabel: '0,00',
          newCustomers: 0,
          newCustomersLabel: '0',
          cacCents: null,
          cacLabel: '—',
          romiPct: null,
          romiLabel: '—',
        },
        verdict: { status: 'no_data', label: 'Нет данных', reason: 'Недостаточно данных.' },
      }),
    });

    expect(screen.kpis.spendLabel).toBe('0,00');
    expect(screen.kpis.newCustomersLabel).toBe('0');
    expect(screen.kpis.cacLabel).toBe('—');
    expect(screen.kpis.romiLabel).toBe('—');
    expect(screen.kpis.items.find((item) => item.id === 'spend').unit).toBe('BYN');
    expect(screen.kpis.items.find((item) => item.id === 'cac').unit).toBeNull();
    expect(screen.verdict.status).toBe('no_data');
  });

  it('marks a negative ROMI tile as bad without repainting a positive one', () => {
    const negative = buildDashboardScreen({
      summary: summaryWith({
        kpis: {
          spendCents: '100',
          spendLabel: '1,00',
          newCustomers: 1,
          newCustomersLabel: '1',
          cacCents: '100',
          cacLabel: '1,00',
          romiPct: -12.5,
          romiLabel: '−12,5%',
        },
      }),
    });

    expect(negative.kpis.items.find((item) => item.id === 'romi').tone).toBe('bad');
  });

  it('carries the channel filter and the full option list', () => {
    const summary = summaryWith({
      channels: [{ channelId: '1', code: 'instagram', name: 'Instagram' }],
    });
    const screen = buildDashboardScreen({ summary, channelIds: ['1'] });

    expect(screen.filter).toEqual({ channelIds: ['1'], selected: ['1'], active: true });
    expect(screen.channelOptions).toEqual([
      { value: '1', label: 'Instagram', selected: true },
      { value: '2', label: 'Google Ads', selected: false },
    ]);
    expect(screen.labels.filter).toContain('1 из 2');
    expect(screen.charts.cac.caption).toContain('выбрано 1 канал');
  });

  it('serialises to JSON without a bigint', () => {
    const screen = buildDashboardScreen({ summary: summaryWith() });

    expect(() => JSON.stringify(screen)).not.toThrow();
    expect(JSON.stringify(screen)).not.toMatch(/NaN|Infinity/);
  });
});

describe('period control', () => {
  it('marks the current option and preserves every other query key, including repeated filters', () => {
    const control = buildPeriodControl({ query: { days: 90, channelIds: ['1', '2'] } });

    expect(control.days).toBe(90);
    expect(control.options.map((option) => option.value)).toEqual([30, 90, 180]);
    expect(control.options.find((option) => option.value === 90).selected).toBe(true);
    expect(control.preserve).toEqual([
      { name: 'channelIds', value: '1' },
      { name: 'channelIds', value: '2' },
    ]);
  });

  it('defaults to the configured period when the query has none', () => {
    expect(buildPeriodControl({ query: {} }).days).toBe(30);
    expect(buildPeriodControl().preserve).toEqual([]);
  });

  it('drops an explicit from/to, because the generated form submits days and the schema rejects both', () => {
    const control = buildPeriodControl({ query: { from: '2026-10-01', to: '2026-10-31' } });

    expect(control.preserve).toEqual([]);
  });
});
