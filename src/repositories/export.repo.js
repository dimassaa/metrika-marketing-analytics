import { centsFromDb } from '../lib/money.js';

/**
 * Read-only queries behind the CSV export. Each dataset repeats the filter conditions of its screen, so a downloaded
 * file always matches what the person saw. Every statement is parameterized; money stays a BIGINT string until
 * `centsFromDb` turns it into exact kopecks.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 */
export function createExportRepository(db) {
  return {
    /**
     * Channel rows with the campaign counter shown on the list. `status` is the screen vocabulary
     * (`active`/`archived`), not the stored boolean.
     * @param {{ status?: string | null, kind?: string | null }} [filters] NULL disables the condition.
     * @returns {Promise<Array<{
     *   code: string, name: string, kind: string, isActive: boolean,
     *   targetCacCents: bigint | null, targetRomiPct: string | null, campaignsCount: number,
     * }>>}
     */
    async listChannels({ status = null, kind = null } = {}) {
      const onlyActive = status === 'active' ? true : status === 'archived' ? false : null;
      const { rows } = await db.query(
        `SELECT c.code,
                c.name,
                c.kind,
                c.is_active,
                c.target_cac_cents::text AS target_cac_cents,
                c.target_romi_pct::text AS target_romi_pct,
                count(cp.id)::int AS campaigns_count
           FROM channels c
           LEFT JOIN campaigns cp ON cp.channel_id = c.id
          WHERE ($1::boolean IS NULL OR c.is_active = $1::boolean)
            AND ($2::text IS NULL OR c.kind = $2::text)
          GROUP BY c.id
          ORDER BY c.is_active DESC, c.code`,
        [onlyActive, kind],
      );
      return rows.map((row) => ({
        code: row.code,
        name: row.name,
        kind: row.kind,
        isActive: row.is_active,
        targetCacCents: centsFromDb(row.target_cac_cents),
        targetRomiPct: row.target_romi_pct === null ? null : String(row.target_romi_pct),
        campaignsCount: row.campaigns_count ?? 0,
      }));
    },

    /**
     * Campaign rows with the channel code and the spend aggregated from `daily_stats`, exactly like the list screen.
     * @param {{ channelId?: string | null, status?: string | null, search?: string | null }} [filters]
     * @returns {Promise<Array<{
     *   code: string, name: string, channelCode: string, status: string,
     *   startedOn: string, endedOn: string | null, budgetCents: bigint | null, spendCents: bigint | null,
     * }>>}
     */
    async listCampaigns({ channelId = null, status = null, search = null } = {}) {
      const { rows } = await db.query(
        `SELECT cp.code,
                cp.name,
                ch.code AS channel_code,
                cp.status,
                cp.started_on::text AS started_on,
                cp.ended_on::text AS ended_on,
                cp.budget_cents::text AS budget_cents,
                coalesce(sum(ds.spend_cents), 0)::text AS spend_cents
           FROM campaigns cp
           JOIN channels ch ON ch.id = cp.channel_id
           LEFT JOIN daily_stats ds ON ds.campaign_id = cp.id
          WHERE ($1::bigint IS NULL OR cp.channel_id = $1::bigint)
            AND ($2::text IS NULL OR cp.status = $2::text)
            AND ($3::text IS NULL
                 OR position(lower($3::text) in lower(cp.name)) > 0
                 OR position(lower($3::text) in lower(cp.code)) > 0)
          GROUP BY cp.id, ch.id
          ORDER BY CASE cp.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
                   cp.name,
                   cp.id`,
        [channelId, status, search],
      );
      return rows.map((row) => ({
        code: row.code,
        name: row.name,
        channelCode: row.channel_code,
        status: row.status,
        startedOn: row.started_on,
        endedOn: row.ended_on ?? null,
        budgetCents: centsFromDb(row.budget_cents),
        spendCents: centsFromDb(row.spend_cents),
      }));
    },

    /**
     * One row per campaign-day inside the inclusive calendar range.
     * @param {{ channelId?: string | null, campaignId?: string | null, from: string, to: string }} filters
     * @returns {Promise<Array<{
     *   statDate: string, channelCode: string, campaignCode: string,
     *   impressions: number, clicks: number, leads: number, spendCents: bigint | null,
     * }>>}
     */
    async listDailyStats({ channelId = null, campaignId = null, from, to }) {
      const { rows } = await db.query(
        `SELECT ds.stat_date::text AS stat_date,
                ch.code AS channel_code,
                cp.code AS campaign_code,
                ds.impressions,
                ds.clicks,
                ds.leads,
                ds.spend_cents::text AS spend_cents
           FROM daily_stats ds
           JOIN campaigns cp ON cp.id = ds.campaign_id
           JOIN channels ch ON ch.id = cp.channel_id
          WHERE ($1::bigint IS NULL OR ch.id = $1::bigint)
            AND ($2::bigint IS NULL OR cp.id = $2::bigint)
            AND ds.stat_date >= $3::date
            AND ds.stat_date <= $4::date
          ORDER BY ds.stat_date, ch.code, cp.code`,
        [channelId, campaignId, from, to],
      );
      return rows.map((row) => ({
        statDate: row.stat_date,
        channelCode: row.channel_code,
        campaignCode: row.campaign_code,
        impressions: row.impressions,
        clicks: row.clicks,
        leads: row.leads,
        spendCents: centsFromDb(row.spend_cents),
      }));
    },

    /**
     * Orders inside the inclusive Minsk-date range, attributed to the customer's first-touch channel (metrics spec
     * §0). `limit` receives one extra row from the service so truncation is visible without a second COUNT query.
     * @param {{ channelId?: string | null, from: string, to: string, limit: number }} filters
     * @returns {Promise<Array<{
     *   externalId: string, customerExternalId: string, firstChannelCode: string,
     *   campaignCode: string | null, occurredOn: string,
     *   revenueCents: bigint | null, marginCents: bigint | null,
     * }>>}
     */
    async listOrders({ channelId = null, from, to, limit }) {
      const { rows } = await db.query(
        `SELECT o.external_id,
                cu.external_id AS customer_external_id,
                ch.code AS first_channel_code,
                cp.code AS campaign_code,
                to_char(o.occurred_at AT TIME ZONE 'Europe/Minsk', 'YYYY-MM-DD') AS occurred_on,
                o.revenue_cents::text AS revenue_cents,
                o.margin_cents::text AS margin_cents
           FROM orders o
           JOIN customers cu ON cu.id = o.customer_id
           JOIN channels ch ON ch.id = cu.first_channel_id
           LEFT JOIN campaigns cp ON cp.id = o.campaign_id
          WHERE ($1::bigint IS NULL OR cu.first_channel_id = $1::bigint)
            AND (o.occurred_at AT TIME ZONE 'Europe/Minsk')::date >= $2::date
            AND (o.occurred_at AT TIME ZONE 'Europe/Minsk')::date <= $3::date
          ORDER BY o.occurred_at, o.id
          LIMIT $4::int`,
        [channelId, from, to, limit],
      );
      return rows.map((row) => ({
        externalId: row.external_id,
        customerExternalId: row.customer_external_id,
        firstChannelCode: row.first_channel_code,
        campaignCode: row.campaign_code ?? null,
        occurredOn: row.occurred_on,
        revenueCents: centsFromDb(row.revenue_cents),
        marginCents: centsFromDb(row.margin_cents),
      }));
    },
  };
}
