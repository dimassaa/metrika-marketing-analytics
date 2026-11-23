import { formatCentsToByn, formatInteger, formatPercent, formatRomi } from '../../lib/format.js';
import { centsToApi, roundNumber } from '../../lib/metrics-math.js';
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
export function cohortsLabel(count) {
  const tail = count % 100;
  const last = count % 10;
  if (tail >= 11 && tail <= 14) return `${count} когорт`;
  if (last === 1) return `${count} когорта`;
  if (last >= 2 && last <= 4) return `${count} когорты`;
  return `${count} когорт`;
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
 * @param {{ channels: object[] }} input `channels` are JSON-safe health rows.
 * @returns {object}
 */
export function buildCacLtvScatter({ channels }) {
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
  const detail = `${count} · ${conclusion} · размер круга — новые клиенты`;

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
 * Keeping the numerator as bigint kopecks means the view-model never rounds a cohort twice: the per-cohort LTV rows
 * and this curve are two different aggregations of the same margins.
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
 *   horizonMonths: number }} input
 * @returns {object}
 * @throws {TypeError} When Recharts would have to round a kopeck string it cannot represent exactly.
 */
export function buildCohortLtvChart({ curve, horizonMonths }) {
  if (!Array.isArray(curve)) throw new TypeError('buildCohortLtvChart requires a curve array');
  if (!Number.isInteger(horizonMonths) || horizonMonths < 1) {
    throw new TypeError(`horizonMonths must be a positive integer, got ${String(horizonMonths)}`);
  }

  const cohortCount = curve[0]?.cohortCount ?? 0;
  const title = 'Накопленный LTV по когортам';
  // The caption names both the population and the null-margin aggregation rule: a reader must not think a zero
  // point means "no data" when it is a measured zero over completed cohorts.
  const detail =
    `Средний накопленный LTV по завершённым когортам, ${cohortsLabel(cohortCount)}` +
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
        { key: 'value', label: `Средний LTV${horizonMonths}, BYN`, numeric: true },
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
 * @param {{ channels: object[], periodLabel?: string }} input JSON-safe health rows.
 * @returns {object} Chart contract consumed by `ChartFrame` + `RomiBars`.
 * @throws {TypeError} When a present ROMI is not a finite number.
 */
export function buildRomiByChannelChart({ channels, periodLabel = '' }) {
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
  const detail = `${count}${periodLabel === '' ? '' : ` · ${periodLabel}`} · ${conclusion}`;

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
