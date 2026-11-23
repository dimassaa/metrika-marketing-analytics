import { addDays, minskDayStart } from '../lib/dates.js';
import { ValidationError } from '../lib/errors.js';
import { parseBigIntId } from '../lib/ids.js';
import { centsFromDb } from '../lib/money.js';

/*
 * Event-time bounds are half-open: `[minskDayStart(from), minskDayStart(to + 1 day))`. `minskDayEnd` stops at
 * `.999`, so an inclusive `<=` silently drops a sub-millisecond row that still belongs to `to`. Calendar
 * `stat_date` columns stay inclusive (`BETWEEN`), because they carry no time of day.
 */

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
              AND cu.first_order_at < $4::timestamptz
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
        [from, to, minskDayStart(from), minskDayStart(addDays(to, 1))],
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
     * Spend and new customers per channel for two adjacent alert windows, in one grouped statement.
     *
     * The alert rules need both windows for every channel at once. Querying per channel (or per window) would turn
     * one recalculation into 2 × channel-count round trips, so both windows are described by a `bounds` CTE and one
     * pass over `daily_stats`/`customers` produces every row.
     *
     * Every channel is returned for both windows, with zeros when it had no activity. The zero is a measured value —
     * the rule guard decides "not enough data", and a missing row would otherwise be indistinguishable from a SQL
     * bug. Spend and customers are aggregated in separate CTEs and joined afterwards: joining the two fact tables
     * directly would multiply every spend row by every customer row of the same window.
     *
     * @param {{ nowFrom: string, nowTo: string, prevFrom: string, prevTo: string }} windows Inclusive calendar dates.
     * @returns {Promise<Array<{
     *   window: 'now' | 'prev',
     *   channelId: string,
     *   spendCents: bigint,
     *   newCustomers: number,
     * }>>} Two rows per channel, ordered by channel id and window.
     */
    async listChannelWindowTotals({ nowFrom, nowTo, prevFrom, prevTo }) {
      const { rows } = await db.query(
        `WITH bounds (win, from_date, to_date, from_ts, to_ts) AS (
           VALUES ('prev', $1::date, $2::date, $5::timestamptz, $6::timestamptz),
                  ('now', $3::date, $4::date, $7::timestamptz, $8::timestamptz)
         ),
         spend AS (
           SELECT b.win,
                  cp.channel_id,
                  sum(ds.spend_cents)::bigint::text AS spend_cents
             FROM bounds b
             JOIN daily_stats ds ON ds.stat_date BETWEEN b.from_date AND b.to_date
             JOIN campaigns cp ON cp.id = ds.campaign_id
            GROUP BY b.win, cp.channel_id
         ),
         customer_counts AS (
           SELECT b.win,
                  cu.first_channel_id AS channel_id,
                  count(*)::int AS new_customers
             FROM bounds b
             JOIN customers cu
               ON cu.first_order_at >= b.from_ts
              AND cu.first_order_at < b.to_ts
            WHERE cu.first_channel_id IS NOT NULL
            GROUP BY b.win, cu.first_channel_id
         )
         SELECT b.win,
                c.id::text AS channel_id,
                coalesce(s.spend_cents, '0') AS spend_cents,
                coalesce(n.new_customers, 0) AS new_customers
           FROM bounds b
           CROSS JOIN channels c
           LEFT JOIN spend s ON s.win = b.win AND s.channel_id = c.id
           LEFT JOIN customer_counts n ON n.win = b.win AND n.channel_id = c.id
          ORDER BY c.id, b.win`,
        [
          prevFrom,
          prevTo,
          nowFrom,
          nowTo,
          minskDayStart(prevFrom),
          minskDayStart(addDays(prevTo, 1)),
          minskDayStart(nowFrom),
          minskDayStart(addDays(nowTo, 1)),
        ],
      );

      return rows.map((row) => ({
        window: row.win,
        channelId: row.channel_id,
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
              AND cu.first_order_at < $6::timestamptz
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
        [from, to, scopedChannelId, scopedCampaignId, minskDayStart(from), minskDayStart(addDays(to, 1))],
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
                    AND cu.first_order_at < $4::timestamptz) AS new_customers`,
        [from, to, minskDayStart(from), minskDayStart(addDays(to, 1))],
      );

      const row = rows[0] ?? {};
      return {
        spendCents: spendFromRow(row.spend_cents),
        newCustomers: countFromRow(row.new_customers, 'new_customers'),
      };
    },

    /**
     * Weekly spend and new customers for the dashboard and the channel card.
     *
     * Only Monday–Sunday weeks that fit inside `[from, to]` are returned: a week whose Sunday is past `to` is still
     * accumulating, and a partial bucket would make a chart show a false drop at the right edge.
     *
     * The two sources are aggregated in separate CTEs and joined afterwards. Joining `daily_stats` with `customers`
     * directly would multiply every spend row by every customer row of the same week. The `FULL JOIN` keeps a week
     * that spent money without acquiring anyone (and vice versa) instead of silently dropping it.
     *
     * New customers are bucketed by the Europe/Minsk calendar date of `first_order_at`. Grouping by the UTC date
     * would move an order placed at 00:30 Minsk into the previous day and, around midnight on Monday, into the
     * previous week; `AT TIME ZONE` matches the day bounds used by every other metrics query.
     *
     * @param {{ from: string, to: string, channelIds?: string[] | null }} filters `null` means every channel.
     * @returns {Promise<Array<{ weekStart: string, spendCents: bigint, newCustomers: number }>>} Sorted by week.
     * @throws {ValidationError} When a channel id is not a BIGINT id.
     */
    async listWeeklySeries({ from, to, channelIds = null }) {
      let scopedChannelIds = null;
      if (channelIds !== null && channelIds !== undefined) {
        if (!Array.isArray(channelIds)) {
          throw new ValidationError('Некорректный список каналов');
        }
        scopedChannelIds = channelIds.map((channelId) => {
          const id = parseBigIntId(channelId);
          if (id === null) throw new ValidationError('Некорректный идентификатор канала');
          return id;
        });
      }

      const { rows } = await db.query(
        `WITH spend AS (
           SELECT date_trunc('week', ds.stat_date)::date AS week_start,
                  coalesce(sum(ds.spend_cents), 0)::bigint::text AS spend_cents
             FROM daily_stats ds
             JOIN campaigns cp ON cp.id = ds.campaign_id
            WHERE ds.stat_date BETWEEN $1::date AND $2::date
              AND ($3::bigint[] IS NULL OR cp.channel_id = ANY($3::bigint[]))
            GROUP BY 1
         ),
         new_customers AS (
           SELECT date_trunc('week', (cu.first_order_at AT TIME ZONE 'Europe/Minsk')::date)::date AS week_start,
                  count(*)::int AS new_customers
             FROM customers cu
            WHERE cu.first_order_at >= $4::timestamptz
              AND cu.first_order_at < $5::timestamptz
              AND ($3::bigint[] IS NULL OR cu.first_channel_id = ANY($3::bigint[]))
            GROUP BY 1
         )
         SELECT (coalesce(s.week_start, n.week_start))::text AS week_start,
                coalesce(s.spend_cents, '0') AS spend_cents,
                coalesce(n.new_customers, 0) AS new_customers
           FROM spend s
           FULL JOIN new_customers n ON n.week_start = s.week_start
          WHERE coalesce(s.week_start, n.week_start) >= $1::date
            AND coalesce(s.week_start, n.week_start) + 6 <= $2::date
          ORDER BY 1`,
        [from, to, scopedChannelIds, minskDayStart(from), minskDayStart(addDays(to, 1))],
      );

      return rows.map((row) => ({
        weekStart: row.week_start,
        spendCents: spendFromRow(row.spend_cents),
        newCustomers: countFromRow(row.new_customers, 'new_customers'),
      }));
    },

    /**
     * Single funnel query for the channel card: impressions, clicks and leads come from the channel's campaigns,
     * customers and orders are counted by the customer's acquisition channel inside the same period.
     *
     * All five numbers are aggregated in one statement and every CTE returns exactly one row (`count(*)` does even
     * on an empty table), so a channel without any statistics answers zeros, never `null` and never `NaN`. There is
     * no per-campaign query: the funnel is a screen-level aggregate, not a table row.
     *
     * @param {{ from: string, to: string, channelId: string }} request
     * @returns {Promise<{ impressions: number, clicks: number, leads: number, newCustomers: number, orders: number }>}
     * @throws {ValidationError} When the channel id is not a BIGINT id.
     */
    async getChannelFunnel({ from, to, channelId }) {
      const scopedChannelId = parseBigIntId(channelId);
      if (scopedChannelId === null) {
        throw new ValidationError('Некорректный идентификатор канала');
      }

      const { rows } = await db.query(
        `WITH stats AS (
           SELECT coalesce(sum(ds.impressions), 0)::int AS impressions,
                  coalesce(sum(ds.clicks), 0)::int AS clicks,
                  coalesce(sum(ds.leads), 0)::int AS leads
             FROM daily_stats ds
             JOIN campaigns cp ON cp.id = ds.campaign_id
            WHERE cp.channel_id = $1::bigint
              AND ds.stat_date BETWEEN $2::date AND $3::date
         ),
         acquired AS (
           SELECT count(*)::int AS new_customers
             FROM customers cu
            WHERE cu.first_channel_id = $1::bigint
              AND cu.first_order_at >= $4::timestamptz
              AND cu.first_order_at < $5::timestamptz
         ),
         channel_orders AS (
           SELECT count(*)::int AS orders
             FROM orders o
             JOIN customers cu ON cu.id = o.customer_id
            WHERE cu.first_channel_id = $1::bigint
              AND o.occurred_at >= $4::timestamptz
              AND o.occurred_at < $5::timestamptz
         )
         SELECT s.impressions, s.clicks, s.leads, a.new_customers, o.orders
           FROM stats s
           CROSS JOIN acquired a
           CROSS JOIN channel_orders o`,
        [scopedChannelId, from, to, minskDayStart(from), minskDayStart(addDays(to, 1))],
      );

      const row = rows[0] ?? {};
      return {
        impressions: countFromRow(row.impressions, 'impressions'),
        clicks: countFromRow(row.clicks, 'clicks'),
        leads: countFromRow(row.leads, 'leads'),
        newCustomers: countFromRow(row.new_customers, 'new_customers'),
        orders: countFromRow(row.orders, 'orders'),
      };
    },

    /**
     * Weekly spend and new customers for every channel, in one grouped statement.
     *
     * The channel list needs a 12-week CAC sparkline per row. Asking per channel would turn one screen into eight
     * round trips, so both sources are grouped by `(channel, week)` here and the service computes CAC in memory.
     * Only complete Monday–Sunday weeks inside `[from, to]` are returned, exactly like `listWeeklySeries`; a week
     * without a row is filled with a null point by the service, not by SQL.
     *
     * @param {{ from: string, to: string }} period Inclusive Minsk calendar dates.
     * @returns {Promise<Array<{
     *   channelId: string, weekStart: string, spendCents: bigint, newCustomers: number,
     * }>>} Sorted by channel and week.
     */
    async listChannelWeeklyCacInputs({ from, to }) {
      const { rows } = await db.query(
        `WITH spend AS (
           SELECT cp.channel_id,
                  date_trunc('week', ds.stat_date)::date AS week_start,
                  coalesce(sum(ds.spend_cents), 0)::bigint::text AS spend_cents
             FROM daily_stats ds
             JOIN campaigns cp ON cp.id = ds.campaign_id
            WHERE ds.stat_date BETWEEN $1::date AND $2::date
            GROUP BY cp.channel_id, 2
         ),
         customer_counts AS (
           SELECT cu.first_channel_id AS channel_id,
                  date_trunc('week', (cu.first_order_at AT TIME ZONE 'Europe/Minsk')::date)::date AS week_start,
                  count(*)::int AS new_customers
             FROM customers cu
            WHERE cu.first_order_at >= $3::timestamptz
              AND cu.first_order_at < $4::timestamptz
              AND cu.first_channel_id IS NOT NULL
            GROUP BY 1, 2
         )
         SELECT (coalesce(s.channel_id, n.channel_id))::text AS channel_id,
                (coalesce(s.week_start, n.week_start))::text AS week_start,
                coalesce(s.spend_cents, '0') AS spend_cents,
                coalesce(n.new_customers, 0) AS new_customers
           FROM spend s
           FULL JOIN customer_counts n
             ON n.channel_id = s.channel_id
            AND n.week_start = s.week_start
          WHERE coalesce(s.week_start, n.week_start) >= $1::date
            AND coalesce(s.week_start, n.week_start) + 6 <= $2::date
          ORDER BY 1, 2`,
        [from, to, minskDayStart(from), minskDayStart(addDays(to, 1))],
      );

      return rows.map((row) => ({
        channelId: row.channel_id,
        weekStart: row.week_start,
        spendCents: spendFromRow(row.spend_cents),
        newCustomers: countFromRow(row.new_customers, 'new_customers'),
      }));
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
