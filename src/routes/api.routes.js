import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { createCsvUploader } from '../middleware/upload.js';
import { createImportRateLimiter } from '../middleware/rateLimit.js';

/**
 * Versioned JSON API. Mounted after the session, CSRF and locals middleware so the guards can read the session and
 * every response goes through the shared JSON error handler.
 *
 * The import limiter is created here, inside the router factory, rather than as a module singleton: a new app gets a
 * new store, which keeps integration tests independent and makes the production window per process explicit.
 *
 * @param {{
 *   importController: ReturnType<typeof import('../controllers/import.controller.js').createImportController>,
 * }} deps
 * @returns {import('express').Router}
 */
export function createApiRouter({ importController }) {
  const router = Router();
  const importLimiter = createImportRateLimiter();

  // The limiter runs before multer: a client that burned its quota must not make the server parse a 2 MB body.
  router.post(
    '/import',
    requireAuth,
    requirePermission('import:run'),
    importLimiter,
    ...createCsvUploader(),
    importController.upload,
  );

  return router;
}
