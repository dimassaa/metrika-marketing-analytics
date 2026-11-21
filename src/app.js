import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { pinoHttp } from 'pino-http';
import { logger } from './lib/logger.js';
import { requestId } from './middleware/requestId.js';
import { errorHandler, notFound } from './middleware/errors.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * Builds the Express application. The database is injected rather than imported so tests can run without a real
 * connection and later tasks can add a session store without touching this factory's callers.
 * @param {{ db: { query: (text: string, params?: unknown[]) => Promise<unknown> } }} deps
 * @returns {import('express').Express}
 */
export function createApp({ db } = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('createApp requires a db object with a query(text, params) method');
  }

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);

  // The nonce has to exist before helmet builds the CSP header; templates read it back from res.locals.nonce.
  app.use((req, res, next) => {
    res.locals.nonce = crypto.randomBytes(16).toString('base64');
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        // Explicit full directive list: helmet's defaults relax style-src with 'unsafe-inline', which we avoid.
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'object-src': ["'none'"],
          'script-src': ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
          'script-src-attr': ["'none'"],
          'style-src': ["'self'"],
          // Recharts sets inline style attributes, which are not covered by style-src.
          'style-src-attr': ["'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
          'font-src': ["'self'"],
          'connect-src': ["'self'"],
          'frame-ancestors': ["'none'"],
        },
      },
    }),
  );

  app.use(pinoHttp({ logger, genReqId: (req) => req.id }));
  app.use(compression());
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  app.get('/health', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await db.query('SELECT 1');
      res.json({ status: 'ok', db: 'up', version });
    } catch (error) {
      logger.warn({ err: error, requestId: req.id }, 'health check failed');
      res.status(503).json({ status: 'error', db: 'down', version });
    }
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
