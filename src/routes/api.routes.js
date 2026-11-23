import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { createCsvUploader, createImageUploader } from '../middleware/upload.js';
import { createImportRateLimiter } from '../middleware/rateLimit.js';

/**
 * Route → permission table for the metrics API, next to the routes that use it. The RBAC test compares the table
 * with the expected permission instead of duplicating the list, so adding a route without an entry is a visible
 * failure rather than a silently unguarded endpoint.
 */
export const METRICS_API_PERMISSIONS = Object.freeze({
  '/dashboard': 'dashboard:view',
  '/channels': 'channels:view',
  '/channels/:id': 'channels:view',
  '/ranking': 'channels:view',
});

/**
 * Versioned JSON API. Mounted after the session, CSRF and locals middleware so the guards can read the session and
 * every response goes through the shared JSON error handler.
 *
 * The import limiter is created here, inside the router factory, rather than as a module singleton: a new app gets a
 * new store, which keeps integration tests independent and makes the production window per process explicit.
 *
 * @param {{
 *   importController: ReturnType<typeof import('../controllers/import.controller.js').createImportController>,
 *   mediaController: ReturnType<typeof import('../controllers/media.controller.js').createMediaController>,
 *   metrics: ReturnType<typeof import('../services/metrics/index.js').createMetricsModule>,
 * }} deps
 * @returns {import('express').Router}
 */
export function createApiRouter({ importController, mediaController, metrics }) {
  const router = Router();
  const importLimiter = createImportRateLimiter();

  // Metrics GETs depend on the data anchor, which moves when an import commits; a cached JSON body would outlive it.
  router.use(['/dashboard', '/channels', '/ranking'], (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get(
    '/dashboard',
    requireAuth,
    requirePermission(METRICS_API_PERMISSIONS['/dashboard']),
    metrics.controllers.api.dashboard,
  );
  router.get(
    '/channels',
    requireAuth,
    requirePermission(METRICS_API_PERMISSIONS['/channels']),
    metrics.controllers.api.channels,
  );
  router.get(
    '/channels/:id',
    requireAuth,
    requirePermission(METRICS_API_PERMISSIONS['/channels/:id']),
    metrics.controllers.api.channel,
  );
  router.get(
    '/ranking',
    requireAuth,
    requirePermission(METRICS_API_PERMISSIONS['/ranking']),
    metrics.controllers.api.ranking,
  );

  // The limiter runs before multer: a client that burned its quota must not make the server parse a 2 MB body.
  router.post(
    '/import',
    requireAuth,
    requirePermission('import:run'),
    importLimiter,
    ...createCsvUploader(),
    importController.upload,
  );

  // Every signed-in user owns their avatar; the field name `avatar` is fixed by the profile form.
  router.post(
    '/profile/avatar',
    requireAuth,
    ...createImageUploader({ field: 'avatar' }),
    mediaController.uploadAvatar,
  );

  // The OG cover is site-wide content, so it needs the same permission as user administration, not just a login.
  router.post(
    '/admin/media/og-cover',
    requireAuth,
    requirePermission('users:manage'),
    ...createImageUploader({ field: 'file' }),
    mediaController.uploadOgCover,
  );

  return router;
}
