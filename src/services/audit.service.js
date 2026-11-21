/**
 * Writes significant actions to `audit_log`. The service exists so controllers describe an event instead of composing
 * SQL columns, and so the "no secrets in payload" rule has one place to live.
 * @param {{ auditRepository: ReturnType<typeof import('../repositories/audit.repo.js').createAuditRepository> }} deps
 */
export function createAuditService({ auditRepository }) {
  return {
    /**
     * @param {object} entry
     * @param {string | null} [entry.userId]
     * @param {string} entry.action
     * @param {string} entry.entity
     * @param {string | null} [entry.entityId]
     * @param {Record<string, unknown>} [entry.payload] Never put passwords, tokens or session ids here.
     * @param {string | null} [entry.ip]
     * @returns {Promise<void>}
     */
    async record({ userId = null, action, entity, entityId = null, payload = {}, ip = null }) {
      await auditRepository.insert({ userId, action, entity, entityId, payload, ip });
    },
  };
}
