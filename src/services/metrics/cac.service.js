import { ValidationError } from '../../lib/errors.js';
import { formatCentsToByn } from '../../lib/format.js';
import { parseBigIntId } from '../../lib/ids.js';
import { centsToApi } from '../../lib/metrics-math.js';
import { resolvePeriod } from '../../lib/periods.js';

const GROUPINGS = Object.freeze(['channel', 'campaign']);

/**
 * Validates an optional BIGINT filter. `null`/`undefined` means "no filter"; anything else must be a real id.
 * @param {unknown} value
 * @param {string} label Russian noun used in the error (`канала`, `кампании`).
 * @returns {string | null}
 * @throws {ValidationError} When a supplied value is not a BIGINT id.
 */
function parseOptionalId(value, label) {
  if (value === null || value === undefined) return null;
  const id = parseBigIntId(value);
  if (id === null) throw new ValidationError(`Некорректный идентификатор ${label}`);
  return id;
}

/**
 * CAC for one channel, campaign or the whole company (metrics spec §1).
 *
 * The division happens in `bigint`: `Math.round(Number(spend) / customers)` would lose kopecks above 2^53 and
 * produce a float where the view-model promises integer kopecks. `(2 * spend + customers) / (2 * customers)` is
 * exact half-up rounding for positive values, which is the rounding rule for money.
 *
 * @param {{ spendCents: bigint, newCustomers: number }} input
 * @returns {{ cacCents: bigint | null, status: 'ok' | 'free' | 'no_data' }}
 * @throws {TypeError} When spend is not a non-negative bigint or the customer count is not a non-negative integer.
 */
export function computeCac({ spendCents, newCustomers }) {
  if (typeof spendCents !== 'bigint' || spendCents < 0n) {
    throw new TypeError(`computeCac spendCents must be a non-negative bigint, got ${String(spendCents)}`);
  }
  if (!Number.isInteger(newCustomers) || newCustomers < 0) {
    throw new TypeError(`computeCac newCustomers must be a non-negative integer, got ${String(newCustomers)}`);
  }

  if (newCustomers === 0) return { cacCents: null, status: 'no_data' };
  if (spendCents === 0n) return { cacCents: 0n, status: 'free' };

  const customers = BigInt(newCustomers);
  const cacCents = (spendCents * 2n + customers) / (2n * customers);
  return { cacCents, status: 'ok' };
}

/**
 * Maps one repository input row to the JSON-safe CAC row. Money leaves the service as decimal kopeck strings;
 * `cacLabel` is the formatted BYN amount, so the template does not have to re-parse money.
 *
 * @param {object} input Repository row.
 * @param {'channel' | 'campaign'} groupBy
 * @returns {object}
 */
function toRow(input, groupBy) {
  const { cacCents, status } = computeCac(input);
  const id = groupBy === 'channel' ? input.channelId : input.campaignId;

  return {
    key: `${groupBy}:${id}`,
    channelId: input.channelId,
    ...(groupBy === 'campaign' ? { campaignId: input.campaignId } : {}),
    label: groupBy === 'channel' ? input.channelName : input.campaignName,
    spendCents: centsToApi(input.spendCents),
    newCustomers: input.newCustomers,
    cacCents: centsToApi(cacCents),
    cacLabel: formatCentsToByn(cacCents),
    status,
  };
}

/**
 * CAC report builder. Express, `req` and the pool are invisible here: the service receives a repository and an
 * anchor-relative period request, resolves the window through the shared resolver, and returns a view-model that M4
 * can serialise directly.
 *
 * @param {{
 *   metricsRepository: ReturnType<typeof import('../../repositories/metrics.repo.js').createMetricsRepository>,
 * }} deps
 */
export function createCacService({ metricsRepository }) {
  return {
    /**
     * @param {{
     *   anchor?: string | null,
     *   from?: string | null,
     *   to?: string | null,
     *   days?: number,
     *   channelId?: string | null,
     *   campaignId?: string | null,
     *   groupBy?: 'channel' | 'campaign',
     * }} [request] `anchor` is the data anchor used for the default window and for clamping a future `to`.
     * @returns {Promise<{
     *   period: { from: string, to: string, days: number },
     *   blended: {
     *     spendCents: string,
     *     newCustomers: number,
     *     cacCents: string | null,
     *     cacLabel: string,
     *     status: 'ok' | 'free' | 'no_data',
     *   },
     *   rows: object[],
     * }>}
     * @throws {ValidationError} When the anchor/period, grouping or an active filter is invalid.
     */
    async getCacReport({
      anchor = null,
      from = null,
      to = null,
      days,
      channelId = null,
      campaignId = null,
      groupBy = 'channel',
    } = {}) {
      if (!GROUPINGS.includes(groupBy)) {
        throw new ValidationError('Неизвестная группировка CAC');
      }

      // Filters are validated only when they reach SQL. Grouping by channel returns every channel, so a stray
      // channelId or campaignId there is ignored instead of failing a request that would not use it.
      const scopedChannelId = groupBy === 'campaign' ? parseOptionalId(channelId, 'канала') : null;
      const scopedCampaignId = groupBy === 'campaign' ? parseOptionalId(campaignId, 'кампании') : null;

      // The anchor is supplied by M4 from `getDataAnchor()`. It is required even with explicit bounds because the
      // resolver owns the "data ends at the anchor" rule and a future `to` must be clamped, not trusted.
      const period = resolvePeriod({ anchor, from, to, days });
      const bounds = { from: period.from, to: period.to };

      const [totals, inputs] =
        groupBy === 'channel'
          ? await Promise.all([
              metricsRepository.totals(bounds),
              metricsRepository.listChannelCacInputs(bounds),
            ])
          : await Promise.all([
              metricsRepository.totals(bounds),
              metricsRepository.listCampaignCacInputs({
                ...bounds,
                channelId: scopedChannelId,
                campaignId: scopedCampaignId,
              }),
            ]);

      const blendedCac = computeCac(totals);

      return {
        period,
        blended: {
          spendCents: centsToApi(totals.spendCents),
          newCustomers: totals.newCustomers,
          cacCents: centsToApi(blendedCac.cacCents),
          cacLabel: formatCentsToByn(blendedCac.cacCents),
          status: blendedCac.status,
        },
        rows: inputs.map((input) => toRow(input, groupBy)),
      };
    },
  };
}
