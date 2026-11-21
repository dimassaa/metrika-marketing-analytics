import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { can } from '../config/permissions.js';
import { buildSeo } from '../lib/seo.js';

const DEFAULT_APP_PATH = '/app/dashboard';

const FORBIDDEN_SEO = buildSeo({
  title: 'Недостаточно прав — Метрика',
  description: 'У вашей роли нет доступа к этому разделу. Вернитесь в дашборд или попросите администратора выдать права.',
  path: '/app',
  noindex: true,
});

/**
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isApiRequest(req) {
  return req.path === '/api' || req.path.startsWith('/api/');
}

/**
 * Returns a user-supplied redirect target only when it is a path inside `/app`.
 *
 * `//evil.example` is a protocol-relative URL and `\` is treated as `/` by several browsers, so both are rejected
 * along with CR/LF (header injection). Anything unexpected falls back to the dashboard.
 * @param {unknown} value Raw `next` value from a query string or form field.
 * @returns {string} A safe `/app/...` path.
 */
export function safeRedirectTarget(value) {
  if (typeof value !== 'string') return DEFAULT_APP_PATH;
  if (!value.startsWith('/app/') || value.includes('//') || value.includes('\\') || /[\r\n]/.test(value)) {
    return DEFAULT_APP_PATH;
  }
  return value;
}

/**
 * Rejects anonymous access. Page requests are sent to the login form with a `next` back-link; API clients get the
 * JSON 401 contract from the central error handler instead of a redirect.
 * @type {import('express').RequestHandler}
 */
export function requireAuth(req, res, next) {
  if (req.session?.user) {
    next();
    return;
  }
  if (isApiRequest(req)) {
    next(new UnauthorizedError());
    return;
  }
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

/**
 * Rejects authenticated users whose role lacks the permission. The check is deliberately server-side: hiding a
 * sidebar link is presentation, not access control.
 * @param {string} permission Permission code from `config/permissions.js`.
 * @returns {import('express').RequestHandler}
 */
export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.session?.user) {
      requireAuth(req, res, next);
      return;
    }
    if (can(req.session.user.role, permission)) {
      next();
      return;
    }
    if (isApiRequest(req)) {
      next(new ForbiddenError());
      return;
    }
    res.status(403).render('errors/403', {
      layout: 'layouts/public',
      seo: FORBIDDEN_SEO,
      year: new Date().getFullYear(),
    });
  };
}
