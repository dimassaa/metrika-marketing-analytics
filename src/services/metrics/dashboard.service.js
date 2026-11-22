import { METRICS_CONFIG } from '../../config/metrics.js';
import { toDateOnly } from '../../lib/dates.js';
import { formatCentsToByn, formatInteger } from '../../lib/format.js';
import { HEALTH_STATUS_LABELS } from '../../lib/metrics-labels.js';
import { resolvePeriod } from '../../lib/periods.js';
import { buildWeeklySeries, resolveWeekRange } from './weekly-series.js';

/**
 * Short Russian verdict for each health status. These are explanations of the existing statuses, not a second
 * scoring model: the status itself is decided once by `deriveHealth`, and the dashboard only repeats why it fired.
 */
const VERDICT_REASONS = Object.freeze({
  healthy: 'Расходы окупаются: выручка покрывает затраты, LTV выше CAC.',
  watch: 'Окупаемость на границе: LTV:CAC ниже здорового уровня, стоит следить.',
  risk: 'Расходы не окупаются: выручка ниже расхода или LTV ниже CAC.',
  no_data: 'Недостаточно данных за период, чтобы оценить окупаемость.',
});

/**
 * @param {string} status Health status of the blended row.
 * @param {string} label Label supplied by the health service.
 * @returns {{ status: string, label: string, reason: string }}
 * @throws {TypeError} When the health service returns a status outside the four-value contract.
 */
function buildVerdict(status, label) {
  const reason = VERDICT_REASONS[status];
  if (reason === undefined) {
    throw new TypeError(`unknown health status in the dashboard verdict: ${String(status)}`);
  }
  return { status, label: label ?? HEALTH_STATUS_LABELS[status], reason };
}

/**
 * Dashboard aggregation (BO-13; design §8): four KPI, a verdict and a weekly CAC/ROMI series.
 *
 * KPI and verdict are copied from the `blended` row of one health report, so the dashboard can never show a CAC
 * different from the channel table: both come from the same `computeCac` result over the same period. The weekly
 * series is a separate, longer window (the last complete ISO weeks) because a 30-day KPI period covers only four
 * weeks, which is too short for a trend chart.
 *
 * Expenses come from `daily_stats`, revenue from the attribution service — never from `orders.revenue_cents` — so a
 * weekly ROMI matches the ROMI the attribution screen reports for the same week.
 *
 * @param {{
 *   healthService: { getChannelHealthReport: Function },
 *   metricsRepository: ReturnType<typeof import('../../repositories/metrics.repo.js').createMetricsRepository>,
 *   attributionService: { getAttributionSeries: Function },
 * }} deps
 */
export function createDashboardService({ healthService, metricsRepository, attributionService }) {
  return {
    /**
     * @param {{
     *   anchor: string,
     *   from?: string | null,
     *   to?: string | null,
     *   weeks?: number,
     *   channelIds?: string[] | null,
     * }} request `anchor` is the data anchor; the default period and the series end both derive from it.
     *   `channelIds` is the BO-13 filter: `null` means every channel.
     * @returns {Promise<{
     *   period: { from: string, to: string, days: number, anchor: string },
     *   kpis: {
     *     spendCents: string, spendLabel: string,
     *     newCustomers: number, newCustomersLabel: string,
     *     cacCents: string | null, cacLabel: string,
     *     romiPct: number | null, romiLabel: string,
     *   },
     *   weeklySeries: Array<{
     *     weekStart: string, weekLabel: string, spendCents: string, newCustomers: number,
     *     cacCents: string | null, romiPct: number | null,
     *     attributedCents: string, attributedLabel: string,
     *   }>,
     *   channels: object[],
     *   availableChannels: Array<{ channelId: string, code: string, name: string }>,
     *   verdict: { status: 'healthy' | 'watch' | 'risk' | 'no_data', label: string, reason: string },
     * }>} Money as decimal kopeck strings, percentages as numbers — JSON-safe for `data-props`.
     * @throws {ValidationError} When the anchor, period, week count or channel filter is invalid.
     * @throws {TypeError} When a dependency returns a row outside its contract.
     */
    async getDashboardSummary({
      anchor,
      from = null,
      to = null,
      weeks = METRICS_CONFIG.dashboard.weeks,
      channelIds = null,
    } = {}) {
      const period = resolvePeriod({ anchor, from, to });
      const anchorDate = toDateOnly(anchor);
      // Resolve before the first query so an invalid week count fails without loading the whole report.
      const { firstWeekStart } = resolveWeekRange(period.to, weeks);

      // Sequential on purpose: callers may hand every service one checked-out `pg.Client`, and `pg` deprecates
      // overlapping queries on a single client.
      const health = await healthService.getChannelHealthReport({
        anchor,
        from: period.from,
        to: period.to,
        channelIds,
      });
      // The filter reaches every source, not just the KPI: a series that still summed all channels would contradict
      // the numbers above it.
      const weeklyRows = await metricsRepository.listWeeklySeries({
        from: firstWeekStart,
        to: period.to,
        channelIds,
      });
      const attributedRows = await attributionService.getAttributionSeries({
        from: firstWeekStart,
        to: period.to,
        channelIds,
      });

      const blended = health.blended;

      return {
        period: { from: period.from, to: period.to, days: period.days, anchor: anchorDate },
        kpis: {
          spendCents: blended.spendCents,
          spendLabel: formatCentsToByn(blended.spendCents),
          newCustomers: blended.newCustomers,
          newCustomersLabel: formatInteger(blended.newCustomers),
          cacCents: blended.cacCents,
          cacLabel: blended.cacLabel,
          romiPct: blended.romiPct,
          romiLabel: blended.romiLabel,
        },
        weeklySeries: buildWeeklySeries({ firstWeekStart, weeks, weeklyRows, attributedRows }),
        // Both lists are already-loaded health data: the selected rows feed the per-channel views, while the full
        // dimension keeps the multi-select usable after a filter hides some options.
        channels: health.rows,
        availableChannels: health.availableChannels ?? [],
        verdict: buildVerdict(blended.status, blended.statusLabel),
      };
    },
  };
}
