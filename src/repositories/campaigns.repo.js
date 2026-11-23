import { centsFromDb } from '../lib/money.js';
import { cachedRead } from '../lib/request-cache.js';

/**
 * Campaign columns plus the channel label and spend aggregates, shared by the list, the passport section and the
 * single-row lookup.
 *
 * One LEFT JOIN over `daily_stats` grouped by campaign yields every number the list shows. A per-row "how much did
 * this campaign spend" query would turn one screen into 33 round trips (32 seeded campaigns plus the page itself).
 * `coalesce(..., 0)` keeps a campaign without statistics visible with zero spend, while `count(...)::int` returns a
 * JS number instead of a BIGINT string.
 */
const CAMPAIGN_SELECT = `
  SELECT cp.id::text AS id,
         cp.channel_id::text AS channel_id,
         cp.code,
         cp.name,
         cp.status,
         cp.started_on::text AS started_on,
         cp.ended_on::text AS ended_on,
         cp.budget_cents::text AS budget_cents,
         ch.name AS channel_name,
         ch.code AS channel_code,
         ch.is_active AS channel_is_active,
         coalesce(sum(ds.spend_cents), 0)::text AS spend_cents,
         count(ds.id)::int AS stats_count
    FROM campaigns cp
    JOIN channels ch ON ch.id = cp.channel_id
    LEFT JOIN daily_stats ds ON ds.campaign_id = cp.id
`;

/** Active campaigns first, then paused and finished, with a stable alphabetical order inside each group. */
const CAMPAIGN_ORDER = `
  ORDER BY CASE cp.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
           cp.name,
           cp.id
`;

/** Safety cap for the list. The seed has 32 campaigns; a screen is not a data export. */
export const CAMPAIGN_LIST_LIMIT = 200;

/**
 * Maps a joined row. Money goes through `centsFromDb` so a BIGINT/NUMERIC string can never be mistaken for a float.
 * @param {Record<string, any>} row
 * @returns {{
 *   id: string,
 *   channelId: string,
 *   code: string,
 *   name: string,
 *   status: 'active' | 'paused' | 'finished',
 *   startedOn: string,
 *   endedOn: string | null,
 *   budgetCents: bigint | null,
 *   channelName: string | null,
 *   channelCode: string | null,
 *   channelIsActive: boolean | null,
 *   spendCents: bigint | null,
 *   statsCount: number,
 * }}
 */
function mapCampaignRow(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    code: row.code,
    name: row.name,
    status: row.status,
    startedOn: row.started_on,
    endedOn: row.ended_on ?? null,
    budgetCents: centsFromDb(row.budget_cents),
    channelName: row.channel_name ?? null,
    channelCode: row.channel_code ?? null,
    channelIsActive: row.channel_is_active ?? null,
    spendCents: centsFromDb(row.spend_cents),
    statsCount: row.stats_count ?? 0,
  };
}

/**
 * Data access for `campaigns`. Every statement is parameterized; ids arrive as strings because `pg` returns BIGINT as
 * a string, and the explicit casts keep the round trip lossless.
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 */
export function createCampaignsRepository(db) {
  return {
    /**
     * @param {{ channelId?: string | null, status?: string | null, search?: string | null }} [filters]
     *   NULL disables the condition. `search` matches the name or code as a literal substring (no LIKE wildcards),
     *   so a user typing `%` does not turn the filter into a match-everything pattern.
     * @returns {Promise<ReturnType<typeof mapCampaignRow>[]>}
     */
    async listCampaigns({ channelId = null, status = null, search = null } = {}) {
      const { rows } = await db.query(
        `${CAMPAIGN_SELECT}
          WHERE ($1::bigint IS NULL OR cp.channel_id = $1::bigint)
            AND ($2::text IS NULL OR cp.status = $2::text)
            AND ($3::text IS NULL
                 OR position(lower($3::text) in lower(cp.name)) > 0
                 OR position(lower($3::text) in lower(cp.code)) > 0)
          GROUP BY cp.id, ch.id
          ${CAMPAIGN_ORDER}
          LIMIT ${CAMPAIGN_LIST_LIMIT + 1}`,
        [channelId, status, search],
      );
      return rows.map(mapCampaignRow);
    },

    /**
     * @param {string} channelId BIGINT id as a validated digit string.
     * @returns {Promise<ReturnType<typeof mapCampaignRow>[]>} Campaigns of one channel, same order as the list.
     */
    async listCampaignsByChannel(channelId) {
      // The passport renders the campaign list twice from one render: once in the island and once in the edit card.
      const rows = await cachedRead(`campaigns.listCampaignsByChannel:${channelId}`, async () => {
        const result = await db.query(
          `${CAMPAIGN_SELECT}
            WHERE cp.channel_id = $1::bigint
            GROUP BY cp.id, ch.id
            ${CAMPAIGN_ORDER}
            LIMIT ${CAMPAIGN_LIST_LIMIT}`,
          [channelId],
        );
        return result.rows;
      });
      return rows.map(mapCampaignRow);
    },

    /**
     * @param {string} id BIGINT id as a validated digit string.
     * @returns {Promise<ReturnType<typeof mapCampaignRow> | null>}
     */
    async findCampaignById(id) {
      const { rows } = await db.query(
        `${CAMPAIGN_SELECT}
          WHERE cp.id = $1::bigint
          GROUP BY cp.id, ch.id`,
        [id],
      );
      return rows[0] ? mapCampaignRow(rows[0]) : null;
    },

    /**
     * Used for a friendly duplicate error before the INSERT; the unique violation handler still covers the race.
     * @param {string} code
     * @returns {Promise<{ id: string, channelId: string, code: string, name: string } | null>}
     */
    async findCampaignByCode(code) {
      const { rows } = await db.query(
        'SELECT id::text AS id, channel_id::text AS channel_id, code, name FROM campaigns WHERE code = $1',
        [code],
      );
      if (!rows[0]) return null;
      return { id: rows[0].id, channelId: rows[0].channel_id, code: rows[0].code, name: rows[0].name };
    },

    /**
     * @param {{
     *   channelId: string, code: string, name: string, status: string,
     *   startedOn: string, endedOn: string | null, budgetCents: bigint | null,
     * }} campaign
     * @returns {Promise<string>} Id of the new row.
     */
    async createCampaign({ channelId, code, name, status, startedOn, endedOn, budgetCents }) {
      const { rows } = await db.query(
        `INSERT INTO campaigns (channel_id, code, name, status, started_on, ended_on, budget_cents)
         VALUES ($1::bigint, $2, $3, $4, $5::date, $6::date, $7::bigint)
         RETURNING id::text AS id`,
        [channelId, code, name, status, startedOn, endedOn, budgetCents === null ? null : budgetCents.toString()],
      );
      return rows[0].id;
    },

    /**
     * @param {string} id
     * @param {{ name: string, status: string, startedOn: string, endedOn: string | null, budgetCents: bigint | null }} fields
     * @returns {Promise<boolean>} False when the campaign disappeared between the service read and this UPDATE.
     */
    async updateCampaign(id, { name, status, startedOn, endedOn, budgetCents }) {
      const { rows } = await db.query(
        `UPDATE campaigns
            SET name = $2,
                status = $3,
                started_on = $4::date,
                ended_on = $5::date,
                budget_cents = $6::bigint
          WHERE id = $1::bigint
          RETURNING id::text AS id`,
        [id, name, status, startedOn, endedOn, budgetCents === null ? null : budgetCents.toString()],
      );
      return rows.length > 0;
    },

    /**
     * One row of scalar subqueries instead of four round trips. Counts are `::int`, so the service compares numbers.
     * @param {string} id
     * @returns {Promise<{ statsCount: number, ordersCount: number, touchpointsCount: number, customersCount: number }>}
     */
    async getCampaignUsageCounts(id) {
      const { rows } = await db.query(
        `SELECT (SELECT count(*) FROM daily_stats WHERE campaign_id = $1::bigint)::int AS stats_count,
                (SELECT count(*) FROM orders WHERE campaign_id = $1::bigint)::int AS orders_count,
                (SELECT count(*) FROM touchpoints WHERE campaign_id = $1::bigint)::int AS touchpoints_count,
                (SELECT count(*) FROM customers WHERE first_campaign_id = $1::bigint)::int AS customers_count`,
        [id],
      );
      const row = rows[0] ?? {};
      return {
        statsCount: row.stats_count ?? 0,
        ordersCount: row.orders_count ?? 0,
        touchpointsCount: row.touchpoints_count ?? 0,
        customersCount: row.customers_count ?? 0,
      };
    },

    /**
     * Deletes only a campaign nothing references. The guards sit in the same statement as the DELETE, so a row that
     * gained statistics or orders after the service read cannot slip through and cascade its history away.
     * @param {string} id
     * @returns {Promise<boolean>} False when the id is gone or the guard refused.
     */
    async deleteCampaignById(id) {
      const { rows } = await db.query(
        `DELETE FROM campaigns c
          WHERE c.id = $1::bigint
            AND NOT EXISTS (SELECT 1 FROM daily_stats ds WHERE ds.campaign_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.campaign_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM touchpoints t WHERE t.campaign_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM customers cu WHERE cu.first_campaign_id = c.id)
          RETURNING c.id::text AS id`,
        [id],
      );
      return rows.length > 0;
    },
  };
}
