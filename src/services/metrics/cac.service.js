import { ValidationError } from '../../lib/errors.js';
import { formatCentsToByn } from '../../lib/format.js';
import { parseBigIntId } from '../../lib/ids.js';
import { centsToApi } from '../../lib/metrics-math.js';
import { resolvePeriod } from '../../lib/periods.js';

const GROUPINGS = Object.freeze(['channel', 'campaign']);

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
 * CAC report builder. Express, `req` and the pool are invisible here: the service receives a repository and a
 * validated period, and returns a view-model that M4 can serialise directly.
 *
 * @param {{
 *   metricsRepository: ReturnType<typeof import('../../repositories/metrics.repo.js').createMetricsRepository>,
 * }} deps
 */
export function createCacService({ metricsRepository }) {
  return {
    /**
     * @param {{
     *   from?: string | null,
     *   to?: string | null,
     *   groupBy?: 'channel' | 'campaign',
     *   channelId?: string | null,
     * }} [request]
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
     * @throws {ValidationError} When the period, grouping or channel filter is invalid.
     */
    async getCacReport({ from = null, to = null, groupBy = 'channel', channelId = null } = {}) {
      if (!GROUPINGS.includes(groupBy)) {
        throw new ValidationError('Неизвестная группировка CAC');
      }

      const scopedChannelId = channelId === null || channelId === undefined ? null : parseBigIntId(channelId);
      if (channelId !== null && channelId !== undefined && scopedChannelId === null) {
        throw new ValidationError('Некорректный идентификатор канала');
      }

      // The CAC service is called with an already resolved period in M4; resolving against `to` here still validates
      // the bounds and computes the real inclusive day count, so a direct API caller cannot report a 90-day label
      // over a one-day range.
      const period = resolvePeriod({ anchor: to, from, to });
      const bounds = { from: period.from, to: period.to };

      const [totals, inputs] =
        groupBy === 'channel'
          ? await Promise.all([
              metricsRepository.totals(bounds),
              metricsRepository.listChannelCacInputs(bounds),
            ])
          : await Promise.all([
              metricsRepository.totals(bounds),
              metricsRepository.listCampaignCacInputs({ ...bounds, channelId: scopedChannelId }),
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
