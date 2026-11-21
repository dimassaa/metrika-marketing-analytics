import { buildSeo } from './seo.js';
import { issueCsrfToken } from './csrf.js';

const LOGIN_SEO = buildSeo({
  title: 'Вход в демо — Метрика',
  description: 'Войдите в демо-версию «Метрики», чтобы посмотреть CAC, LTV и ROMI по каналам на данных кофейни «Зёрна».',
  path: '/login',
  noindex: true,
});

/**
 * Renders the login page and issues the CSRF token the form needs.
 *
 * Shared by the controller and the rate limiter so a blocked sixth attempt shows the same form with a 429 status
 * instead of a bare error page. The token is created on demand: an anonymous visitor who never requests this page
 * gets no session at all.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ status?: number, error?: string | null, email?: string, next?: string }} [view]
 */
export function renderLoginPage(req, res, { status = 200, error = null, email = '', next = '/app/dashboard' } = {}) {
  // The form embeds a per-session CSRF token, so this response must not be reused from a cache.
  res.set('Cache-Control', 'no-store');
  res.status(status).render('pages/login', {
    layout: 'layouts/public',
    seo: LOGIN_SEO,
    year: new Date().getFullYear(),
    error,
    email,
    next,
    csrfToken: issueCsrfToken(req),
  });
}
