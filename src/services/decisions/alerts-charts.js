import { addDays, formatDateRu } from '../../lib/dates.js';
import { formatCentsToByn, formatSignedPercent } from '../../lib/format.js';
import { hasPlottableData, toCacPoints } from '../../lib/series.js';
import { METRICS_CONFIG } from '../../config/metrics.js';
import { bynDecimalToCents } from './screen-models.js';

/**
 * Alerts chart models.
 *
 * The screen needs one weekly CAC line for the most relevant channel. That series comes from
 * `metricsRepository.listWeeklySeries` for that channel, never from the stored alert values: a CAC line rebuilt from
 * two alert snapshots would interpolate weeks that were never measured.
 */

/** @param {string} severity @returns {{ num: bigint, den: bigint }} */
function spikeRatio(severity) {
  const ratio =
    severity === 'critical'
      ? METRICS_CONFIG.alerts.cacSpikeCriticalRatio
      : METRICS_CONFIG.alerts.cacSpikeWarnRatio;
  return { num: BigInt(ratio.num), den: BigInt(ratio.den) };
}

/**
 * @param {bigint} total
 * @param {bigint} divisor Positive divisor.
 * @returns {bigint} `total / divisor`, rounded half up, without a float.
 */
function divideHalfUp(total, divisor) {
  return (total * 2n + divisor) / (2n * divisor);
}

/** @param {string} severity @returns {number} `critical` outranks `warning`. */
function severityRank(severity) {
  return severity === 'critical' ? 2 : severity === 'warning' ? 1 : 0;
}

/**
 * Delta of a CAC spike against the previous window, in kopecks.
 *
 * The stored `threshold` is `previousCAC × ratio` and `value` is the current CAC, so the previous CAC can be
 * recovered exactly enough for ranking. A channel without a spike row ranks with a zero delta.
 *
 * @param {object} channel Aggregate for one channel.
 * @returns {bigint}
 */
function cacDelta(channel) {
  const spike = channel.spike;
  if (!spike) return 0n;
  const current = bynDecimalToCents(spike.value);
  const threshold = bynDecimalToCents(spike.threshold);
  if (current === null || threshold === null) return 0n;
  const { num, den } = spikeRatio(spike.severity);
  const previous = divideHalfUp(threshold * den, num);
  return current - previous;
}

/**
 * Chooses the channel whose weekly CAC line the alerts screen shows.
 *
 * A channel filter wins. Otherwise the rule is deterministic: highest severity (`critical` > `warning`), then the
 * largest Δ CAC against the previous window, then the smaller `channelId`. Without alerts there is no problem
 * channel and the screen shows the honest empty line.
 *
 * @param {{
 *   rows: Array<{ channelId: string, channelName: string, rule: string, severity: string,
 *     value: string, threshold: string }>,
 *   channelId?: string | null,
 *   channelName?: string | null,
 * }} input `rows` are the candidate alerts to rank — normally every active alert of the current window, not the
 *   filtered page, so status and pagination cannot change the chosen channel.
 * @returns {{ channelId: string, channelName: string } | null}
 */
export function selectAlertChartChannel({ rows = [], channelId = null, channelName = null }) {
  if (channelId) return { channelId, channelName: channelName ?? channelId };

  /** @type {Map<string, { channelId: string, channelName: string, severity: string, spike: object | null }>} */
  const byChannel = new Map();
  for (const row of rows) {
    if (!row?.channelId) continue;
    const entry = byChannel.get(row.channelId) ?? {
      channelId: row.channelId,
      channelName: row.channelName ?? row.channelId,
      severity: row.severity,
      spike: null,
    };
    if (severityRank(row.severity) > severityRank(entry.severity)) entry.severity = row.severity;
    const betterSpike = row.rule === 'cac_spike' &&
      (entry.spike === null || severityRank(row.severity) > severityRank(entry.spike.severity));
    if (betterSpike) entry.spike = row;
    byChannel.set(row.channelId, entry);
  }

  let best = null;
  let bestRank = -1;
  let bestDelta = 0n;
  for (const entry of byChannel.values()) {
    const rank = severityRank(entry.severity);
    const delta = cacDelta(entry);
    // Numeric id comparison: ids are BIGINT digit strings, so a lexical compare would rank "10" below "9".
    const smallerId = best !== null && BigInt(entry.channelId) < BigInt(best.channelId);
    if (
      best === null ||
      rank > bestRank ||
      (rank === bestRank && delta > bestDelta) ||
      (rank === bestRank && delta === bestDelta && smallerId)
    ) {
      best = entry;
      bestRank = rank;
      bestDelta = delta;
    }
  }

  return best === null ? null : { channelId: best.channelId, channelName: best.channelName };
}

/**
 * @param {Array<{ weekStart: string }>} weeklySeries
 * @returns {string} First Monday — last Sunday of the drawn series.
 */
function weeklyRangeLabel(weeklySeries) {
  const first = weeklySeries[0]?.weekStart;
  const last = weeklySeries.at(-1)?.weekStart;
  if (typeof first !== 'string' || typeof last !== 'string') return '';
  const from = formatDateRu(first);
  const to = formatDateRu(addDays(last, 6));
  return first.slice(0, 4) === addDays(last, 6).slice(0, 4)
    ? `${from.slice(0, 5)}–${to}`
    : `${from}—${to}`;
}

/**
 * @param {Array<number | null>} values
 * @returns {number | null} Percent change from the first measured week to the last, or null without a baseline.
 */
function trendOf(values) {
  const measured = values.filter((value) => value !== null);
  if (measured.length < 2) return null;
  const first = measured[0];
  const last = measured.at(-1);
  if (!(first > 0)) return null;
  return ((last - first) * 100) / first;
}

/**
 * Weekly CAC line for the problem channel.
 *
 * `weeklySeries` is the `listWeeklySeries` view-model for one channel; the builder does not aggregate alerts and
 * does not invent a point for a week without customers (`toCacPoints` keeps `null` and the line leaves a gap).
 *
 * @param {{
 *   channelName?: string | null,
 *   weeklySeries?: object[],
 * }} input
 * @returns {object} Chart contract consumed by `ChartFrame` + `CacRomiLines`.
 */
export function buildAlertChannelChart({
  channelName = null,
  weeklySeries = [],
}) {
  const values = toCacPoints(weeklySeries);
  const hasData = hasPlottableData(values);
  const weeks = weeklySeries.length;
  const windowWeeks = weeks === 0 ? METRICS_CONFIG.dashboard.weeks : weeks;
  const measured = values.filter((value) => value !== null);
  const measuredWeeks = measured.length;
  // The last bucket may be an unmeasured week (no customers), so "last" means the last measured value, not
  // `values.at(-1)`: a trailing gap must not turn a chart with data into a "no values" caption.
  const last = measured.at(-1) ?? null;
  const lastLabel = last === null ? '—' : `${formatCentsToByn(last)} BYN`;
  const trend = trendOf(values);
  const trendLabel = trend !== null
    ? `, ${formatSignedPercent(trend)} за ${measuredWeeks} измеренных недель`
    : last === null
      ? ''
      : `, последняя ${lastLabel}`;
  const subject = channelName ? `CAC: ${channelName}` : 'CAC проблемного канала';
  const conclusion = hasData ? `${subject}${trendLabel}` : `${subject} — нет данных за ${windowWeeks} недель`;
  const range = weeklyRangeLabel(weeklySeries);

  return {
    id: 'alert-channel-cac',
    title: conclusion,
    caption:
      `${range === '' ? `${windowWeeks} недель` : `${range} · ${windowWeeks} недель`} · ` +
      (measuredWeeks === 0
        ? 'нет измеренных значений CAC'
        : `недельный CAC в BYN, последняя ${lastLabel}`),
    ariaLabel: measuredWeeks === 0
      ? `${conclusion}. Измеренных недель нет.`
      : `${conclusion}. Последняя измеренная неделя ${lastLabel}.`,
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
      rows: weeklySeries.length === 0
        ? [{ key: 'empty', cells: { week: '—', value: '—' } }]
        : weeklySeries.map((bucket) => ({
            key: bucket.weekStart,
            cells: { week: bucket.weekLabel, value: formatCentsToByn(bucket.cacCents) },
          })),
    },
  };
}
