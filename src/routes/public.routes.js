import { Router } from 'express';
import { homePage, robotsTxt, sitemapXml } from '../controllers/public.controller.js';

/**
 * Public, session-free pages and media. `createPublicRouter` is a factory because `/media/*` needs the controller,
 * which owns the database-backed assets; keeping the router a singleton would force a module-level pool import.
 *
 * @param {{
 *   mediaController: ReturnType<typeof import('../controllers/media.controller.js').createMediaController>,
 * }} deps
 * @returns {import('express').Router}
 */
export function createPublicRouter({ mediaController }) {
  const router = Router();

  router.get('/', homePage);
  router.get('/robots.txt', robotsTxt);
  router.get('/sitemap.xml', sitemapXml);

  // Declared before `/:id` for readability; the slug route has two segments, so Express would not confuse them.
  router.get('/media/slug/:slug', mediaController.bySlug);
  router.get('/media/:id', mediaController.byId);

  return router;
}
