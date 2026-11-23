import { METRICS_CONFIG } from '../../config/metrics.js';
import { toDateOnly } from '../../lib/dates.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { parseBigIntId } from '../../lib/ids.js';
import { centsToApi } from '../../lib/metrics-math.js';
import { resolvePeriod } from '../../lib/periods.js';
import { CAMPAIGN_LIST_LIMIT } from '../../repositories/campaigns.repo.js';
import { computeCac } from './cac.service.js';
import { buildWeeklySeries, resolveWeekRange } from './weekly-series.js';

const CHANNEL_NOT_FOUND = 'Канал не найден';

/**
 * Normalises a route id and separates the two failures a request can cause: a malformed value is a 400, while a
 * well-formed value that cannot exist (`0`, an oversized number) is a 404. Both are decided before any SQL so a
 * hand-typed URL never reaches `$1::bigint`.
 *
 * @param {unknown} value
 * @returns {string} Validated decimal id.
 * @throws {ValidationError} When the value is not a digit string.
 * @throws {NotFoundError} When the value is outside the BIGINT id range.
 */
function requireChannelId(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError('Некорректный идентификатор канала');
  }
  const id = parseBigIntId(raw);
  if (id === null) throw new NotFoundError(CHANNEL_NOT_FOUND);
  return id;
}

/**
 * @param {string | null} targetRomiPct NUMERIC text from the channel row.
 * @returns {number | null} Percentage for the chart axis, or null when the channel has no ROMI target.
 * @throws {TypeError} When the column contains a non-finite value, which would mean a broken column type.
 */
function targetRomiValue(targetRomiPct) {
  if (targetRomiPct === null || targetRomiPct === undefined) return null;
  const value = Number(targetRomiPct);
  if (!Number.isFinite(value)) {
    throw new TypeError(`target_romi_pct must be numeric, got ${JSON.stringify(targetRomiPct)}`);
  }
  return value;
}

/**
 * Channel passport (BO-01/BO-03; design §8): identity and targets, the health row, a weekly series, a funnel and the
 * campaigns of one channel.
 *
 * The health row is reused verbatim from one health report — recomputing CAC/LTV/ROMI here would be a second formula
 * that could disagree with the channel table. Campaign spend and CAC come from the period-scoped CAC inputs, not
 * from `campaigns.spendCents`, which is lifetime spend and would make the passport contradict the 30-day KPI above.
 *
 * @param {{
 *   healthService: { getChannelHealthReport: Function },
 *   metricsRepository: ReturnType<typeof import('../../repositories/metrics.repo.js').createMetricsRepository>,
 *   attributionService: { getAttributionSeries: Function },
 *   channelsRepository: ReturnType<typeof import('../../repositories/channels.repo.js').createChannelsRepository>,
 *   campaignsRepository: ReturnType<typeof import('../../repositories/campaigns.repo.js').createCampaignsRepository>,
 * }} deps
 */
export function createChannelPassportService({
  healthService,
  metricsRepository,
  attributionService,
  channelsRepository,
  campaignsRepository,
}) {
  return {
    /**
     * @param {{ anchor: string, channelId: string, from?: string | null, to?: string | null }} request
     * @returns {Promise<{
     *   channel: {
     *     id: string, code: string, name: string, kind: string,
     *     targetCacCents: string | null, targetRomiPct: number | null,
     *   },
     *   isActive: boolean,
     *   period: { from: string, to: string, days: number, anchor: string },
     *   health: object,
     *   series: Array<{
     *     weekStart: string, weekLabel: string, spendCents: string, newCustomers: number,
     *     cacCents: string | null, romiPct: number | null,
     *   }>,
     *   funnel: { impressions: number, clicks: number, leads: number, newCustomers: number, orders: number },
     *   campaigns: Array<{
     *     id: string, code: string, name: string, status: string,
     *     spendCents: string, newCustomers: number, cacCents: string | null,
     *   }>,
     *   campaignsTruncated: boolean,
     * }>} JSON-safe view-model; money as kopeck strings, percentages as numbers. At most
     *   `CAMPAIGN_LIST_LIMIT` campaigns are returned, without the repository's truncation sentinel.
     *   `campaignsTruncated` is true when the repository's sentinel row proves that more campaigns exist.
     * @throws {ValidationError} When the anchor, period or channel id is malformed.
     * @throws {NotFoundError} When the channel does not exist.
     * @throws {TypeError} When a dependency returns a row outside its contract.
     */
    async getChannelPassport({ anchor, channelId, from = null, to = null } = {}) {
      const id = requireChannelId(channelId);
      const period = resolvePeriod({ anchor, from, to });
      const anchorDate = toDateOnly(anchor);
      const { firstWeekStart } = resolveWeekRange(period.to, METRICS_CONFIG.dashboard.weeks);

      const channel = await channelsRepository.findChannelById(id);
      if (!channel) throw new NotFoundError(CHANNEL_NOT_FOUND);

      // Sequential reads for the same `pg.Client` reason as the other metrics services.
      const healthReport = await healthService.getChannelHealthReport({
        anchor,
        from: period.from,
        to: period.to,
      });
      const healthRow = healthReport.rows.find((row) => row.channelId === channel.id);
      if (!healthRow) {
        throw new TypeError(`health report is missing channel ${channel.id}`);
      }

      const weeklyRows = await metricsRepository.listWeeklySeries({
        from: firstWeekStart,
        to: period.to,
        channelIds: [channel.id],
      });
      const attributedRows = await attributionService.getAttributionSeries({
        from: firstWeekStart,
        to: period.to,
        channelId: channel.id,
      });
      const funnel = await metricsRepository.getChannelFunnel({
        from: period.from,
        to: period.to,
        channelId: channel.id,
      });
      const campaignRows = await campaignsRepository.listCampaigns({ channelId: channel.id });
      const campaignCacRows = await metricsRepository.listCampaignCacInputs({
        from: period.from,
        to: period.to,
        channelId: channel.id,
      });

      // `listCampaigns` reads `LIMIT + 1` so the list screen can tell "200 campaigns" from "more than 200". The
      // extra row is a truncation sentinel, not a campaign: render at most the real limit instead of a 201st row.
      const campaignsTruncated = campaignRows.length > CAMPAIGN_LIST_LIMIT;
      const visibleCampaigns = campaignRows.slice(0, CAMPAIGN_LIST_LIMIT);
      const cacInputByCampaign = new Map(campaignCacRows.map((row) => [row.campaignId, row]));
      const campaigns = visibleCampaigns.map((campaign) => {
        // The CAC input list comes from its own query for the same period. A campaign missing from it has no
        // statistics in the window, which is a real zero spend and an undefined CAC, not an error.
        const input = cacInputByCampaign.get(campaign.id);
        const spendCents = input?.spendCents ?? 0n;
        const newCustomers = input?.newCustomers ?? 0;
        const { cacCents } = computeCac({ spendCents, newCustomers });

        return {
          id: campaign.id,
          code: campaign.code,
          name: campaign.name,
          status: campaign.status,
          spendCents: centsToApi(spendCents),
          newCustomers,
          cacCents: centsToApi(cacCents),
        };
      });

      return {
        channel: {
          id: channel.id,
          code: channel.code,
          name: channel.name,
          kind: channel.kind,
          targetCacCents: centsToApi(channel.targetCacCents),
          targetRomiPct: targetRomiValue(channel.targetRomiPct),
        },
        // Top-level, next to the identity object: the screen needs the archive badge and the M3 channel object
        // remains the stable identity contract asserted by the existing passport test.
        isActive: channel.isActive,
        period: { from: period.from, to: period.to, days: period.days, anchor: anchorDate },
        health: healthRow,
        series: buildWeeklySeries({ firstWeekStart, weeks: METRICS_CONFIG.dashboard.weeks, weeklyRows, attributedRows }),
        funnel,
        campaigns,
        campaignsTruncated,
      };
    },
  };
}
