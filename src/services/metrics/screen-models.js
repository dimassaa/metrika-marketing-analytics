import { METRICS_CONFIG } from '../../config/metrics.js';
import { buildQueryString } from '../../lib/query.js';
import {
  buildCacChart,
  buildCacLtvScatter,
  buildChannelSpendChart,
  buildRomiChart,
  buildSpendRevenueChart,
  daysLabel,
  weeksLabel,
} from './chart-series.js';

/**
 * Screen models: the one place where a service result becomes the object the page and the API both receive.
 *
 * The EJS shell renders no metric values; React is the only renderer. Sharing the model between `data-props` and
 * `/api/v1/*` means the SSR test and the API test compare the same object, and a field added here cannot appear on
 * one path and not the other.
 */

/**
 * Builds the dashboard screen model.
 *
 * @param {{
 *   summary: Awaited<ReturnType<import('./dashboard.service.js').createDashboardService['getDashboardSummary']>>,
 *   channelIds?: string[] | null,
 * }} input `channelIds` is the validated filter, or null for every channel.
 * @returns {{
 *   page: 'dashboard',
 *   period: { from: string, to: string, days: number, anchor: string, label: string },
 *   filter: { channelIds: string[] | null, selected: string[], active: boolean },
 *   channelOptions: Array<{ value: string, label: string, selected: boolean }>,
 *   channels: object[],
 *   kpis: object,
 *   verdict: object,
 *   charts: object,
 *   labels: { period: string, weeks: string, anchor: string, filter: string },
 * }}
 */
export function buildDashboardScreen({ summary, channelIds = null }) {
  const periods = daysLabel(summary.period.days);
  const weeks = weeksLabel(summary.weeklySeries.length);
  const selected = channelIds ?? [];
  const selectedSet = new Set(selected);
  const { kpis } = summary;

  const filterLabel =
    selected.length === 0
      ? 'Все каналы'
      : `Выбрано ${selected.length} из ${summary.availableChannels.length}`;

  return {
    page: 'dashboard',
    period: { ...summary.period, label: periods },
    filter: {
      channelIds: channelIds === null ? null : [...selected],
      selected: [...selected],
      active: selected.length > 0,
    },
    channelOptions: summary.availableChannels.map((channel) => ({
      value: channel.channelId,
      label: channel.name,
      selected: selectedSet.has(channel.channelId),
    })),
    // The selected health rows are kept for the per-channel views of the dashboard (T2); the full dimension above
    // keeps the multi-select usable after a filter hides some options.
    channels: summary.channels,
    kpis: {
      ...kpis,
      items: [        {
          id: 'spend',
          label: 'Расход',
          value: kpis.spendLabel,
          unit: 'BYN',
          hint: `За ${periods}`,
          tone: null,
        },
        {
          id: 'new-customers',
          label: 'Новые клиенты',
          value: kpis.newCustomersLabel,
          unit: null,
          hint: `За ${periods}`,
          tone: null,
        },
        {
          id: 'cac',
          label: 'CAC',
          value: kpis.cacLabel,
          unit: kpis.cacCents === null ? null : 'BYN',
          hint: 'Стоимость нового клиента',
          tone: null,
        },
        {
          id: 'romi',
          label: 'ROMI',
          value: kpis.romiLabel,
          unit: null,
          hint: 'Возврат на маркетинг',
          // A negative ROMI is a loss, not a neutral number; the tile is the only KPI that can carry a "bad" tone
          // without duplicating the verdict badge.
          tone: kpis.romiPct !== null && kpis.romiPct < 0 ? 'bad' : null,
        },
      ],
    },
    verdict: { ...summary.verdict },
    charts: {
      cac: buildCacChart({ weeklySeries: summary.weeklySeries, channelIds }),
      romi: buildRomiChart({ weeklySeries: summary.weeklySeries, channelIds }),
      spendRevenue: buildSpendRevenueChart({ weeklySeries: summary.weeklySeries, channelIds }),
      // The two per-channel charts read `health.rows` from the same summary, so the filter, the KPI and these cards
      // cannot disagree and the dashboard adds no query.
      channelSpend: buildChannelSpendChart({ channels: summary.channels, channelIds }),
      cacLtv: buildCacLtvScatter({ channels: summary.channels, channelIds }),
    },
    labels: {
      period: periods,
      weeks,
      anchor: summary.period.anchor,
      filter: filterLabel,
    },
  };
}

/**
 * Builds the topbar period control for a page that has a daily window.
 *
 * `preserve` keeps every other query key as a hidden input, so changing the period does not silently drop the
 * channel filter or a sort order. Arrays are emitted as repeated inputs, which is exactly how `<select multiple>`
 * submits them. `from`/`to` are deliberately dropped: the topbar submits `days`, and the schema rejects an explicit
 * range together with `days`, so replaying an old range would make the generated form return a 400.
 * A page without a daily window (cohorts) passes `period: null` and renders no select at all.
 *
 * @param {{ query?: Record<string, unknown> }} [input] Validated query object.
 * @returns {{
 *   days: number,
 *   options: Array<{ value: number, label: string, selected: boolean }>,
 *   preserve: Array<{ name: string, value: string }>,
 * }}
 */
export function buildPeriodControl({ query = {} } = {}) {
  const days = Number(query.days ?? METRICS_CONFIG.periods.defaultDays);

  const preserve = [];
  for (const [name, value] of Object.entries(query)) {
    // `days` is the value this form sets; `from`/`to` conflict with it. Everything else is replayed.
    if (name === 'days' || name === 'from' || name === 'to') continue;
    if (Array.isArray(value)) {
      for (const item of value) preserve.push({ name, value: String(item) });
    } else if (value !== undefined && value !== null && value !== '') {
      preserve.push({ name, value: String(value) });
    }
  }

  return {
    days,
    options: METRICS_CONFIG.periods.options.map((option) => ({
      value: option,
      label: daysLabel(option),
      selected: option === days,
    })),
    preserve,
  };
}

/**
 * Page-only control model for the dashboard channel filter. It is deliberately not part of the screen model: the
 * API returns data, while a form action and a reset link are presentation of the same HTML frame.
 *
 * `resetHref` keeps the current period and drops only the channel selection, so "Сбросить" cannot silently send the
 * reader back to the default 30-day window. The `days` hidden input keeps the period when the multi-select submits.
 *
 * @param {{
 *   options?: Array<{ value: string, label: string, selected: boolean }>,
 *   days?: number,
 * }} [input] `options` come from the screen model's full `channelOptions`.
 * @returns {{
 *   action: string,
 *   days: number | undefined,
 *   size: number,
 *   active: boolean,
 *   selectedCount: number,
 *   total: number,
 *   options: Array<{ value: string, label: string, selected: boolean }>,
 *   resetHref: string,
 * }}
 */
export function buildChannelFilterControl({ options = [], days } = {}) {
  const query = buildQueryString({ days }, { channelIds: null });

  return {
    action: '/app/dashboard',
    days,
    // A multi-select needs a visible box; cap it so eight channels do not push the charts below the fold.
    size: Math.min(Math.max(options.length, 2), 6),
    active: options.some((option) => option.selected),
    selectedCount: options.filter((option) => option.selected).length,
    total: options.length,
    options,
    resetHref: query === '' ? '/app/dashboard' : `/app/dashboard?${query}`,
  };
}
