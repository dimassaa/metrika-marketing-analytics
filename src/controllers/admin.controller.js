import { buildShellLocals, roleLabel } from './app.controller.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { buildSeo } from '../lib/seo.js';
import {
  auditFiltersSchema,
  ownPasswordSchema,
  parseUserId,
  userCreateSchema,
  userFormValues,
  userRoleSchema,
} from '../validators/users.schema.js';
import { generateTemporaryPassword } from '../services/users.service.js';

const NOT_FOUND_SEO = buildSeo({
  title: 'Пользователь не найден — Метрика',
  description: 'Пользователь не найден: возможно, ссылка устарела. Вернитесь к списку команды.',
  path: '/app/admin/users',
  noindex: true,
});

/** Session marker for the one-time password shown after a reset. It is consumed by the next GET and deleted. */
const PASSWORD_RESET_FLASH = 'password-reset';

/**
 * Reads and removes the reset flash, so a reload never shows the same temporary password twice.
 * @param {import('express').Request} req
 * @returns {{ email: string, temporaryPassword: string } | null}
 */
function takePasswordResetFlash(req) {
  const flash = req.session?.flash;
  if (!flash || flash.type !== PASSWORD_RESET_FLASH) return null;
  delete req.session.flash;
  return { email: flash.targetEmail, temporaryPassword: flash.temporaryPassword };
}

/** Empty create form, so the template always reads string values instead of undefined. */
const EMPTY_CREATE_FORM = Object.freeze({ email: '', fullName: '', role: 'viewer', password: '' });

/**
 * @param {import('express').Request} req
 * @returns {{ id: string, ip: string }} Actor for the audit trail; never carries secrets.
 */
function actorOf(req) {
  return { id: req.session.user.id, ip: req.ip };
}

/**
 * Administration, audit and profile screens. Handlers translate HTTP only: parse with Zod, call one service method,
 * render or redirect. The rules (self-lock, last admin, session revocation) live in `users.service.js`.
 * @param {{
 *   usersService: ReturnType<typeof import('../services/users.service.js').createUsersService>,
 *   auditService: ReturnType<typeof import('../services/audit.service.js').createAuditService>,
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 *   mediaRepository: ReturnType<typeof import('../repositories/media.repo.js').createMediaRepository>,
 * }} deps
 */
export function createAdminController({ usersService, auditService, referenceRepository, mediaRepository }) {
  /**
   * @param {import('express').Response} res
   */
  function renderNotFound(res) {
    res.status(404).render('errors/404', {
      layout: 'layouts/public',
      seo: NOT_FOUND_SEO,
      year: new Date().getFullYear(),
    });
  }

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {{
   *   status?: number,
   *   error?: string | null,
   *   values?: object,
   *   resetNotice?: { email: string, temporaryPassword: string } | null,
   * }} [options]
   */
  async function renderUsers(req, res, { status = 200, error = null, values, resetNotice = null } = {}) {
    const dataAnchor = await referenceRepository.getDataAnchor();
    const users = (await usersService.listUsersForView()).map((user) => ({
      ...user,
      roleLabel: roleLabel(user.role),
    }));
    // The cover always lives at the stable slug URL; only the existence check needs the database, not the bytes.
    const ogCover = await mediaRepository.findMediaBySlug('og-cover', { includeBytes: false });

    res.status(status).render('pages/admin-users', {
      ...buildShellLocals(req, { title: 'Пользователи', activeNav: 'users', dataAnchor }),
      users,
      createError: error,
      createValues: values ?? EMPTY_CREATE_FORM,
      resetNotice,
      ogCoverUrl: ogCover ? '/media/slug/og-cover' : null,
    });
  }

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {{ status?: number, error?: string | null }} [options]
   */
  async function renderProfile(req, res, { status = 200, error = null } = {}) {
    const dataAnchor = await referenceRepository.getDataAnchor();
    const profile = await usersService.getOwnProfile(req.session.user);
    // Metadata only: the page shows a 32 px preview, so loading the BYTEA here would move the whole file per render.
    const avatar = await mediaRepository.findMediaBySlug(`avatar-user-${req.session.user.id}`, {
      includeBytes: false,
    });
    res.status(status).render('pages/profile', {
      ...buildShellLocals(req, { title: 'Профиль', activeNav: 'profile', dataAnchor }),
      profile: { ...profile, roleLabel: roleLabel(profile.role) },
      passwordError: error,
      avatarUrl: avatar ? `/media/${avatar.id}` : null,
    });
  }

  return {
    /**
     * @type {import('express').RequestHandler}
     */
    async users(req, res) {
      await renderUsers(req, res, { resetNotice: takePasswordResetFlash(req) });
    },

    /**
     * @type {import('express').RequestHandler}
     */
    async createUser(req, res) {
      const parsed = userCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        await renderUsers(req, res, {
          status: 400,
          error: parsed.error.issues[0]?.message,
          values: userFormValues(req.body),
        });
        return;
      }

      try {
        await usersService.createUser(parsed.data, actorOf(req));
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        await renderUsers(req, res, {
          status: 400,
          error: error.message,
          values: userFormValues(req.body),
        });
        return;
      }
      res.redirect('/app/admin/users');
    },

    /**
     * @type {import('express').RequestHandler}
     */
    async changeRole(req, res) {
      const id = parseUserId(req.params.id);
      if (id === null) {
        renderNotFound(res);
        return;
      }

      const parsed = userRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        await renderUsers(req, res, { status: 400, error: parsed.error.issues[0]?.message });
        return;
      }

      try {
        await usersService.changeUserRole(id, parsed.data.role, actorOf(req));
      } catch (error) {
        if (error instanceof NotFoundError) {
          renderNotFound(res);
          return;
        }
        if (error instanceof ValidationError) {
          await renderUsers(req, res, { status: 400, error: error.message });
          return;
        }
        throw error;
      }
      res.redirect('/app/admin/users');
    },

    /**
     * Flips the active flag. The state is derived from the row, not from a hidden field, so a stale page or a
     * repeated POST cannot activate twice or deactivate someone who was just restored in another tab.
     * @type {import('express').RequestHandler}
     */
    async toggleActive(req, res) {
      const id = parseUserId(req.params.id);
      if (id === null) {
        renderNotFound(res);
        return;
      }

      try {
        const target = await usersService.getUserForView(id);
        await usersService.toggleUserActive(id, !target.isActive, actorOf(req));
      } catch (error) {
        if (error instanceof NotFoundError) {
          renderNotFound(res);
          return;
        }
        if (error instanceof ValidationError) {
          await renderUsers(req, res, { status: 400, error: error.message });
          return;
        }
        throw error;
      }
      res.redirect('/app/admin/users');
    },

    /**
     * Generates a one-time password, stores it in the session for exactly one redirect and hands it to the list
     * page. A 200 response here would re-run the POST on refresh; the flash keeps GET semantics and never reaches
     * the audit log.
     * @type {import('express').RequestHandler}
     */
    async resetPassword(req, res) {
      const id = parseUserId(req.params.id);
      if (id === null) {
        renderNotFound(res);
        return;
      }

      const temporaryPassword = generateTemporaryPassword();
      let result;
      try {
        result = await usersService.resetUserPassword(id, temporaryPassword, actorOf(req));
      } catch (error) {
        if (error instanceof NotFoundError) {
          renderNotFound(res);
          return;
        }
        throw error;
      }

      req.session.flash = {
        type: PASSWORD_RESET_FLASH,
        targetEmail: result.user.email,
        temporaryPassword: result.temporaryPassword,
      };
      res.redirect('/app/admin/users');
    },

    /**
     * @type {import('express').RequestHandler}
     */
    async audit(req, res) {
      const filters = auditFiltersSchema.parse(req.query);
      const dataAnchor = await referenceRepository.getDataAnchor();
      const [journal, users] = await Promise.all([
        auditService.listAuditEntries(filters),
        usersService.listUsersForView(),
      ]);
      const options = auditService.getFilterOptions();

      res.render('pages/audit', {
        ...buildShellLocals(req, { title: 'Аудит', activeNav: 'audit', dataAnchor }),
        journal,
        filterUsers: users,
        actionOptions: options.actions,
        entityOptions: options.entities,
      });
    },

    /**
     * @type {import('express').RequestHandler}
     */
    async profile(req, res) {
      await renderProfile(req, res);
    },

    /**
     * @type {import('express').RequestHandler}
     */
    async changePassword(req, res) {
      const parsed = ownPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        await renderProfile(req, res, { status: 400, error: parsed.error.issues[0]?.message });
        return;
      }

      try {
        await usersService.changeOwnPassword(req.session.user.id, parsed.data, {
          ...actorOf(req),
          sessionId: req.sessionID,
        });
      } catch (error) {
        if (error instanceof NotFoundError) {
          renderNotFound(res);
          return;
        }
        if (error instanceof ValidationError) {
          await renderProfile(req, res, { status: 400, error: error.message });
          return;
        }
        throw error;
      }
      res.redirect('/app/profile');
    },
  };
}
