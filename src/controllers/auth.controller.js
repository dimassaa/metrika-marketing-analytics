import { z } from 'zod';
import { UnauthorizedError } from '../lib/errors.js';
import { issueCsrfToken } from '../lib/csrf.js';
import { renderLoginPage } from '../lib/loginPage.js';
import {
  SESSION_COOKIE_NAME,
  destroySession,
  regenerateSession,
  sessionCookieOptions,
} from '../lib/session.js';
import { safeRedirectTarget } from '../middleware/auth.js';

const loginSchema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(1024),
  next: z.string().optional(),
});

/**
 * Keeps a rejected e-mail in the input short enough to render and impossible to turn into an array by repeating the
 * field in the form body.
 * @param {unknown} value
 * @returns {string}
 */
function formEmail(value) {
  return typeof value === 'string' ? value.slice(0, 254) : '';
}

/**
 * @param {{
 *   authService: ReturnType<typeof import('../services/auth.service.js').createAuthService>,
 *   auditService: ReturnType<typeof import('../services/audit.service.js').createAuditService>,
 * }} deps
 */
export function createAuthController({ authService, auditService }) {
  return {
    /**
     * Shows the form, or sends an already authenticated user straight to the app.
     * @type {import('express').RequestHandler}
     */
    showLogin(req, res) {
      if (req.session?.user) {
        res.redirect('/app/dashboard');
        return;
      }
      renderLoginPage(req, res, { next: safeRedirectTarget(req.query.next) });
    },

    /**
     * Validates the body, verifies credentials, rotates the session id and redirects to the safe `next` target.
     * @type {import('express').RequestHandler}
     */
    async login(req, res) {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        renderLoginPage(req, res, {
          status: 400,
          error: 'Введите корректный email и пароль.',
          email: formEmail(req.body?.email),
          next: safeRedirectTarget(req.body?.next),
        });
        return;
      }

      const { email, password } = parsed.data;
      const next = safeRedirectTarget(parsed.data.next);
      let user;
      try {
        user = await authService.login(email, password, req.ip);
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error;
        renderLoginPage(req, res, { status: 401, error: error.message, email, next });
        return;
      }

      await regenerateSession(req);
      req.session.user = user;
      // A fresh token for the authenticated session; the anonymous one does not survive the id rotation.
      issueCsrfToken(req);
      await auditService.record({
        userId: user.id,
        action: 'auth.login',
        entity: 'user',
        entityId: user.id,
        ip: req.ip,
      });
      res.redirect(next);
    },

    /**
     * Destroys the server-side session and clears the cookie. The audit entry is written for the captured actor
     * because the session no longer exists after `destroy`.
     * @type {import('express').RequestHandler}
     */
    async logout(req, res) {
      const user = req.session?.user ?? null;
      await destroySession(req);
      res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions());
      if (user) {
        await auditService.record({
          userId: user.id,
          action: 'auth.logout',
          entity: 'user',
          entityId: user.id,
          ip: req.ip,
        });
      }
      res.redirect('/login');
    },
  };
}
