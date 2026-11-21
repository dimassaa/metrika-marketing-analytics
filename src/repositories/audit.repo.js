/**
 * Data access for `audit_log`. Only inserts happen here: the table is append-only by design.
 * @param {{ query: (text: string, params?: unknown[]) => Promise<unknown> }} db
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
     * @param {string | null} entry.ip Caller address for INET.
     * @returns {Promise<void>}
     */
    async insert({ userId, action, entity, entityId, payload, ip }) {
      await db.query(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, payload, ip)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, action, entity, entityId, payload, ip],
      );
    },
  };
}
