import { fileURLToPath } from 'node:url';
import express from 'express';
import expressLayouts from 'express-ejs-layouts';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notFoundPage } from '../../src/controllers/public.controller.js';
import { requirePermission } from '../../src/middleware/auth.js';
import { errorHandler, notFound } from '../../src/middleware/errors.js';
import { ForbiddenError } from '../../src/lib/errors.js';
import { logger } from '../../src/lib/logger.js';

const viewsDir = fileURLToPath(new URL('../../src/views', import.meta.url));

/**
 * Minimal app that reuses the production error contract without the product routers or a database.
 *
 * The styled 500 page has to work when PostgreSQL is the failing dependency, so the regression route throws from a
 * handler instead of breaking the pool: the test stays deterministic and never waits on a connection timeout.
 * @returns {import('express').Express}
 */
function createErrorApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', viewsDir);
  app.use(expressLayouts);
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.locals.nonce = 'test-nonce';
    res.locals.currentUser = null;
    next();
  });

  app.get('/page-missing', notFoundPage);
  app.get(
    '/page-forbidden',
    (req, res, next) => {
      req.session = { user: { id: 1, role: 'viewer' } };
      next();
    },
    requirePermission('users:manage'),
  );
  // `all` keeps the logging regression able to POST a body; the throw is the same on every method.
  app.all('/page-boom', () => {
    throw new Error('kaboom-internal-detail');
  });

  // The terminal `notFound` only keeps the JSON contract for API paths, exactly as in `createApp`.
  app.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    notFoundPage(req, res);
  });
  app.use('/api', (req, res, next) => {
    if (req.path === '/forbidden') {
      next(new ForbiddenError());
      return;
    }
    if (req.path === '/boom') {
      next(new Error('kaboom-internal-detail'));
      return;
    }
    next();
  });
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

const app = createErrorApp();

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The three robots/meta signals every error page must carry: no canonical index entry, a Russian document, and the
 * designed shell instead of Express' default HTML.
 * @param {string} html
 */
function expectStyledErrorPage(html) {
  expect(html).toContain('<html lang="ru">');
  expect(html).toContain('class="section error-page"');
  expect(html).toContain('href="/css/app.css"');
  expect(html).toMatch(/<meta name="robots" content="noindex, nofollow">/);
}

describe('HTML error pages', () => {
  it('answers an unknown page with the styled 404 and noindex', async () => {
    const res = await request(app).get('/page-missing');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expectStyledErrorPage(res.text);
    expect(res.text).toContain('404');
    expect(res.text).toContain('Страница не найдена');
  });

  it('answers a forbidden page with the styled 403 and a Russian explanation', async () => {
    const res = await request(app).get('/page-forbidden');

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expectStyledErrorPage(res.text);
    expect(res.text).toContain('403');
    expect(res.text).toContain('Недостаточно прав');
  });

  it('answers an unexpected failure with the styled 500 and leaks no stack trace or error text', async () => {
    const res = await request(app).get('/page-boom');

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expectStyledErrorPage(res.text);
    expect(res.text).toContain('Что-то сломалось');
    expect(res.text).not.toContain('kaboom-internal-detail');
    expect(res.text).not.toContain('at createErrorApp');
  });
});

describe('API error contract', () => {
  it('answers an unknown API route with JSON', async () => {
    const res = await request(app).get('/api/missing');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Страница не найдена' } });
  });

  it('answers a forbidden API route with JSON', async () => {
    const res = await request(app).get('/api/forbidden');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: 'FORBIDDEN', message: 'Недостаточно прав' } });
  });

  it('answers an API crash with an opaque JSON 500', async () => {
    const res = await request(app).get('/api/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера' } });
    expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message']);
    expect(res.text).not.toContain('kaboom-internal-detail');
    expect(res.text).not.toContain('stack');
  });
});

describe('500 logging', () => {
  it('logs only the error and the request id, never the request body or cookies', async () => {
    const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const res = await request(app)
      .post('/page-boom')
      .set('Cookie', 'metrika.sid=cookie-session-secret')
      .send({ password: 'hunter2-password-marker', note: 'private-body-marker' });

    expect(res.status).toBe(500);
    expect(logSpy).toHaveBeenCalledTimes(1);

    const [payload, message] = logSpy.mock.calls[0];
    // The handler must forward the error and correlation id only; passing `req` would drag cookies and the body in.
    expect(Object.keys(payload).sort()).toEqual(['err', 'requestId']);
    expect(message).toBe('request failed');
    const serialized = JSON.stringify({ payload, message });
    expect(serialized).not.toContain('cookie-session-secret');
    expect(serialized).not.toContain('hunter2-password-marker');
    expect(serialized).not.toContain('private-body-marker');
    // The response itself is the opaque page, not the payload.
    expect(res.text).not.toContain('cookie-session-secret');
    expect(res.text).not.toContain('hunter2-password-marker');
  });
});
