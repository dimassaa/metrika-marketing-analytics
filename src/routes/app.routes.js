import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import { createAppController } from '../controllers/app.controller.js';
import { createAdminController } from '../controllers/admin.controller.js';
import { createChannelsController } from '../controllers/channels.controller.js';
import { createCampaignsController } from '../controllers/campaigns.controller.js';

/**
 * Sections that exist in the sidebar but render the honest «Раздел появится на следующем этапе» placeholder until
 * their milestone. Profile, audit and users left this list when their real routes landed; keeping them here would
 * shadow them.
 */
const PLACEHOLDER_SECTIONS = [
  { slug: 'cohorts', title: 'Когорты' },
  { slug: 'attribution', title: 'Атрибуция' },
  { slug: 'scenarios', title: 'Сценарии' },
  { slug: 'alerts', title: 'Алерты' },
  { slug: 'goals', title: 'Цели' },
];

/**
 * Authenticated application routes. Every handler sits behind `requireAuth`; anything beyond "any signed-in user"
 * is enforced by `requirePermission` on the server, because a hidden sidebar link is presentation, not access control.
 * @param {{
 *   requireAuth: import('express').RequestHandler,
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 *   usersService: ReturnType<typeof import('../services/users.service.js').createUsersService>,
 *   auditService: ReturnType<typeof import('../services/audit.service.js').createAuditService>,
 *   channelsService: ReturnType<typeof import('../services/channels.service.js').createChannelsService>,
 *   campaignsService: ReturnType<typeof import('../services/campaigns.service.js').createCampaignsService>,
 * }} deps
 * @returns {import('express').Router}
 */
export function createAppRouter({
  requireAuth,
  referenceRepository,
  usersService,
  auditService,
  channelsService,
  campaignsService,
}) {
  const appController = createAppController({ referenceRepository });
  const adminController = createAdminController({ usersService, auditService, referenceRepository });
  const channelsController = createChannelsController({ channelsService, campaignsService, referenceRepository });
  const campaignsController = createCampaignsController({ campaignsService, channelsService, referenceRepository });
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

  // Reading campaigns is open to viewers, mutations to analysts and admins. `/delete` is declared with its own
  // permission even though it shares the path prefix with the edit POST: hiding the button is not access control.
  router.get('/campaigns', requireAuth, requirePermission('campaigns:view'), campaignsController.list);
  router.post('/campaigns', requireAuth, requirePermission('campaigns:manage'), campaignsController.create);
  router.post('/campaigns/:id', requireAuth, requirePermission('campaigns:manage'), campaignsController.update);
  router.post(
    '/campaigns/:id/delete',
    requireAuth,
    requirePermission('campaigns:manage'),
    campaignsController.delete,
  );

  for (const { slug, title } of PLACEHOLDER_SECTIONS) {
    router.get(`/${slug}`, requireAuth, appController.comingSoon({ title, activeNav: slug }));
  }

  // Import writes history and audit exposes the whole team's actions, so both need a permission, not just a login.
  router.get('/import', requireAuth, requirePermission('import:run'), appController.comingSoon({
    title: 'Импорт',
    activeNav: 'import',
  }));

  // Every signed-in role owns their profile; user administration and the journal are admin-only on the server.
  router.get('/profile', requireAuth, adminController.profile);
  router.post('/profile/password', requireAuth, adminController.changePassword);

  router.get('/audit', requireAuth, requirePermission('audit:view'), adminController.audit);

  router.get('/admin/users', requireAuth, requirePermission('users:manage'), adminController.users);
  router.post('/admin/users', requireAuth, requirePermission('users:manage'), adminController.createUser);
  router.post(
    '/admin/users/:id/role',
    requireAuth,
    requirePermission('users:manage'),
    adminController.changeRole,
  );
  router.post(
    '/admin/users/:id/toggle-active',
    requireAuth,
    requirePermission('users:manage'),
    adminController.toggleActive,
  );
  router.post(
    '/admin/users/:id/reset-password',
    requireAuth,
    requirePermission('users:manage'),
    adminController.resetPassword,
  );

  return router;
}
