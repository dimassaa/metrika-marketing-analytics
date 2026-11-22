import { normalizeIp } from '../lib/clientIp.js';

/**
 * Columns shared by the audit list and its count. The actor's e-mail comes from a LEFT JOIN because `user_id` is
 * `ON DELETE SET NULL`: a row whose actor disappeared must stay visible instead of dropping out of the journal.
 */
const AUDIT_FROM = `
  FROM audit_log a
  LEFT JOIN users u ON u.id = a.user_id
`;

const AUDIT_FILTERS = `
  WHERE ($1::text IS NULL OR a.entity = $1::text)
    AND ($2::bigint IS NULL OR a.user_id = $2::bigint)
    AND ($3::text IS NULL OR a.action = $3::text)
`;

/**
 * @param {{ entity?: string | null, userId?: string | null, action?: string | null }} filters
 * @returns {[string | null, string | null, string | null]} Positional values for `AUDIT_FILTERS`.
 */
function filterParams({ entity = null, userId = null, action = null } = {}) {
  return [entity, userId, action];
}

/**
 * Maps one journal row. `payload` is passed through untouched: the service decides which whitelisted keys may be
 * shown, and the template never prints raw JSON.
 * @param {Record<string, any>} row
 * @returns {{
 *   id: string,
 *   userId: string | null,
 *   userEmail: string | null,
 *   action: string,
 *   entity: string,
 *   entityId: string | null,
 *   payload: Record<string, unknown>,
 *   createdAt: Date,
 * }}
 */
function mapAuditRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    userEmail: row.user_email,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    payload: row.payload ?? {},
    createdAt: row.created_at,
  };
}

/**
 * Read side of `audit_log`. The table is append-only, so this repository exposes only list/count; inserts stay in
 * `insert`, which the audit service owns.
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 */
export function createAuditRepository(db) {
  return {
    /**
     * @param {object} entry
     * @param {string | null} entry.userId Actor; null for anonymous events.
     * @param {string} entry.action Dot-separated action such as `auth.login`.
     * @param {string} entry.entity Affected entity type.
     * @param {string | null} entry.entityId Affected entity id.
     * @param {Record<string, unknown>} entry.payload Structured context; must never contain secrets.
     * @param {string | null} entry.ip Caller address for INET; malformed values become NULL.
     * @returns {Promise<void>}
     */
    async insert({ userId, action, entity, entityId, payload, ip }) {
      // This is the one write choke point: every audit caller goes through here, so a spoofed or malformed address
      // can never reach the INET column and fail an already-committed mutation with SQLSTATE 22P02.
      await db.query(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, payload, ip)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, action, entity, entityId, payload, normalizeIp(ip)],
      );
    },

    /**
     * Newest first. Ordering by `created_at DESC, id DESC` keeps pages stable when several rows share a timestamp.
     * @param {{
     *   filters?: { entity?: string | null, userId?: string | null, action?: string | null },
     *   limit: number,
     *   offset: number,
     * }} query
     * @returns {Promise<ReturnType<typeof mapAuditRow>[]>}
     */
    async list({ filters = {}, limit, offset }) {
      const { rows } = await db.query(
        `SELECT a.id::text AS id,
                a.user_id::text AS user_id,
                u.email AS user_email,
                a.action,
                a.entity,
                a.entity_id,
                a.payload,
                a.created_at
           ${AUDIT_FROM}
           ${AUDIT_FILTERS}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT $4::int OFFSET $5::int`,
        [...filterParams(filters), limit, offset],
      );
      return rows.map(mapAuditRow);
    },

    /**
     * @param {{ entity?: string | null, userId?: string | null, action?: string | null }} [filters]
     * @returns {Promise<number>}
     */
    async count(filters = {}) {
      const { rows } = await db.query(`SELECT count(*)::int AS total ${AUDIT_FROM} ${AUDIT_FILTERS}`, filterParams(filters));
      return rows[0].total;
    },
  };
}
