import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/lib/dates.js';
import {
  buildChannelFilterControl,
  buildChannelsFilterControl,
  buildChannelsScreen,
  buildChannelsWeightsControl,
  buildDashboardScreen,
  buildPeriodControl,
} from '../../src/services/metrics/screen-models.js';
import { buildRomiByChannelChart } from '../../src/services/metrics/chart-series.js';

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
  channels = [
    {
      channelId: '1',
      code: 'instagram',
      name: 'Instagram',
      spendCents: '300000',
      revenueCents: '600000',
      newCustomers: 6,
      cacCents: '50000',
      ltv12Cents: '150000',
    },
    {
      channelId: '2',
      code: 'google',
      name: 'Google Ads',
      spendCents: '100000',
      revenueCents: '200000',
      newCustomers: 2,
      cacCents: '50000',
      ltv12Cents: '40000',
    },
    {
      channelId: '3',
      code: 'offline',
      name: 'Офлайн',
      spendCents: '0',
      revenueCents: '0',
      newCustomers: 0,
      cacCents: null,
      ltv12Cents: null,
    },
  ],
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

  it('builds five charts with data, a factual caption and a duplicate table', () => {
    const screen = buildDashboardScreen({ summary: summaryWith() });

    expect(Object.keys(screen.charts)).toEqual(['cac', 'romi', 'spendRevenue', 'channelSpend', 'cacLtv']);
    expect(screen.charts.cac.hasData).toBe(true);
    expect(screen.charts.romi.hasData).toBe(true);
    expect(screen.charts.spendRevenue.hasData).toBe(true);
    expect(screen.charts.channelSpend.hasData).toBe(true);
    expect(screen.charts.cacLtv.hasData).toBe(true);

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

  it('sorts channel spend by amount and states the leader and its share', () => {
    const screen = buildDashboardScreen({ summary: summaryWith() });
    const chart = screen.charts.channelSpend;

    expect(chart.series.map((row) => row.name)).toEqual(['Instagram', 'Google Ads', 'Офлайн']);
    expect(chart.series[0]).toMatchObject({ channelId: '1', spend: 300000, highlight: true });
    expect(chart.series[1].highlight).toBe(false);
    expect(chart.caption).toContain('3 канала');
    expect(chart.caption).toContain('лидер Instagram, 3 000,00 BYN (75% расхода)');
    expect(chart.table.rows).toHaveLength(3);
    expect(chart.table.rows[2].cells).toEqual({ channel: 'Офлайн', spend: '0,00' });
  });

  it('plots only complete CAC/LTV pairs while the duplicate table keeps every channel', () => {
    const screen = buildDashboardScreen({ summary: summaryWith() });
    const chart = screen.charts.cacLtv;

    expect(chart.series.map((point) => point.name)).toEqual(['Instagram', 'Google Ads']);
    expect(chart.series[0]).toMatchObject({ cac: 50000, ltv: 150000, newCustomers: 6 });
    expect(chart.caption).toContain('3 канала');
    expect(chart.caption).toContain('2 с CAC и LTV12 · LTV выше CAC у 1');
    expect(chart.caption).toContain('размер круга — новые клиенты');

    expect(chart.table.rows).toHaveLength(3);
    expect(chart.table.rows.find((row) => row.key === '3').cells).toEqual({
      channel: 'Офлайн',
      cac: '—',
      ltv: '—',
      customers: '0',
    });
  });

  it('keeps the honest empty scatter: no complete pair means no bubble and a table of dashes', () => {
    const channels = summaryWith().channels.map((channel) => ({
      ...channel,
      cacCents: null,
      ltv12Cents: null,
    }));
    const screen = buildDashboardScreen({ summary: summaryWith({ channels }) });

    expect(screen.charts.cacLtv.hasData).toBe(false);
    expect(screen.charts.cacLtv.series).toEqual([]);
    expect(screen.charts.cacLtv.caption).toContain('нет каналов с CAC и LTV12');
    expect(screen.charts.cacLtv.table.rows).toHaveLength(3);
    expect(screen.charts.cacLtv.table.rows.every((row) => row.cells.cac === '—')).toBe(true);
    // Spend is still measured, so its bars are not empty merely because the scatter is.
    expect(screen.charts.channelSpend.hasData).toBe(true);
  });

  it('carries the channel filter and the full option list', () => {
    const summary = summaryWith({
      channels: [
        {
          channelId: '1',
          code: 'instagram',
          name: 'Instagram',
          spendCents: '100000',
          newCustomers: 2,
          cacCents: '50000',
          ltv12Cents: '150000',
        },
      ],
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

  it('labels an explicit range instead of pretending it is the default 30 days', () => {
    const control = buildPeriodControl({
      query: { from: '2026-10-01', to: '2026-10-31' },
      period: { from: '2026-10-01', to: '2026-10-31', days: 31 },
    });

    expect(control.customRange).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
      label: '01.10.2026 — 31.10.2026',
    });
    expect(control.customRange.href).toContain('days=30');
    expect(control.customRange.href).not.toContain('from=');
    expect(control.customRange.href).not.toContain('to=');
    expect(buildPeriodControl({ query: { days: 90 } }).customRange).toBeNull();
  });
});

describe('channel filter control', () => {
  const options = [
    { value: '1', label: 'Instagram', selected: true },
    { value: '2', label: 'Google Ads', selected: false },
  ];

  it('builds a GET form that keeps a days period and resets only the channel selection', () => {
    const control = buildChannelFilterControl({ options, query: { days: 90, channelIds: ['1'] } });

    expect(control.action).toBe('/app/dashboard');
    expect(control.periodFields).toEqual([{ name: 'days', value: '90' }]);
    expect(control.active).toBe(true);
    expect(control.size).toBe(2);
    expect(control.selectedCount).toBe(1);
    expect(control.total).toBe(2);
    expect(control.resetHref).toBe('/app/dashboard?days=90');
  });

  it('replays an explicit from/to range instead of the resolved day count', () => {
    const control = buildChannelFilterControl({
      options,
      query: { from: '2026-10-01', to: '2026-10-31', channelIds: null },
    });

    // The resolved length (31) is not an allowed `days` option; emitting it would 400 on the form's own submit.
    expect(control.periodFields).toEqual([
      { name: 'from', value: '2026-10-01' },
      { name: 'to', value: '2026-10-31' },
    ]);
    expect(control.resetHref).toBe('/app/dashboard?from=2026-10-01&to=2026-10-31');
  });

  it('is inactive and caps the multi-select height for a long channel list', () => {
    const control = buildChannelFilterControl({
      options: Array.from({ length: 8 }, (_, index) => ({
        value: String(index + 1),
        label: `Канал ${index + 1}`,
        selected: false,
      })),
      query: { days: 30, channelIds: null },
    });

    expect(control.active).toBe(false);
    expect(control.size).toBe(6);
  });

  it('derives active state from the validated ids, even when no option matches them', () => {
    const control = buildChannelFilterControl({
      options: options.map((option) => ({ ...option, selected: false })),
      query: { days: 30, channelIds: ['999'] },
    });

    // The verdict is risky/no_data for this filter and the reset link must be reachable, even though the dimension
    // has no option 999 to tick.
    expect(control.active).toBe(true);
    expect(control.selectedCount).toBe(1);
    expect(control.options.every((option) => option.selected === false)).toBe(true);
  });

  it('emits no hidden period fields when the request used neither days nor bounds', () => {
    const control = buildChannelFilterControl({ options, query: { channelIds: null } });

    expect(control.periodFields).toEqual([]);
    expect(control.resetHref).toBe('/app/dashboard');
  });
});

describe('channels screen model', () => {
  /**
   * @returns {object} A channel list service result with one ranked row, one excluded row and a blended summary.
   */
  function channelList() {
    const rows = [
      {
        channelId: '1',
        code: 'instagram',
        name: 'Instagram',
        kind: 'paid',
        isActive: true,
        kindLabel: 'Платный',
        metaLabel: 'Платный',
        rank: 1,
        score: 70,
        status: 'healthy',
        statusLabel: 'В норме',
        spendCents: '300000',
        revenueCents: '600000',
        newCustomers: 6,
        cacCents: '50000',
        ltv12Cents: '150000',
        romiPct: 120,
        romiLabel: '+120,0%',
        paybackLabel: '4 мес.',
        ratioLabel: '3,000',
        contributions: [],
        stack: [],
        exclusion: null,
      },
      {
        channelId: '2',
        code: 'email',
        name: 'Email',
        kind: 'owned',
        isActive: true,
        kindLabel: 'Собственный',
        metaLabel: 'Собственный',
        rank: null,
        score: null,
        status: 'no_data',
        statusLabel: 'Мало данных',
        spendCents: '0',
        revenueCents: '0',
        newCustomers: 5,
        cacCents: '0',
        ltv12Cents: null,
        romiPct: null,
        romiLabel: '—',
        paybackLabel: '—',
        ratioLabel: '—',
        contributions: [],
        stack: [],
        exclusion: { reason: 'no_data', reasonLabel: 'Мало данных' },
      },
    ];

    return {
      period: { from: '2026-10-23', to: '2026-11-21', days: 30 },
      filters: { status: 'active', kind: 'paid' },
      weights: { cac: 0.3, romi: 0.3, ltvCac: 0.25, newCustomers: 0.15 },
      weightsBasisPoints: { cac: 300, romi: 300, ltvCac: 250, newCustomers: 150 },
      rows,
      blended: { code: 'blended', name: 'Все каналы' },
      excluded: [
        { channelId: '2', code: 'email', name: 'Email', reason: 'no_data', reasonLabel: 'Мало данных' },
        { code: 'blended', name: 'Все каналы', reason: 'blended', reasonLabel: 'Сводная строка' },
      ],
      sparklines: { 1: [{ weekLabel: '03.11.2026', value: 1000 }] },
      chart: { romi: buildRomiByChannelChart({ channels: rows, periodLabel: '30 дней' }) },
      labels: { period: '30 дней', channels: '2 канала', filter: 'Активные · Платные', sort: 'Место' },
    };
  }

  it('keeps the table and the excluded explanation consistent', () => {
    const screen = buildChannelsScreen({ list: channelList(), query: { sort: 'rank', dir: 'desc' } });

    expect(screen.page).toBe('channels');
    expect(screen.rows).toHaveLength(2);
    for (const entry of screen.excluded.filter((item) => item.code !== 'blended')) {
      const row = screen.rows.find((item) => item.channelId === entry.channelId);
      expect(row).toBeDefined();
      expect(row.rank).toBeNull();
    }
    expect(screen.rows.map((row) => row.code)).not.toContain('blended');
    expect(screen.excluded.at(-1)).toMatchObject({ code: 'blended', reason: 'blended' });
  });

  it('carries every channel with ROMI in the ROMI chart at the ranking scale', () => {
    const list = channelList();
    const screen = buildChannelsScreen({ list, query: { sort: 'rank', dir: 'desc' } });

    expect(screen.chart.romi.series.map((row) => row.channelId)).toEqual(['1']);
    expect(screen.chart.romi.table.rows).toHaveLength(1);
    expect(screen.chart.romi.series[0].highlight).toBe(true);
  });

  it('marks the active sort and preserves period, filters and weights in every link', () => {
    const screen = buildChannelsScreen({
      list: channelList(),
      query: { sort: 'cac', dir: 'asc', days: 90, weightsCustom: true },
    });

    const cac = screen.sortLinks.find((link) => link.field === 'cac');
    expect(cac.active).toBe(true);
    expect(cac.ariaSort).toBe('ascending');
    expect(cac.href).toContain('days=90');
    expect(cac.href).toContain('status=active');
    expect(cac.href).toContain('kind=paid');
    expect(cac.href).toContain('wCac=30');
    expect(cac.href).toContain('sort=cac');
    expect(screen.sortLinks.find((link) => link.field === 'rank').ariaSort).toBe('none');
    expect(screen.filters.resetHref).toContain('days=90');
    expect(screen.filters.resetHref).not.toContain('status=');
  });

  it('builds weight fields in percent and do not reset the list filters', () => {
    const control = buildChannelsWeightsControl({
      query: { days: 90 },
      filters: { status: 'active', kind: 'paid' },
      sort: 'cac',
      dir: 'asc',
      weights: { cac: 0.3, romi: 0.3, ltvCac: 0.25, newCustomers: 0.15 },
    });

    expect(control.fields.map((field) => [field.name, field.value])).toEqual([
      ['wCac', '30'],
      ['wRomi', '30'],
      ['wLtvCac', '25'],
      ['wNewCustomers', '15'],
    ]);
    expect(control.hiddenFields).toEqual([
      { name: 'days', value: '90' },
      { name: 'status', value: 'active' },
      { name: 'kind', value: 'paid' },
      { name: 'sort', value: 'cac' },
      { name: 'dir', value: 'asc' },
    ]);
    expect(control.resetHref).toBe('/app/channels?days=90&status=active&kind=paid&sort=cac&dir=asc');
  });

  it('replays non-default sort and weights in the filter form', () => {
    const control = buildChannelsFilterControl({
      query: { days: 90 },
      filters: { status: 'active', kind: 'all' },
      sort: 'cac',
      dir: 'asc',
      weights: { cac: 0.1, romi: 0.4, ltvCac: 0.3, newCustomers: 0.2 },
      weightsCustom: true,
    });

    expect(control.hiddenFields).toEqual([
      { name: 'days', value: '90' },
      { name: 'sort', value: 'cac' },
      { name: 'dir', value: 'asc' },
      { name: 'wCac', value: '10' },
      { name: 'wRomi', value: '40' },
      { name: 'wLtvCac', value: '30' },
      { name: 'wNewCustomers', value: '20' },
    ]);
  });

  it('replays decimal weights exactly instead of rounding them to whole percent', () => {
    const screen = buildChannelsScreen({
      list: channelList(),
      query: {
        sort: 'rank',
        dir: 'asc',
        weightsCustom: true,
        wCac: '33.3',
        wRomi: '33.3',
        wLtvCac: '33.3',
        wNewCustomers: '0.1',
      },
    });
    const rank = screen.sortLinks.find((link) => link.field === 'rank');

    expect(rank.href).toContain('wCac=33.3');
    expect(rank.href).toContain('wRomi=33.3');
    expect(rank.href).toContain('wLtvCac=33.3');
    expect(rank.href).toContain('wNewCustomers=0.1');

    const control = buildChannelsWeightsControl({
      query: {
        wCac: '33.3',
        wRomi: '33.3',
        wLtvCac: '33.3',
        wNewCustomers: '0.1',
      },
      filters: { status: 'all', kind: 'all' },
      sort: 'rank',
      dir: 'asc',
      weights: { cac: 0.333, romi: 0.333, ltvCac: 0.333, newCustomers: 0.001 },
    });
    expect(control.fields.map((field) => field.value)).toEqual(['33.3', '33.3', '33.3', '0.1']);
  });

  it('serialises without a bigint, NaN or Infinity', () => {
    const screen = buildChannelsScreen({ list: channelList(), query: { sort: 'rank', dir: 'desc' } });

    expect(() => JSON.stringify(screen)).not.toThrow();
    expect(JSON.stringify(screen)).not.toMatch(/NaN|Infinity/);
  });
});
