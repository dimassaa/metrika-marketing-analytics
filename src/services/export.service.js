import { addDays } from '../lib/dates.js';
import { ValidationError } from '../lib/errors.js';
import { stringifyCsv } from '../lib/csv.js';

/**
 * Hard cap for the order export. The seed holds ~9 500 orders, but a real stand can grow without bound; a single
 * synchronous response must not try to serialise a million rows into memory. The controller exposes the cap as
 * `X-Row-Limit`, so the caller can narrow the period instead of silently losing rows.
 */
export const EXPORT_ROW_LIMIT = 50_000;

/** Default reporting window fixed by metrics spec §0.1: 30 calendar days counted back from the data anchor. */
const DEFAULT_PERIOD_DAYS = 29;

const HEADERS = Object.freeze({
  channels: ['code', 'name', 'kind', 'is_active', 'target_cac_byn', 'target_romi_pct', 'campaigns_count'],
  campaigns: ['code', 'name', 'channel_code', 'status', 'started_on', 'ended_on', 'budget_byn', 'spend_byn'],
  daily_stats: ['stat_date', 'channel_code', 'campaign_code', 'impressions', 'clicks', 'leads', 'spend_byn'],
  orders: [
    'external_id',
    'customer_external_id',
    'first_channel_code',
    'campaign_code',
    'occurred_at',
    'revenue_byn',
    'margin_byn',
  ],
});

/**
 * Renders kopecks as the CSV decimal used by Excel in the Belarusian locale: `1234,56`.
 *
 * Thousands separators are deliberately absent — Excel parses `1 234,56` as text, while `1234,56` is a number.
 * A NULL cell stays empty (honest "no value"), never `0,00`.
 * @param {bigint | null} cents
 * @returns {string}
 */
export function formatCentsForCsv(cents) {
  if (cents === null) return '';
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${absolute / 100n},${fraction}`;
}

/**
 * @param {string | null} value NUMERIC(10,2) as returned by `pg`, e.g. `120.00`.
 * @returns {string} Decimal with a comma, or an empty cell.
 */
function formatNumericForCsv(value) {
  if (value === null) return '';
  return String(value).replace('.', ',');
}

/**
 * Applies the documented 30-day default from the data anchor. An explicit upper bound is kept, so
 * `?to=2026-10-31` means that month rather than "until today"; `?from=` alone runs through the anchor.
 * @param {{ from: string | null, to: string | null }} filters
 * @param {string} anchor
 * @returns {{ from: string, to: string }}
 * @throws {ValidationError} When the resolved range is reversed.
 */
function resolvePeriod({ from, to }, anchor) {
  const resolvedTo = to ?? anchor;
  const resolvedFrom = from ?? addDays(resolvedTo, -DEFAULT_PERIOD_DAYS);
  if (resolvedFrom > resolvedTo) {
    throw new ValidationError('Начало периода не может быть позже окончания');
  }
  return { from: resolvedFrom, to: resolvedTo };
}

/**
 * @param {unknown} value
 * @returns {string | null} NULL for the `all` pseudo-value used by the screen filters.
 */
function nullableFilter(value) {
  return typeof value === 'string' && value !== 'all' && value !== '' ? value : null;
}

/**
 * Builds a filtered CSV report and returns it with its download name. Formatting, defaults and the row cap live
 * here; HTTP headers and the audit row are the controller's job.
 *
 * @param {{
 *   exportRepository: ReturnType<typeof import('../repositories/export.repo.js').createExportRepository>,
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 * }} deps
 */
export function createExportService({ exportRepository, referenceRepository }) {
  /**
   * @param {{
   *   dataset: 'channels' | 'campaigns' | 'daily_stats' | 'orders',
   *   filters: Record<string, string | null>,
   *   actor: { id: string, ip?: string | null },
   * }} request `actor` is accepted for symmetry with the other services; only the controller writes the audit row.
   * @returns {Promise<{ filename: string, csvContent: string, rowsCount: number }>}
   */
  async function exportDataset({ dataset, filters }) {
    const anchor = await referenceRepository.getDataAnchor();
    let rows;

    if (dataset === 'channels') {
      const channels = await exportRepository.listChannels({
        status: nullableFilter(filters.status),
        kind: nullableFilter(filters.kind),
      });
      rows = channels.map((channel) => [
        channel.code,
        channel.name,
        channel.kind,
        channel.isActive ? 'true' : 'false',
        formatCentsForCsv(channel.targetCacCents),
        formatNumericForCsv(channel.targetRomiPct),
        channel.campaignsCount,
      ]);
    } else if (dataset === 'campaigns') {
      const campaigns = await exportRepository.listCampaigns({
        channelId: nullableFilter(filters.channelId),
        status: nullableFilter(filters.status),
        search: nullableFilter(filters.q),
      });
      rows = campaigns.map((campaign) => [
        campaign.code,
        campaign.name,
        campaign.channelCode,
        campaign.status,
        campaign.startedOn,
        campaign.endedOn ?? '',
        formatCentsForCsv(campaign.budgetCents),
        formatCentsForCsv(campaign.spendCents),
      ]);
    } else if (dataset === 'daily_stats') {
      const period = resolvePeriod(filters, anchor);
      const stats = await exportRepository.listDailyStats({
        channelId: nullableFilter(filters.channelId),
        campaignId: nullableFilter(filters.campaignId),
        ...period,
      });
      rows = stats.map((stat) => [
        stat.statDate,
        stat.channelCode,
        stat.campaignCode,
        stat.impressions,
        stat.clicks,
        stat.leads,
        formatCentsForCsv(stat.spendCents),
      ]);
    } else if (dataset === 'orders') {
      const period = resolvePeriod(filters, anchor);
      const orders = await exportRepository.listOrders({
        channelId: nullableFilter(filters.channelId),
        ...period,
        // One extra row distinguishes "exactly at the cap" from "truncated" without a second COUNT query.
        limit: EXPORT_ROW_LIMIT + 1,
      });
      const visible = orders.length > EXPORT_ROW_LIMIT ? orders.slice(0, EXPORT_ROW_LIMIT) : orders;
      rows = visible.map((order) => [
        order.externalId,
        order.customerExternalId,
        order.firstChannelCode,
        order.campaignCode ?? '',
        order.occurredOn,
        formatCentsForCsv(order.revenueCents),
        formatCentsForCsv(order.marginCents),
      ]);
    } else {
      // The validator rejects an unknown dataset before this point; fail loudly instead of returning an empty file.
      throw new ValidationError('Неизвестный набор данных для экспорта');
    }

    return {
      // The anchor, not the wall clock, keeps a downloaded file reproducible on a stand opened later.
      filename: `metrika-${dataset}-${anchor}.csv`,
      csvContent: stringifyCsv(HEADERS[dataset], rows, { withBom: true }),
      rowsCount: rows.length,
    };
  }

  return { exportDataset };
}
