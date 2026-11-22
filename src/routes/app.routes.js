import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import { createAppController } from '../controllers/app.controller.js';
import { createAdminController } from '../controllers/admin.controller.js';
import { createChannelsController } from '../controllers/channels.controller.js';

/**
 * Sections that exist in the sidebar but render the honest «Раздел появится на следующем этапе» placeholder until
 * their milestone. Profile is guarded by `requireAuth` only: every signed-in role owns their own profile page.
 * Channels left this list when its real routes landed; keeping it here would shadow them.
 */
const PLACEHOLDER_SECTIONS = [
  { slug: 'campaigns', title: 'Кампании' },
  { slug: 'cohorts', title: 'Когорты' },
  { slug: 'attribution', title: 'Атрибуция' },
  { slug: 'scenarios', title: 'Сценарии' },
  { slug: 'alerts', title: 'Алерты' },
  { slug: 'goals', title: 'Цели' },
  { slug: 'profile', title: 'Профиль' },
];

/**
 * Authenticated application routes. Every handler sits behind `requireAuth`; anything beyond "any signed-in user"
 * is enforced by `requirePermission` on the server, because a hidden sidebar link is presentation, not access control.
 * @param {{
 *   requireAuth: import('express').RequestHandler,
 *   usersRepository: ReturnType<typeof import('../repositories/users.repo.js').createUsersRepository>,
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 *   channelsService: ReturnType<typeof import('../services/channels.service.js').createChannelsService>,
 * }} deps
 * @returns {import('express').Router}
 */
export function createAppRouter({ requireAuth, usersRepository, referenceRepository, channelsService }) {
  const appController = createAppController({ referenceRepository });
  const adminController = createAdminController({ usersRepository, referenceRepository });
  const channelsController = createChannelsController({ channelsService, referenceRepository });
  const router = Router();

  router.get('/', requireAuth, (req, res) => {
    res.redirect('/app/dashboard');
  });

  router.get('/dashboard', requireAuth, appController.dashboard);

  // Channels carry their own permissions per method: viewing is open to every role, mutations only to analysts.
  router.get('/channels', requireAuth, requirePermission('channels:view'), channelsController.list);
  router.get('/channels/:id', requireAuth, requirePermission('channels:view'), channelsController.detail);
  router.post('/channels', requireAuth, requirePermission('channels:manage'), channelsController.create);
  router.post('/channels/:id', requireAuth, requirePermission('channels:manage'), channelsController.update);
  router.post(
    '/channels/:id/archive',
    requireAuth,
    requirePermission('channels:manage'),
    channelsController.archive,
  );

  for (const { slug, title } of PLACEHOLDER_SECTIONS) {
    router.get(`/${slug}`, requireAuth, appController.comingSoon({ title, activeNav: slug }));
  }

  // Import writes history and audit exposes the whole team's actions, so both need a permission, not just a login.
  router.get('/import', requireAuth, requirePermission('import:run'), appController.comingSoon({
    title: 'Импорт',
    activeNav: 'import',
  }));
  router.get('/audit', requireAuth, requirePermission('audit:view'), appController.comingSoon({
    title: 'Аудит',
    activeNav: 'audit',
  }));

  router.get('/admin/users', requireAuth, requirePermission('users:manage'), adminController.users);

  return router;
}
