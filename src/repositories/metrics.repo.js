import { minskDayEnd, minskDayStart } from '../lib/dates.js';
import { ValidationError } from '../lib/errors.js';
import { parseBigIntId } from '../lib/ids.js';
import { centsFromDb } from '../lib/money.js';

/**
 * Read-only CAC inputs: spend per channel/campaign from `daily_stats` and new customers from `customers`.
 *
 * Spend and customers are aggregated in separate CTEs and only then joined to the dimension. Joining both tables in
 * one query would multiply every spend row by every customer row and inflate both totals.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 */
export function createMetricsRepository(db) {
  /**
   * @param {string} value Spend as the string `pg` returns for BIGINT.
   * @returns {bigint}
   */
  function spendFromRow(value) {
    const cents = centsFromDb(value);
    if (cents === null) {
      throw new TypeError('aggregated spend_cents must not be NULL: the query applies coalesce');
    }
    return cents;
  }

  /**
   * @param {unknown} value `count(*)::int` result.
   * @param {string} name
   * @returns {number}
   */
  function countFromRow(value, name) {
    const count = Number(value ?? 0);
    if (!Number.isInteger(count) || count < 0) {
      throw new TypeError(`${name} must be a non-negative integer, got ${String(value)}`);
    }
    return count;
  }

  return {
    /**
     * Every channel, including a channel whose campaigns have no statistics in the period. Such a channel contributes
     * `spendCents: 0n`, not `undefined`, because "no spend" is a fact and CAC must be able to mark it free.
     *
     * @param {{ from: string, to: string }} period Inclusive Minsk calendar dates.
     * @returns {Promise<Array<{
     *   channelId: string, channelCode: string, channelName: string,
     *   spendCents: bigint, newCustomers: number,
     * }>>}
     */
    async listChannelCacInputs({ from, to }) {
      const { rows } = await db.query(
        `WITH spend AS (
           SELECT c.id AS channel_id,
                  coalesce(sum(ds.spend_cents), 0)::bigint::text AS spend_cents
             FROM channels c
             LEFT JOIN campaigns cp ON cp.channel_id = c.id
             LEFT JOIN daily_stats ds
               ON ds.campaign_id = cp.id
              AND ds.stat_date BETWEEN $1::date AND $2::date
            GROUP BY c.id
         ),
         customer_counts AS (
           SELECT cu.first_channel_id AS channel_id,
                  count(*)::int AS new_customers
             FROM customers cu
            WHERE cu.first_order_at >= $3::timestamptz
              AND cu.first_order_at <= $4::timestamptz
            GROUP BY cu.first_channel_id
         )
         SELECT c.id::text AS channel_id,
                c.code AS channel_code,
                c.name AS channel_name,
                s.spend_cents,
                coalesce(n.new_customers, 0) AS new_customers
           FROM channels c
           LEFT JOIN spend s ON s.channel_id = c.id
           LEFT JOIN customer_counts n ON n.channel_id = c.id
          ORDER BY c.code`,
        [from, to, minskDayStart(from), minskDayEnd(to)],
      );

      return rows.map((row) => ({
        channelId: row.channel_id,
        channelCode: row.channel_code,
        channelName: row.channel_name,
        spendCents: spendFromRow(row.spend_cents),
        newCustomers: countFromRow(row.new_customers, 'new_customers'),
      }));
    },

    /**
     * Campaign inputs, optionally limited to one channel and/or one campaign. New customers are grouped by
     * `first_campaign_id`, so a campaign never borrows customers attributed to a different campaign or channel.
     *
     * @param {{ from: string, to: string, channelId?: string | null, campaignId?: string | null }} filters
     * @returns {Promise<Array<{
     *   campaignId: string, channelId: string, campaignCode: string, campaignName: string,
     *   spendCents: bigint, newCustomers: number,
     * }>>}
     * @throws {ValidationError} When `channelId` or `campaignId` is not a BIGINT id.
     */
    async listCampaignCacInputs({ from, to, channelId = null, campaignId = null }) {
      const scopedChannelId = channelId === null || channelId === undefined ? null : parseBigIntId(channelId);
      if (channelId !== null && channelId !== undefined && scopedChannelId === null) {
        throw new ValidationError('Некорректный идентификатор канала');
      }
      const scopedCampaignId = campaignId === null || campaignId === undefined ? null : parseBigIntId(campaignId);
      if (campaignId !== null && campaignId !== undefined && scopedCampaignId === null) {
        throw new ValidationError('Некорректный идентификатор кампании');
      }

      const { rows } = await db.query(
        `WITH spend AS (
           SELECT cp.id AS campaign_id,
                  coalesce(sum(ds.spend_cents), 0)::bigint::text AS spend_cents
             FROM campaigns cp
             LEFT JOIN daily_stats ds
               ON ds.campaign_id = cp.id
              AND ds.stat_date BETWEEN $1::date AND $2::date
            WHERE ($3::bigint IS NULL OR cp.channel_id = $3::bigint)
              AND ($4::bigint IS NULL OR cp.id = $4::bigint)
            GROUP BY cp.id
         ),
         customer_counts AS (
           SELECT cu.first_campaign_id AS campaign_id,
                  count(*)::int AS new_customers
             FROM customers cu
            WHERE cu.first_order_at >= $5::timestamptz
              AND cu.first_order_at <= $6::timestamptz
              AND cu.first_campaign_id IS NOT NULL
            GROUP BY cu.first_campaign_id
         )
         SELECT cp.id::text AS campaign_id,
                cp.channel_id::text AS channel_id,
                cp.code AS campaign_code,
                cp.name AS campaign_name,
                s.spend_cents,
                coalesce(n.new_customers, 0) AS new_customers
           FROM campaigns cp
           LEFT JOIN spend s ON s.campaign_id = cp.id
           LEFT JOIN customer_counts n ON n.campaign_id = cp.id
          WHERE ($3::bigint IS NULL OR cp.channel_id = $3::bigint)
            AND ($4::bigint IS NULL OR cp.id = $4::bigint)
          ORDER BY cp.code`,
        [from, to, scopedChannelId, scopedCampaignId, minskDayStart(from), minskDayEnd(to)],
      );

      return rows.map((row) => ({
        campaignId: row.campaign_id,
        channelId: row.channel_id,
        campaignCode: row.campaign_code,
        campaignName: row.campaign_name,
        spendCents: spendFromRow(row.spend_cents),
        newCustomers: countFromRow(row.new_customers, 'new_customers'),
      }));
    },

    /**
     * Company-wide CAC inputs. Totals are independent aggregates, not a sum over per-channel rows: summing rounded
     * per-channel CACs would not produce the blended CAC the spec defines.
     *
     * @param {{ from: string, to: string }} period
     * @returns {Promise<{ spendCents: bigint, newCustomers: number }>}
     */
    async totals({ from, to }) {
      const { rows } = await db.query(
        `SELECT (SELECT coalesce(sum(ds.spend_cents), 0)::bigint::text
                   FROM daily_stats ds
                  WHERE ds.stat_date BETWEEN $1::date AND $2::date) AS spend_cents,
                (SELECT count(*)::int
                   FROM customers cu
                  WHERE cu.first_order_at >= $3::timestamptz
                    AND cu.first_order_at <= $4::timestamptz) AS new_customers`,
        [from, to, minskDayStart(from), minskDayEnd(to)],
      );

      const row = rows[0] ?? {};
      return {
        spendCents: spendFromRow(row.spend_cents),
        newCustomers: countFromRow(row.new_customers, 'new_customers'),
      };
    },

    /**
     * Spend alone per channel, for ROMI and budget screens that do not need the customer count.
     *
     * @param {{ from: string, to: string }} period
     * @returns {Promise<Array<{
     *   channelId: string, channelCode: string, channelName: string, spendCents: bigint,
     * }>>}
     */
    async listChannelSpend({ from, to }) {
      const { rows } = await db.query(
        `SELECT c.id::text AS channel_id,
                c.code AS channel_code,
                c.name AS channel_name,
                coalesce(sum(ds.spend_cents), 0)::bigint::text AS spend_cents
           FROM channels c
           LEFT JOIN campaigns cp ON cp.channel_id = c.id
           LEFT JOIN daily_stats ds
             ON ds.campaign_id = cp.id
            AND ds.stat_date BETWEEN $1::date AND $2::date
          GROUP BY c.id
          ORDER BY c.code`,
        [from, to],
      );

      return rows.map((row) => ({
        channelId: row.channel_id,
        channelCode: row.channel_code,
        channelName: row.channel_name,
        spendCents: spendFromRow(row.spend_cents),
      }));
    },
  };
}
