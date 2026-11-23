import { METRICS_CONFIG } from '../../config/metrics.js';
import { addDays, formatDateRu } from '../../lib/dates.js';
import { formatCentsToByn, formatInteger, formatPercent, formatRomi, formatSignedPercent } from '../../lib/format.js';
import { ATTRIBUTION_MODEL_LABELS, cohortsLabel } from '../../lib/metrics-labels.js';
import { roundNumber, percentChange, centsToApi } from '../../lib/metrics-math.js';
import {
  hasPlottableData,
  toCacPoints,
  toCacLtvPoints,
  toChannelSpendPoints,
  toRomiPoints,
  toSpendRevenuePoints,
} from '../../lib/series.js';

/**
 * Recharts needs a number; a present kopeck value must be an exact safe integer. A value above
 * `Number.MAX_SAFE_INTEGER` would be silently rounded, so it fails loudly instead.
 *
 * @param {string | null | undefined} cents Kopeck value as the API represents it.
 * @param {string} label Field name for the error message.
 * @returns {number | null}
 * @throws {TypeError} When a present value is not an exact integer kopeck string.
 */
function chartCentsValue(cents, label) {
  if (cents === null || cents === undefined) return null;
  if (typeof cents === 'string' && !/^-?\d+$/.test(cents)) {
    throw new TypeError(`${label} must be an integer, got ${JSON.stringify(cents)}`);
  }
  const value = Number(cents);
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be an integer, got ${JSON.stringify(cents)}`);
  }
  return value;
}

/** Recharts needs a number for the sparkline; kopecks stay below `Number.MAX_SAFE_INTEGER` for any realistic stand. */
function sparkValue(cents) {
  return chartCentsValue(cents, 'sparkline cacCents');
}

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

/** @param {number} count */
export function monthsLabel(count) {
  const tail = count % 100;
  const last = count % 10;
  if (tail >= 11 && tail <= 14) return `${count} месяцев`;
  if (last === 1) return `${count} месяц`;
  if (last >= 2 && last <= 4) return `${count} месяца`;
  return `${count} месяцев`;
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
 * Compact range for a chart caption: `01.09–22.11.2026` inside one year, full dates across years.
 *
 * A caption that names only the metric leaves the reader guessing which window the shape describes, so every chart
 * with a known boundary uses this helper. A missing bound is not invented: the range part is simply empty.
 *
 * @param {string} from `YYYY-MM-DD`.
 * @param {string} to `YYYY-MM-DD`.
 * @returns {string} Ready display range or an empty string.
 */
export function periodRangeLabel(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return '';
  const fromLabel = formatDateRu(from);
  const toLabel = formatDateRu(to);
  return from.slice(0, 4) === to.slice(0, 4)
    ? `${fromLabel.slice(0, 5)}–${toLabel}`
    : `${fromLabel}—${toLabel}`;
}

/**
 * @param {string} range Optional period range.
 * @returns {string} Range followed by a separator, or nothing when no range is known.
 */
function rangePrefix(range) {
  return range === '' || range === null || range === undefined ? '' : `${range} · `;
}

/**
 * Actual window of a weekly chart: first bucket start to the Sunday of the last bucket.
 *
 * The KPI window (30 days) and the 12-week line are deliberately different windows. A caption that reused the KPI
 * range would claim the line describes 30 days while its first point is three months old, so the chart computes its
 * own range from the buckets it draws and falls back to the supplied period only for an empty series.
 *
 * @param {Array<{ weekStart: string }>} weeklySeries
 * @param {string} fallback Range of the requested period.
 * @returns {string}
 */
function weeklyRange(weeklySeries, fallback) {
  const first = weeklySeries[0]?.weekStart;
  const last = weeklySeries.at(-1)?.weekStart;
  if (typeof first !== 'string' || typeof last !== 'string') return fallback;
  return periodRangeLabel(first, addDays(last, 6));
}

/**
 * Signed percent change against the previous point, or null when either point is missing or the baseline is zero.
 *
 * @param {number | null} current
 * @param {number | null} previous
 * @returns {string | null}
 */
function changeAgainstPrevious(current, previous) {
  if (current === null || previous === null) return null;
  const change = percentChange(current, previous);
  return change === null ? null : formatSignedPercent(change);
}

/**
 * Change in percentage points, keeping a tiny direction (`+<0,1 п.п.`) visible.
 *
 * @param {number | null} current
 * @param {number | null} previous
 * @returns {string | null}
 */
function pointsAgainstPrevious(current, previous) {
  if (current === null || previous === null) return null;
  return formatSignedPercent(current - previous).replace('%', ' п.п.');
}

/**
 * CAC line chart. Values stay in kopecks so the tooltip can use `formatCentsToByn` without a second rounding.
 *
 * The caption names the window, the last measured value and its change against the previous week. A missing previous
 * value is omitted rather than shown as zero: no baseline is not a 0 % change.
 *
 * @param {{ weeklySeries: object[], channelIds?: string[] | null, periodRange?: string }} input
 * @returns {object} Chart contract consumed by `ChartFrame` + `CacRomiLines`.
 */
export function buildCacChart({ weeklySeries, channelIds = null, periodRange = '' }) {
  const values = toCacPoints(weeklySeries);
  const hasData = hasPlottableData(values);
  const weeks = weeksLabel(weeklySeries.length);
  const last = weeklySeries.at(-1);
  const lastLabel =
    last === undefined
      ? '—'
      : `${formatCentsToByn(last.cacCents)}${last.cacCents === null ? '' : ' BYN'}`;
  const change = changeAgainstPrevious(values.at(-1) ?? null, values.length > 1 ? values.at(-2) : null);
  const conclusion = `последняя ${lastLabel}${change === null ? '' : `, к предыдущей ${change}`}`;
  const detail = `${rangePrefix(weeklyRange(weeklySeries, periodRange))}${weeks} · ${conclusion}${filterSuffix(channelIds)}`;

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
 * @param {{ weeklySeries: object[], channelIds?: string[] | null, periodRange?: string }} input
 * @returns {object}
 */
export function buildRomiChart({ weeklySeries, channelIds = null, periodRange = '' }) {
  const values = toRomiPoints(weeklySeries);
  const hasData = hasPlottableData(values);
  const weeks = weeksLabel(weeklySeries.length);
  const lastValue = values.at(-1) ?? null;
  const lastLabel = lastValue === null ? '—' : formatRomi(lastValue);
  const change = pointsAgainstPrevious(lastValue, values.length > 1 ? values.at(-2) : null);
  const conclusion = `последняя ${lastLabel}${change === null ? '' : `, к предыдущей ${change}`}`;
  const detail = `${rangePrefix(weeklyRange(weeklySeries, periodRange))}${weeks} · ${conclusion}${filterSuffix(channelIds)}`;

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
 * The caption states the period totals and which side is larger; the per-week values stay in the tooltip and table.
 *
 * @param {{ weeklySeries: object[], channelIds?: string[] | null, periodRange?: string }} input
 * @returns {object}
 */
export function buildSpendRevenueChart({ weeklySeries, channelIds = null, periodRange = '' }) {
  const points = toSpendRevenuePoints(weeklySeries);
  // Product rule: a flat zero line means "nothing was measured", not "the period spent zero". When every week has
  // zero spend and zero attributed revenue the frame shows its empty state; the zero values stay in the duplicate
  // table, which is where a reader can still see the requested weeks. KPI tiles keep their measured zeros — that is
  // a monthly total, a different statement from a shape that suggests a trend.
  const hasData = weeklySeries.some(
    (bucket) => String(bucket.spendCents) !== '0' || String(bucket.attributedCents) !== '0',
  );
  const weeks = weeksLabel(weeklySeries.length);
  const totalSpend = weeklySeries.reduce((sum, bucket) => sum + BigInt(bucket.spendCents), 0n);
  const totalRevenue = weeklySeries.reduce((sum, bucket) => sum + BigInt(bucket.attributedCents), 0n);
  const conclusion =
    totalSpend === totalRevenue
      ? 'расход и выручка равны'
      : totalRevenue > totalSpend
        ? `выручка больше расхода на ${formatCentsToByn(totalRevenue - totalSpend)} BYN`
        : `расход больше выручки на ${formatCentsToByn(totalSpend - totalRevenue)} BYN`;
  const detail = `${rangePrefix(weeklyRange(weeklySeries, periodRange))}${weeks} · ${conclusion}${filterSuffix(channelIds)}`;

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
 * @param {{ channels: object[], channelIds?: string[] | null, periodRange?: string }} input `channels` are JSON-safe
 *   health rows.
 * @returns {object}
 */
export function buildChannelSpendChart({ channels, channelIds = null, periodRange = '' }) {
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

  const detail = `${rangePrefix(periodRange)}${count} · ${conclusion}`;

  return {
    id: 'channel-spend',
    title: 'Расход по каналам',
    caption: captionOf('Расход по каналам', detail),
    ariaLabel: `Расход по каналам: ${detail}`,
    unit: 'BYN',
    // The product rule from the weekly bars applies here too: columns of zero height would read as a flat trend,
    // not as "no spend was measured". The channel rows and their zeros stay in the duplicate table.
    hasData: rows.some((row) => row.spend > 0),
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
 * @param {{ channels: object[], periodRange?: string }} input `channels` are JSON-safe health rows.
 * @returns {object}
 */
export function buildCacLtvScatter({ channels, periodRange = '' }) {
  const points = toCacLtvPoints(channels);
  const plottable = points.filter((point) => point.cac !== null && point.ltv !== null);
  const count = channelsLabel(points.length);
  const aboveCac = plottable.filter((point) => point.ltv > point.cac).length;

  const conclusion =
    plottable.length === 0
      ? 'нет каналов с CAC и LTV12'
      : `${plottable.length} с CAC и LTV12 · LTV выше CAC у ${aboveCac}`;
  // The bubble size has no visible axis, so the caption states it; a single-series legend would only repeat the
  // chart title and was removed.
  const detail = `${rangePrefix(periodRange)}${count} · ${conclusion} · размер круга — новые клиенты`;

  return {
    id: 'cac-ltv',
    title: 'CAC и LTV12 по каналам',
    caption: captionOf('CAC и LTV12 по каналам', detail),
    ariaLabel: `CAC и LTV12 по каналам: ${detail}`,
    unit: 'BYN',
    // A scatter with one missing pair would be an empty box, so plottability depends on complete pairs only.
    hasData: plottable.length > 0,
    series: plottable,
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

/**
 * Sparkline points for one channel: weekly CAC in kopecks, with `null` where the week had no customers.
 *
 * The component only draws the points; the window, the week labels and the CAC division already happened in the
 * service. A `null` is kept instead of becoming `0`, so `connectNulls={false}` leaves a real gap.
 *
 * @param {Array<{ weekLabel: string, cacCents: string | null }>} weeklyCacRows One complete week per row.
 * @returns {Array<{ weekLabel: string, value: number | null }>}
 * @throws {TypeError} When a present CAC is not an integer kopeck string.
 */
export function toSparklinePoints(weeklyCacRows) {
  if (!Array.isArray(weeklyCacRows)) return [];
  return weeklyCacRows.map((row) => ({
    weekLabel: row.weekLabel,
    value: sparkValue(row.cacCents),
  }));
}

/**
 * @param {unknown} value Kopeck string from the M3 matrix.
 * @param {string} context Error context: a cohort month and an offset.
 * @returns {bigint | null} Null when the cell has no observed cumulative margin.
 * @throws {TypeError} When a present value is not a non-negative integer kopeck string.
 */
function cumulativeCentsFromCell(value, context) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new TypeError(`${context} cumLtvCents must be a non-negative integer string, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/**
 * Weighted cumulative LTV curve over completed cohorts (metrics spec §2 and M4 owner decision 8).
 *
 * At every month offset the average is `Σ cumulative margin / Σ cohortSize`, using completed cohorts only. An
 * incomplete cohort is excluded from both operands. A completed cohort with no observed margin row contributes `0`
 * to the numerator but keeps its `cohortSize` in the denominator: that is a measured aggregate zero, not a missing
 * observation. The result is `null` only when no completed cohort can be observed at the offset at all.
 *
 * The source cells are already per-customer kopecks rounded half-up by the M3 matrix, so weighting them multiplies
 * an already rounded value back by the cohort size before the final division. The curve can therefore differ from a
 * single raw-margin division by at most one kopeck per cohort per offset — the bound of the published matrix's
 * accumulated rounding — while still describing the same completed cohorts and the same margin totals.
 *
 * @param {{
 *   cohorts: Array<{
 *     cohortMonth: string, cohortSize: number, isComplete: boolean,
 *     cells: Array<{ monthOffset: number, cumLtvCents: string | null }>,
 *   }>,
 *   horizonMonths: number,
 * }} input
 * @returns {Array<{ monthOffset: number, ltvCents: string | null, ltvLabel: string, cohortCount: number }>}
 * @throws {TypeError} When a size, a cell or the horizon is malformed.
 */
export function buildCumulativeLtvCurve({ cohorts, horizonMonths }) {
  if (!Array.isArray(cohorts)) throw new TypeError('buildCumulativeLtvCurve requires a cohorts array');
  if (!Number.isInteger(horizonMonths) || horizonMonths < 1) {
    throw new TypeError(`horizonMonths must be a positive integer, got ${String(horizonMonths)}`);
  }

  const complete = cohorts.filter((cohort) => cohort.isComplete === true);
  for (const cohort of complete) {
    if (!Number.isInteger(cohort.cohortSize) || cohort.cohortSize <= 0) {
      throw new TypeError(
        `complete cohort ${String(cohort.cohortMonth)} must have a positive cohortSize, got ${String(cohort.cohortSize)}`,
      );
    }
    if (!Array.isArray(cohort.cells)) {
      throw new TypeError(`complete cohort ${String(cohort.cohortMonth)} must carry a cells array`);
    }
  }

  const points = [];
  for (let monthOffset = 0; monthOffset < horizonMonths; monthOffset += 1) {
    let totalCents = 0n;
    let totalCustomers = 0;
    let cohortCount = 0;

    for (const cohort of complete) {
      const cell = cohort.cells.find((item) => item.monthOffset === monthOffset);
      // A completed cohort observed the whole horizon, so a missing cell is a broken matrix, not empty data.
      if (!cell) {
        throw new TypeError(
          `complete cohort ${String(cohort.cohortMonth)} has no cell for month offset ${monthOffset}`,
        );
      }
      const cellCents = cumulativeCentsFromCell(
        cell.cumLtvCents,
        `cohort ${String(cohort.cohortMonth)} offset ${monthOffset}`,
      );
      // The cell already holds per-customer cumulative LTV; weighting multiplies it back by the cohort size, and the
      // final division returns the weighted average per customer. Summing raw cells would average cohorts equally.
      if (cellCents !== null) totalCents += cellCents * BigInt(cohort.cohortSize);
      totalCustomers += cohort.cohortSize;
      cohortCount += 1;
    }

    let ltvCents = null;
    if (cohortCount > 0) {
      if (totalCustomers <= 0) {
        throw new TypeError(`cohort sizes at month offset ${monthOffset} must sum to a positive number`);
      }
      const customers = BigInt(totalCustomers);
      // Half-up division of non-negative kopecks; the same rounding identity the LTV service uses.
      ltvCents = (totalCents * 2n + customers) / (2n * customers);
    }

    points.push({
      monthOffset,
      ltvCents: centsToApi(ltvCents),
      ltvLabel: formatCentsToByn(ltvCents),
      cohortCount,
    });
  }

  return points;
}

/**
 * Chart contract for the cumulative LTV curve. Values stay in kopecks so the tooltip and the duplicate table use the
 * shared formatter; Recharts receives a number and refuses an unsafe one instead of silently losing precision.
 *
 * @param {{ curve: Array<{ monthOffset: number, ltvCents: string | null, cohortCount: number }>,
 *   horizonMonths: number, cohortRange?: string }} input
 * @returns {object}
 * @throws {TypeError} When Recharts would have to round a kopeck string it cannot represent exactly.
 */
export function buildCohortLtvChart({ curve, horizonMonths, cohortRange = '' }) {
  if (!Array.isArray(curve)) throw new TypeError('buildCohortLtvChart requires a curve array');
  if (!Number.isInteger(horizonMonths) || horizonMonths < 1) {
    throw new TypeError(`horizonMonths must be a positive integer, got ${String(horizonMonths)}`);
  }

  const cohortCount = curve[0]?.cohortCount ?? 0;
  const title = 'Накопленный LTV по когортам';
  // The caption names both the population and the null-margin aggregation rule: a reader must not think a zero
  // point means "no data" when it is a measured zero over completed cohorts.
  const detail =
    `${rangePrefix(cohortRange)}Средний накопленный LTV по завершённым когортам, ${cohortsLabel(cohortCount)}` +
    ` · горизонт ${monthsLabel(horizonMonths)}. Когорта без наблюдаемой маржи входит нулём.`;

  return {
    id: 'cohort-ltv',
    title,
    caption: captionOf(title, detail),
    ariaLabel: `${title}: ${detail}`,
    unit: 'BYN',
    hasData: curve.some((point) => point.ltvCents !== null),
    series: curve.map((point) => ({
      monthOffset: point.monthOffset,
      monthLabel: `${point.monthOffset} мес.`,
      ltvLabel: point.ltvLabel,
      cohortCount: point.cohortCount,
      value: chartCentsValue(point.ltvCents, 'curve ltvCents'),
    })),
    table: {
      columns: [
        { key: 'month', label: 'Смещение, мес.', numeric: true },
        { key: 'value', label: 'Средний накопленный LTV, BYN', numeric: true },
      ],
      rows: curve.map((point) => ({
        key: String(point.monthOffset),
        cells: { month: point.monthOffset, value: point.ltvLabel },
      })),
    },
  };
}

/**
 * The five funnel stages in acquisition order. The order is a product decision, not a property of the query, so it
 * lives in one frozen list instead of being derived from object keys.
 */
const FUNNEL_STAGES = Object.freeze([
  { key: 'impressions', label: 'Показы' },
  { key: 'clicks', label: 'Клики' },
  { key: 'leads', label: 'Лиды' },
  { key: 'newCustomers', label: 'Новые клиенты' },
  { key: 'orders', label: 'Заказы' },
]);

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {number}
 * @throws {TypeError} When a stage is not a non-negative integer.
 */
function requireFunnelCount(value, key) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`funnel ${key} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Screen model of the channel funnel.
 *
 * `sharePct` divides every stage by impressions, because impressions are the only stage every source measures from
 * the same starting point. The stages themselves come from different tables (statistics, customers, orders), so a
 * later stage can legitimately exceed the number of impressions; clipping at 100 would hide that inconsistency
 * instead of exposing it. A zero-impression funnel has no meaningful share and reports `null`.
 *
 * `<meter max="0">` is invalid and makes every browser render a full bar, so the display maximum is at least 1 even
 * for a completely empty funnel. The value stays the raw count; the meter maximum is the largest stage.
 *
 * @param {{ impressions: number, clicks: number, leads: number, newCustomers: number, orders: number }} funnel
 * @returns {{
 *   id: 'funnel',
 *   title: string,
 *   caption: string,
 *   ariaLabel: string,
 *   unit: null,
 *   hasData: boolean,
 *   scaleMax: number,
 *   meterMax: number,
 *   stages: Array<{
 *     key: string, label: string, value: number, valueLabel: string,
 *     sharePct: number | null, shareLabel: string, meterMax: number,
 *   }>,
 * }}
 * @throws {TypeError} When a stage is negative or fractional.
 */
export function buildFunnelSteps(funnel) {
  if (funnel === null || typeof funnel !== 'object') {
    throw new TypeError('buildFunnelSteps requires a funnel object');
  }

  const stages = FUNNEL_STAGES.map((stage) => ({
    ...stage,
    value: requireFunnelCount(funnel[stage.key], stage.key),
  }));
  const scaleMax = stages.reduce((max, stage) => Math.max(max, stage.value), 0);
  const meterMax = Math.max(1, scaleMax);
  const impressions = funnel.impressions;

  const detail = `${stages.length} этапов · максимум ${formatInteger(scaleMax)}`;
  return {
    id: 'funnel',
    title: 'Воронка канала',
    caption: `Воронка канала · ${detail}`,
    ariaLabel: `Воронка канала: ${detail}`,
    unit: null,
    hasData: scaleMax > 0,
    scaleMax,
    meterMax,
    stages: stages.map((stage) => {
      const sharePct =
        impressions === 0 ? null : roundNumber((stage.value * 100) / impressions, 2);
      return {
        ...stage,
        valueLabel: formatInteger(stage.value),
        sharePct,
        shareLabel: formatPercent(sharePct),
        meterMax,
      };
    }),
  };
}

/**
 * Horizontal ROMI bars, one per channel that has a finite ROMI.
 *
 * Bars are ordered by ROMI descending because the chart answers "who returns the most", and only the leader gets the
 * cyan accent. A channel without ROMI (zero spend or no customers) is not plotted but stays in the table of the
 * screen, which is the honest "не измерено" state.
 *
 * @param {{ channels: object[], periodLabel?: string, periodRange?: string }} input JSON-safe health rows.
 * @returns {object} Chart contract consumed by `ChartFrame` + `RomiBars`.
 * @throws {TypeError} When a present ROMI is not a finite number.
 */
export function buildRomiByChannelChart({ channels, periodLabel = '', periodRange = '' }) {
  const points = [];
  for (const channel of channels) {
    if (channel.romiPct === null || channel.romiPct === undefined) continue;
    if (!Number.isFinite(channel.romiPct)) {
      throw new TypeError(`channel romiPct must be finite, got ${String(channel.romiPct)}`);
    }
    points.push({
      channelId: channel.channelId,
      name: channel.name,
      romi: channel.romiPct,
      romiLabel: formatRomi(channel.romiPct),
    });
  }
  points.sort((left, right) => right.romi - left.romi || left.name.localeCompare(right.name, 'ru'));

  const count = channelsLabel(points.length);
  const leader = points[0] ?? null;
  const conclusion =
    leader === null ? 'нет каналов с измеренным ROMI' : `лидер ${leader.name}, ${leader.romiLabel}`;
  const periodPart = [periodLabel, periodRange].filter((part) => part !== '').join(', ');
  const detail = `${count}${periodPart === '' ? '' : ` · ${periodPart}`} · ${conclusion}`;

  return {
    id: 'romi',
    title: 'ROMI по каналам',
    caption: captionOf('ROMI по каналам', detail),
    ariaLabel: `ROMI по каналам: ${detail}`,
    unit: '%',
    hasData: points.length > 0,
    series: points.map((point, index) => ({
      ...point,
      highlight: index === 0,
    })),
    table: {
      columns: [
        { key: 'channel', label: 'Канал', numeric: false },
        { key: 'value', label: 'ROMI', numeric: true },
      ],
      rows: points.map((point) => ({
        key: point.channelId,
        cells: { channel: point.name, value: point.romiLabel },
      })),
    },
  };
}

/** Russian column headers of the attribution comparison; the model names themselves live in `metrics-labels.js`. */
export const ATTRIBUTION_COLUMN_LABELS = Object.freeze({
  last_touch: 'Последнее касание, BYN',
  first_touch: 'Первое касание, BYN',
  linear: 'Линейная, BYN',
});

/**
 * Grouped bars for the three attribution models over the channel axis.
 *
 * All three models stay visible regardless of the selected one: hiding two of them would let the screen look like a
 * single-model report. The chart uses the comparison rows, which already carry all three columns and are the same
 * numbers as the delta table, so the picture and the table cannot disagree.
 *
 * The caption names the selected model's leader and its share of that model's total, because the bars alone do not
 * say which allocation is currently being read.
 *
 * @param {{ comparison: object[], periodRange?: string, selectedModel?: string }} input
 * @returns {object} Chart contract consumed by `ChartFrame` + `AttributionBars`.
 */
export function buildAttributionChart({ comparison, periodRange = '', selectedModel = 'last_touch' }) {
  const series = comparison.map((row) => ({
    channelId: row.channelId,
    channelCode: row.channelCode,
    channelName: row.channelName,
    last_touch: chartCentsValue(row.lastTouchCents, 'lastTouchCents') ?? 0,
    first_touch: chartCentsValue(row.firstTouchCents, 'firstTouchCents') ?? 0,
    linear: chartCentsValue(row.linearCents, 'linearCents') ?? 0,
  }));

  // A zero comparison on every model is a measured "no attributed revenue": showing empty axes would suggest a broken
  // chart, so the frame explains it instead.
  const hasData = series.some(
    (row) => row.last_touch !== 0 || row.first_touch !== 0 || row.linear !== 0,
  );
  const total = series.reduce((sum, row) => sum + row[selectedModel], 0);
  const leader = series.reduce(
    (best, row) => (best === null || row[selectedModel] > best[selectedModel] ? row : best),
    null,
  );
  const modelLabel = ATTRIBUTION_MODEL_LABELS[selectedModel] ?? selectedModel;
  const conclusion =
    leader === null || total === 0
      ? `нет атрибутированной выручки по модели «${modelLabel}»`
      : `лидер ${leader.channelName}, ${formatCentsToByn(leader[selectedModel])} BYN` +
        ` (${Math.round((leader[selectedModel] * 100) / total)}% модели «${modelLabel}»)`;
  const windowDays = METRICS_CONFIG.attribution.windowDays;
  const detail = `${rangePrefix(periodRange)}${channelsLabel(series.length)} · ${conclusion}`;

  return {
    id: 'attribution-revenue',
    title: 'Выручка по моделям атрибуции',
    // The wording states the period, the touch window and the selected model's leader, none of which the bars show.
    caption: `Выручка по моделям атрибуции за период; окно касания — ${windowDays} дней · ${detail}`,
    ariaLabel: `Выручка по моделям атрибуции: ${detail}`,
    unit: 'BYN',
    selectedModel,
    hasData,
    series,
    table: {
      columns: [
        { key: 'channel', label: 'Канал', numeric: false },
        ...Object.entries(ATTRIBUTION_COLUMN_LABELS).map(([key, label]) => ({
          key,
          label,
          numeric: true,
        })),
      ],
      rows: comparison.map((row) => ({
        key: row.channelId,
        cells: {
          channel: row.channelName,
          last_touch: formatCentsToByn(row.lastTouchCents),
          first_touch: formatCentsToByn(row.firstTouchCents),
          linear: formatCentsToByn(row.linearCents),
        },
      })),
    },
  };
}
