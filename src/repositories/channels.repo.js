import { centsFromDb } from '../lib/money.js';

/**
 * Channel columns plus campaign counters, shared by the list and the passport query.
 *
 * The counters are aggregated in SQL because the list shows both totals and active counts for every channel: a
 * per-row query would turn one screen into nine round trips. `count(...)::int` keeps the value a JS number instead
 * of a BIGINT string.
 */
const CHANNEL_SELECT = `
  SELECT c.id::text AS id,
         c.code,
         c.name,
         c.kind,
         c.is_active,
         c.target_cac_cents::text AS target_cac_cents,
         c.target_romi_pct::text AS target_romi_pct,
         c.created_at,
         count(cp.id)::int AS campaign_count,
         count(cp.id) FILTER (WHERE cp.status = 'active')::int AS active_campaign_count
    FROM channels c
    LEFT JOIN campaigns cp ON cp.channel_id = c.id
`;

/**
 * Maps a joined row. Money is parsed only through `centsFromDb`, so a BIGINT string can never be mistaken for a
 * float; the percent stays a NUMERIC string and is formatted at the edge.
 * @param {Record<string, any>} row
 * @returns {{
 *   id: string,
 *   code: string,
 *   name: string,
 *   kind: string,
 *   isActive: boolean,
 *   targetCacCents: bigint | null,
 *   targetRomiPct: string | null,
 *   createdAt: Date | null,
 *   campaignCount: number,
 *   activeCampaignCount: number,
 * }}
 */
function mapChannelRow(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    isActive: row.is_active,
    targetCacCents: centsFromDb(row.target_cac_cents),
    targetRomiPct: row.target_romi_pct === null ? null : String(row.target_romi_pct),
    createdAt: row.created_at ?? null,
    campaignCount: row.campaign_count ?? 0,
    activeCampaignCount: row.active_campaign_count ?? 0,
  };
}

/**
 * Data access for `channels`. Every statement is parameterized; ids arrive as strings because BIGINT values from
 * `pg` are strings on the way out, and the explicit `::bigint` cast keeps the round trip lossless.
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 */
export function createChannelsRepository(db) {
  return {
    /**
     * @param {{ onlyActive?: boolean | null, kind?: string | null }} [filters] NULL disables the condition.
     * @returns {Promise<ReturnType<typeof mapChannelRow>[]>} Active channels first, then by code for a stable order.
     */
    async listChannels({ onlyActive = null, kind = null } = {}) {
      const { rows } = await db.query(
        `${CHANNEL_SELECT}
          WHERE ($1::boolean IS NULL OR c.is_active = $1::boolean)
            AND ($2::text IS NULL OR c.kind = $2::text)
          GROUP BY c.id
          ORDER BY c.is_active DESC, c.code`,
        [onlyActive, kind],
      );
      return rows.map(mapChannelRow);
    },

    /**
     * @param {string} id BIGINT id as a validated digit string.
     * @returns {Promise<ReturnType<typeof mapChannelRow> | null>}
     */
    async findChannelById(id) {
      const { rows } = await db.query(
        `${CHANNEL_SELECT}
          WHERE c.id = $1::bigint
          GROUP BY c.id`,
        [id],
      );
      return rows[0] ? mapChannelRow(rows[0]) : null;
    },

    /**
     * Used for a friendly duplicate error before the INSERT; the unique violation handler still covers the race.
     * @param {string} code
     * @returns {Promise<{ id: string, name: string } | null>}
     */
    async findChannelByCode(code) {
      const { rows } = await db.query('SELECT id::text AS id, name FROM channels WHERE code = $1', [code]);
      return rows[0] ?? null;
    },

    /**
     * @param {{
     *   code: string, name: string, kind: string,
     *   targetCacCents: bigint | null, targetRomiPct: number | null,
     * }} channel
     * @returns {Promise<ReturnType<typeof mapChannelRow>>}
     */
    async createChannel({ code, name, kind, targetCacCents, targetRomiPct }) {
      const { rows } = await db.query(
        `INSERT INTO channels (code, name, kind, target_cac_cents, target_romi_pct)
         VALUES ($1, $2, $3, $4::bigint, $5::numeric)
         RETURNING id::text AS id, code, name, kind, is_active,
                   target_cac_cents::text AS target_cac_cents,
                   target_romi_pct::text AS target_romi_pct,
                   created_at`,
        [code, name, kind, targetCacCents === null ? null : targetCacCents.toString(), targetRomiPct],
      );
      return mapChannelRow(rows[0]);
    },

    /**
     * @param {string} id
     * @param {{ name: string, kind: string, targetCacCents: bigint | null, targetRomiPct: number | null }} channel
     * @returns {Promise<ReturnType<typeof mapChannelRow> | null>}
     */
    async updateChannel(id, { name, kind, targetCacCents, targetRomiPct }) {
      const { rows } = await db.query(
        `UPDATE channels
            SET name = $2, kind = $3, target_cac_cents = $4::bigint, target_romi_pct = $5::numeric
          WHERE id = $1::bigint
          RETURNING id::text AS id, code, name, kind, is_active,
                    target_cac_cents::text AS target_cac_cents,
                    target_romi_pct::text AS target_romi_pct,
                    created_at`,
        [id, name, kind, targetCacCents === null ? null : targetCacCents.toString(), targetRomiPct],
      );
      return rows[0] ? mapChannelRow(rows[0]) : null;
    },

    /**
     * Sets the archive flag. Archiving is conditional on "no active campaigns" in the same statement, because the
     * service check and this UPDATE are two round trips and a campaign could be created between them; restoring
     * has no such condition. A NULL result therefore means either "no such channel" or "guard fired" and the
     * service distinguishes the two from the state it read.
     * @param {string} id
     * @param {boolean} isActive
     * @returns {Promise<ReturnType<typeof mapChannelRow> | null>}
     */
    async setChannelActive(id, isActive) {
      const { rows } = await db.query(
        `UPDATE channels c
            SET is_active = $2
          WHERE c.id = $1::bigint
            AND ($2::boolean OR NOT EXISTS (
                  SELECT 1 FROM campaigns cp WHERE cp.channel_id = c.id AND cp.status = 'active'
                ))
          RETURNING id::text AS id, code, name, kind, is_active,
                    target_cac_cents::text AS target_cac_cents,
                    target_romi_pct::text AS target_romi_pct,
                    created_at`,
        [id, isActive],
      );
      return rows[0] ? mapChannelRow(rows[0]) : null;
    },
  };
}
