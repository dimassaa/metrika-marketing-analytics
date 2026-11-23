import { formatCentsToByn, formatInteger, formatRomi } from '../../lib/format.js';
import {
  hasPlottableData,
  toCacPoints,
  toCacLtvPoints,
  toChannelSpendPoints,
  toRomiPoints,
  toSpendRevenuePoints,
} from '../../lib/series.js';

/**
 * Builds the chart half of a screen model: data, a factual caption and the duplicate table.
 *
 * Every chart carries its own table because the SVG alone is not accessible and a screenshot alone is not data.
 * Values keep the units of the source view-model (kopecks for money, percentages for ROMI); the React components
 * format them through the same `src/lib/format.js` as the server, so a tooltip and a table cell cannot drift.
 */

/** @param {number} weeks */
export function weeksLabel(weeks) {
  const tail = weeks % 100;
  const last = weeks % 10;
  if (tail >= 11 && tail <= 14) return `${weeks} недель`;
  if (last === 1) return `${weeks} неделя`;
  if (last >= 2 && last <= 4) return `${weeks} недели`;
  return `${weeks} недель`;
}

/** @param {number} days */
export function daysLabel(days) {
  const tail = days % 100;
  const last = days % 10;
  if (tail >= 11 && tail <= 14) return `${days} дней`;
  if (last === 1) return `${days} день`;
  if (last >= 2 && last <= 4) return `${days} дня`;
  return `${days} дней`;
}

/** @param {number} count */
export function channelsLabel(count) {
  const tail = count % 100;
  const last = count % 10;
  if (tail >= 11 && tail <= 14) return `${count} каналов`;
  if (last === 1) return `${count} канал`;
  if (last >= 2 && last <= 4) return `${count} канала`;
  return `${count} каналов`;
}

/**
 * @param {string[] | null} channelIds Active filter.
 * @returns {string} ` · выбрано 2 канала`, or an empty string for "all channels".
 */
function filterSuffix(channelIds) {
  if (!channelIds || channelIds.length === 0) return '';
  return ` · выбрано ${channelsLabel(channelIds.length)}`;
}

/**
 * @param {string} title
 * @param {string} detail Fact about the series (period length, last measured value, filter).
 * @returns {string}
 */
function captionOf(title, detail) {
  return `${title} · ${detail}`;
}

/**
 * CAC line chart. Values stay in kopecks so the tooltip can use `formatCentsToByn` without a second rounding.
 *
 * @param {{ weeklySeries: object[], channelIds?: string[] | null }} input
 * @returns {object} Chart contract consumed by `ChartFrame` + `CacRomiLines`.
 */
export function buildCacChart({ weeklySeries, channelIds = null }) {
  const values = toCacPoints(weeklySeries);
  const hasData = hasPlottableData(values);
  const weeks = weeksLabel(weeklySeries.length);
  const last = weeklySeries.at(-1);
  const lastLabel =
    last === undefined
      ? '—'
      : `${formatCentsToByn(last.cacCents)}${last.cacCents === null ? '' : ' BYN'}`;
  const detail = `${weeks} · последняя ${lastLabel}${filterSuffix(channelIds)}`;

  return {
    id: 'cac',
    title: 'CAC по неделям',
    caption: captionOf('CAC по неделям', detail),
    ariaLabel: `CAC по неделям: ${detail}`,
    unit: 'BYN',
    hasData,
    series: weeklySeries.map((bucket, index) => ({
      weekStart: bucket.weekStart,
      weekLabel: bucket.weekLabel,
      value: values[index],
    })),
    table: {
      columns: [
        { key: 'week', label: 'Неделя', numeric: false },
        { key: 'value', label: 'CAC, BYN', numeric: true },
      ],
      rows: weeklySeries.map((bucket) => ({
        key: bucket.weekStart,
        cells: { week: bucket.weekLabel, value: formatCentsToByn(bucket.cacCents) },
      })),
    },
  };
}

/**
 * ROMI line chart in percent. ROMI is never plotted on the CAC axis: the units differ by two orders of magnitude
 * and a second Y axis is forbidden by the design rules.
 *
 * @param {{ weeklySeries: object[], channelIds?: string[] | null }} input
 * @returns {object}
 */
export function buildRomiChart({ weeklySeries, channelIds = null }) {
  const values = toRomiPoints(weeklySeries);
  const hasData = hasPlottableData(values);
  const weeks = weeksLabel(weeklySeries.length);
  const last = weeklySeries.at(-1);
  const lastLabel = last === undefined || last.romiPct === null ? '—' : formatRomi(last.romiPct);
  const detail = `${weeks} · последняя ${lastLabel}${filterSuffix(channelIds)}`;

  return {
    id: 'romi',
    title: 'ROMI по неделям',
    caption: captionOf('ROMI по неделям', detail),
    ariaLabel: `ROMI по неделям: ${detail}`,
    unit: '%',
    hasData,
    series: weeklySeries.map((bucket, index) => ({
      weekStart: bucket.weekStart,
      weekLabel: bucket.weekLabel,
      value: values[index],
    })),
    table: {
      columns: [
        { key: 'week', label: 'Неделя', numeric: false },
        { key: 'value', label: 'ROMI, %', numeric: true },
      ],
      rows: weeklySeries.map((bucket) => ({
        key: bucket.weekStart,
        cells: { week: bucket.weekLabel, value: formatRomi(bucket.romiPct) },
      })),
    },
  };
}

/**
 * Grouped spend/revenue bars. Revenue is attributed revenue of the selected model, never raw order revenue: the
 * bars and the ROMI line above them must use the same numerator.
 *
 * @param {{ weeklySeries: object[], channelIds?: string[] | null }} input
 * @returns {object}
 */
export function buildSpendRevenueChart({ weeklySeries, channelIds = null }) {
  const points = toSpendRevenuePoints(weeklySeries);
  // Spend and attributed revenue are always measured (a string, including `0`), so a non-empty series is data even
  // when every value is zero. Treating a measured zero as "no data" would hide the honest answer: the period spent
  // nothing. Only a series with no weeks at all is empty.
  const hasData = weeklySeries.length > 0;
  const weeks = weeksLabel(weeklySeries.length);
  const last = weeklySeries.at(-1);
  const lastLabel = last === undefined ? '—' : last.weekLabel;
  const detail = `${weeks} · последняя ${lastLabel}${filterSuffix(channelIds)}`;

  return {
    id: 'spend-revenue',
    title: 'Расход и выручка по неделям',
    caption: captionOf('Расход и выручка по неделям', detail),
    ariaLabel: `Расход и атрибутированная выручка по неделям: ${detail}`,
    unit: 'BYN',
    hasData,
    series: weeklySeries.map((bucket, index) => ({
      weekStart: bucket.weekStart,
      weekLabel: bucket.weekLabel,
      spend: points[index].spend,
      revenue: points[index].revenue,
    })),
    table: {
      columns: [
        { key: 'week', label: 'Неделя', numeric: false },
        { key: 'spend', label: 'Расход, BYN', numeric: true },
        { key: 'revenue', label: 'Выручка, BYN', numeric: true },
      ],
      rows: weeklySeries.map((bucket) => ({
        key: bucket.weekStart,
        cells: {
          week: bucket.weekLabel,
          spend: formatCentsToByn(bucket.spendCents),
          revenue: formatCentsToByn(bucket.attributedCents),
        },
      })),
    },
  };
}

/**
 * Horizontal spend-by-channel bars. The rows are `health.rows` of the dashboard summary, already filtered by the
 * active channel selection; this chart adds no request and no second source of truth.
 *
 * The caption names the leader and its share, so the card answers "куда уходят деньги" before the reader decodes
 * the bars. With no filter the largest channel is highlighted; with a filter every shown channel is selected, so
 * highlighting is uniform.
 *
 * @param {{ channels: object[], channelIds?: string[] | null }} input `channels` are JSON-safe health rows.
 * @returns {object}
 */
export function buildChannelSpendChart({ channels, channelIds = null }) {
  const selected = channelIds && channelIds.length > 0 ? new Set(channelIds) : null;
  const rows = toChannelSpendPoints(channels).sort(
    (left, right) => right.spend - left.spend || left.name.localeCompare(right.name, 'ru'),
  );
  const total = rows.reduce((sum, row) => sum + row.spend, 0);
  const top = rows[0] ?? null;
  const count = channelsLabel(rows.length);

  let conclusion;
  if (top === null) conclusion = 'нет каналов для расхода';
  else if (total === 0) conclusion = 'расход нулевой';
  else {
    const share = Math.round((top.spend * 100) / total);
    conclusion = `лидер ${top.name}, ${formatCentsToByn(top.spend)} BYN (${share}% расхода)`;
  }

  const detail = `${count} · ${conclusion}`;

  return {
    id: 'channel-spend',
    title: 'Расход по каналам',
    caption: captionOf('Расход по каналам', detail),
    ariaLabel: `Расход по каналам: ${detail}`,
    unit: 'BYN',
    // A channel is a measured zero until its spend row says otherwise: only a filter with no matching channel has
    // nothing to draw. This mirrors the weekly spend/revenue decision.
    hasData: rows.length > 0,
    series: rows.map((row, index) => ({
      ...row,
      highlight: selected === null ? index === 0 : selected.has(row.channelId),
    })),
    table: {
      columns: [
        { key: 'channel', label: 'Канал', numeric: false },
        { key: 'spend', label: 'Расход, BYN', numeric: true },
      ],
      rows: rows.map((row) => ({
        key: row.channelId,
        cells: { channel: row.name, spend: formatCentsToByn(row.spend) },
      })),
    },
  };
}

/**
 * CAC×LTV12 scatter, one bubble per channel. Both axes are money in BYN and the bubble size is the channel's new
 * customer count; there is deliberately no third axis.
 *
 * A channel missing CAC or LTV12 is not plotted (a point would claim a measurement that does not exist) but stays
 * in the duplicate table with a dash, so the reader can see which channels were filtered out of the picture and why.
 *
 * @param {{ channels: object[], channelIds?: string[] | null }} input `channels` are JSON-safe health rows.
 * @returns {object}
 */
export function buildCacLtvScatter({ channels, channelIds = null }) {
  const selected = channelIds && channelIds.length > 0 ? new Set(channelIds) : null;
  const points = toCacLtvPoints(channels);
  const plottable = points.filter((point) => point.cac !== null && point.ltv !== null);
  const count = channelsLabel(points.length);
  const aboveCac = plottable.filter((point) => point.ltv > point.cac).length;

  const conclusion =
    plottable.length === 0
      ? 'нет каналов с CAC и LTV12'
      : `${plottable.length} с CAC и LTV12 · LTV выше CAC у ${aboveCac}`;
  const detail = `${count} · ${conclusion}`;

  return {
    id: 'cac-ltv',
    title: 'CAC и LTV12 по каналам',
    caption: captionOf('CAC и LTV12 по каналам', detail),
    ariaLabel: `CAC и LTV12 по каналам: ${detail}`,
    unit: 'BYN',
    // A scatter with one missing pair would be an empty box, so plottability depends on complete pairs only.
    hasData: plottable.length > 0,
    series: plottable.map((point) => ({
      ...point,
      highlight: selected === null ? true : selected.has(point.channelId),
    })),
    // The table keeps every filtered channel, including the ones the chart cannot place.
    table: {
      columns: [
        { key: 'channel', label: 'Канал', numeric: false },
        { key: 'cac', label: 'CAC, BYN', numeric: true },
        { key: 'ltv', label: 'LTV12, BYN', numeric: true },
        { key: 'customers', label: 'Новые клиенты', numeric: true },
      ],
      rows: points.map((point) => ({
        key: point.channelId,
        cells: {
          channel: point.name,
          cac: formatCentsToByn(point.cac),
          ltv: formatCentsToByn(point.ltv),
          customers: formatInteger(point.newCustomers),
        },
      })),
    },
  };
}
