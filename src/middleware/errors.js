import { logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { buildSeo } from '../lib/seo.js';

const SERVER_ERROR_SEO = buildSeo({
  title: 'Ошибка сервера — Метрика',
  description: 'Внутренняя ошибка. Попробуйте обновить страницу или вернитесь на главную.',
  path: '/',
  noindex: true,
});

function isApiRequest(req) {
  return req.path === '/api' || req.path.startsWith('/api/');
}

/**
 * Honours AppError status codes and http-errors style `err.status` (Express body parsers use it), everything else
 * is a 500. Kept explicit instead of nested ternaries so the precedence stays readable.
 */
function resolveStatusCode(err) {
  if (err instanceof AppError) return err.statusCode;
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 600) return err.status;
  return 500;
}

function fallbackMessage(statusCode) {
  if (statusCode === 400) return 'Некорректный запрос';
  if (statusCode === 401) return 'Требуется вход';
  if (statusCode === 403) return 'Недостаточно прав';
  if (statusCode === 404) return 'Страница не найдена';
  return 'Внутренняя ошибка сервера';
}

/**
 * Terminal 404 handler and last-resort fallback. Page requests reach the designed `errors/404` page through
 * `notFoundPage` before this middleware; only `/api` and a request that somehow bypassed the page handler land here.
 * They keep the JSON contract (or a plain status text), so a 404 is never an unhandled Express default page.
 */
export function notFound(req, res) {
  if (isApiRequest(req)) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Страница не найдена' } });
    return;
  }
  res.status(404).type('text/plain; charset=utf-8').send('Страница не найдена');
}

/**
 * Central error handler. Expected failures (AppError) keep their status, code and message; anything else becomes
 * an opaque 500 so internal details and stack traces never reach the client. Must stay the last middleware.
 */
export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }

  const statusCode = resolveStatusCode(err);
  const code = err instanceof AppError ? err.code : statusCode < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR';
  const message = err instanceof AppError ? err.message : fallbackMessage(statusCode);

  if (statusCode >= 500) {
    logger.error({ err, requestId: req.id }, 'request failed');
  }

  if (isApiRequest(req)) {
    res.status(statusCode).json({ error: { code, message } });
    return;
  }

  // Operational 4xx failures keep the short text contract; a 500 gets the designed page because it is the only
  // failure a person is likely to see while using the app. Rendering needs no database, so it also works when the
  // original failure was the database itself.
  if (statusCode >= 500) {
    res.status(statusCode).render('errors/500', {
      layout: 'layouts/public',
      seo: SERVER_ERROR_SEO,
      year: new Date().getFullYear(),
    });
    return;
  }

  res.status(statusCode).type('text/plain; charset=utf-8').send(message);
}
