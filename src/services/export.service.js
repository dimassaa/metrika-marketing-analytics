import { addDays, minskDayStart } from '../lib/dates.js';
import { ValidationError } from '../lib/errors.js';
import { stringifyCsv } from '../lib/csv.js';
import { resolvePeriod } from '../lib/periods.js';

/**
 * Hard cap shared by every export dataset. A single synchronous response must not try to serialise an unbounded
 * table into memory; the controller advertises the cap only when it actually truncated the file.
 */
export const EXPORT_ROW_LIMIT = 50_000;

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
 * Builds a filtered CSV report and returns it with its download name and truncation state. Formatting, defaults
 * and the row cap live here; HTTP headers and the audit row are the controller's job.
 *
 * Every dataset is fetched with `LIMIT limit + 1`. The probe row is dropped and only its presence sets
 * `truncated`, which makes the cap honest without a second COUNT query.
 *
 * @param {{
 *   exportRepository: ReturnType<typeof import('../repositories/export.repo.js').createExportRepository>,
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 *   rowLimit?: number,
 * }} deps `rowLimit` is injectable so a unit test can exercise the cap without seeding 50 000 rows.
 */
export function createExportService({ exportRepository, referenceRepository, rowLimit = EXPORT_ROW_LIMIT }) {
  /**
   * @template T
   * @param {(limit: number) => Promise<T[]>} fetchRows
   * @returns {Promise<{ rows: T[], truncated: boolean }>}
   */
  async function fetchWithCap(fetchRows) {
    const fetched = await fetchRows(rowLimit + 1);
    const truncated = fetched.length > rowLimit;
    return { rows: truncated ? fetched.slice(0, rowLimit) : fetched, truncated };
  }

  /**
   * @param {{
   *   dataset: 'channels' | 'campaigns' | 'daily_stats' | 'orders',
   *   filters: Record<string, string | null>,
   * }} request
   * @returns {Promise<{
   *   filename: string,
   *   csvContent: string,
   *   rowsCount: number,
   *   truncated: boolean,
   *   limit: number,
   * }>}
   */
  async function exportDataset({ dataset, filters }) {
    const anchor = await referenceRepository.getDataAnchor();
    /** @type {Array<Array<string | number>>} */
    let csvRows;
    /** @type {boolean} */
    let truncated;

    if (dataset === 'channels') {
      const capped = await fetchWithCap((limit) =>
        exportRepository.listChannels({ status: filters.status, kind: filters.kind, limit }),
      );
      truncated = capped.truncated;
      csvRows = capped.rows.map((channel) => [
        channel.code,
        channel.name,
        channel.kind,
        channel.isActive ? 'true' : 'false',
        formatCentsForCsv(channel.targetCacCents),
        formatNumericForCsv(channel.targetRomiPct),
        channel.campaignsCount,
      ]);
    } else if (dataset === 'campaigns') {
      const capped = await fetchWithCap((limit) =>
        exportRepository.listCampaigns({
          channelId: filters.channelId,
          status: filters.status,
          search: filters.q,
          limit,
        }),
      );
      truncated = capped.truncated;
      csvRows = capped.rows.map((campaign) => [
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
      const period = resolvePeriod({ anchor, from: filters.from, to: filters.to });
      const capped = await fetchWithCap((limit) =>
        exportRepository.listDailyStats({
          channelId: filters.channelId,
          campaignId: filters.campaignId,
          ...period,
          limit,
        }),
      );
      truncated = capped.truncated;
      csvRows = capped.rows.map((stat) => [
        stat.statDate,
        stat.channelCode,
        stat.campaignCode,
        stat.impressions,
        stat.clicks,
        stat.leads,
        formatCentsForCsv(stat.spendCents),
      ]);
    } else if (dataset === 'orders') {
      const period = resolvePeriod({ anchor, from: filters.from, to: filters.to });
      // Half-open instants keep the predicate sargable and match Minsk calendar days exactly, DST included.
      const fromInstant = minskDayStart(period.from);
      const toExclusive = minskDayStart(addDays(period.to, 1));
      const capped = await fetchWithCap((limit) =>
        exportRepository.listOrders({
          channelId: filters.channelId,
          fromInstant,
          toExclusive,
          limit,
        }),
      );
      truncated = capped.truncated;
      csvRows = capped.rows.map((order) => [
        order.externalId,
        order.customerExternalId,
        order.firstChannelCode,
        order.campaignCode ?? '',
        order.occurredAt,
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
      csvContent: stringifyCsv(HEADERS[dataset], csvRows, { withBom: true }),
      rowsCount: csvRows.length,
      truncated,
      limit: rowLimit,
    };
  }

  return { exportDataset };
}
