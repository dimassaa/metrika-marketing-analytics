import { formatCentsToByn, formatRomi } from '../../lib/format.js';
import { hasPlottableData, toCacPoints, toRomiPoints, toSpendRevenuePoints } from '../../lib/series.js';

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

/**
 * @param {string[] | null} channelIds Active filter.
 * @returns {string} ` · выбрано 2 канала`, or an empty string for "all channels".
 */
function filterSuffix(channelIds) {
  if (!channelIds || channelIds.length === 0) return '';
  const count = channelIds.length;
  const tail = count % 100;
  const last = count % 10;
  const noun =
    tail >= 11 && tail <= 14 ? 'каналов' : last === 1 ? 'канал' : last >= 2 && last <= 4 ? 'канала' : 'каналов';
  return ` · выбрано ${count} ${noun}`;
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
 */export function buildSpendRevenueChart({ weeklySeries, channelIds = null }) {
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
