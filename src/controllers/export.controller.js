import { AUDIT_ACTIONS } from '../config/audit-actions.js';
import { parseExportRequest } from '../validators/export.schema.js';
import { EXPORT_ROW_LIMIT } from '../services/export.service.js';

/**
 * CSV download endpoint. The handler only translates HTTP: the validator owns the dataset/filter contract, the
 * service owns formatting, and this module owns the response headers and the audit row.
 *
 * @param {{
 *   exportService: ReturnType<typeof import('../services/export.service.js').createExportService>,
 *   auditService: ReturnType<typeof import('../services/audit.service.js').createAuditService>,
 * }} deps
 */
export function createExportController({ exportService, auditService }) {
  return {
    /**
     * `GET /app/export/:dataset.csv`. A safe GET, so no CSRF token; `requirePermission('export')` on the route is
     * the access check for every role, including the viewer.
     * @type {import('express').RequestHandler}
     */
    async download(req, res) {
      const { dataset, filters } = parseExportRequest(req.params.dataset, req.query);

      const report = await exportService.exportDataset({
        dataset,
        filters,
        actor: { id: req.session.user.id },
      });

      await auditService.record({
        userId: req.session.user.id,
        action: AUDIT_ACTIONS.EXPORT_CSV,
        entity: dataset,
        payload: { filters, rowsCount: report.rowsCount },
        ip: req.ip ?? null,
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      if (dataset === 'orders') {
        res.setHeader('X-Row-Limit', String(EXPORT_ROW_LIMIT));
      }
      res.send(report.csvContent);
    },
  };
}
