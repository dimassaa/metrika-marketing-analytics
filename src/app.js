import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import expressLayouts from 'express-ejs-layouts';
import helmet from 'helmet';
import compression from 'compression';
import { pinoHttp } from 'pino-http';
import { HTTP_LOG_SERIALIZERS, logger } from './lib/logger.js';
import { requestId } from './middleware/requestId.js';
import { errorHandler, notFound } from './middleware/errors.js';
import publicRoutes from './routes/public.routes.js';
import { notFoundPage } from './controllers/public.controller.js';
import { can } from './config/permissions.js';
import { createPgSessionStore, createSessionMiddleware } from './lib/session.js';
import { csrfProtection } from './middleware/csrf.js';
import { requireAuth } from './middleware/auth.js';
import { createUsersRepository } from './repositories/users.repo.js';
import { createReferenceRepository } from './repositories/reference.repo.js';
import { createAuditRepository } from './repositories/audit.repo.js';
import { createChannelsRepository } from './repositories/channels.repo.js';
import { createCampaignsRepository } from './repositories/campaigns.repo.js';
import { createGoalsRepository } from './repositories/goals.repo.js';
import { createImportRepository } from './repositories/import.repo.js';
import { createAuthService } from './services/auth.service.js';
import { createAuditService } from './services/audit.service.js';
import { createUsersService } from './services/users.service.js';
import { createChannelsService } from './services/channels.service.js';
import { createCampaignsService } from './services/campaigns.service.js';
import { createGoalsService } from './services/goals.service.js';
import { createImportService } from './services/import.service.js';
import { createAuthController } from './controllers/auth.controller.js';
import { createImportController } from './controllers/import.controller.js';
import { createAuthRouter } from './routes/auth.routes.js';
import { createAppRouter } from './routes/app.routes.js';
import { createApiRouter } from './routes/api.routes.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const viewsDir = fileURLToPath(new URL('./views', import.meta.url));
const publicDir = fileURLToPath(new URL('../public', import.meta.url));

/**
 * Builds the Express application. The database is injected rather than imported so tests can run without a real
 * connection. `db` is the shared PostgreSQL pool in production; it also backs the default session store, which keeps
 * integration tests on the test database. Tests that need no sessions pass a `MemoryStore` explicitly.
 * @param {{
 *   db: {
 *     query: (text: string, params?: unknown[]) => Promise<unknown>,
 *     connect: () => Promise<import('pg').PoolClient>,
 *   } & Partial<import('pg').Pool>,
 *   sessionStore?: import('express-session').Store,
 * }} deps `db.connect` backs `withTransaction`: the import writes data, its batch and its audit row in one
 *   transaction. Integration tests pass a pool pointed at the test database, never the shared one.
 * @returns {import('express').Express}
 */
export function createApp({ db, sessionStore } = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('createApp requires a db object with a query(text, params) method');
  }

  const usersRepository = createUsersRepository(db);
  const referenceRepository = createReferenceRepository(db);
  const auditRepository = createAuditRepository(db);
  const channelsRepository = createChannelsRepository(db);
  const campaignsRepository = createCampaignsRepository(db);
  const goalsRepository = createGoalsRepository(db);
  // The pooled import repository serves the read-only batch screens; writes are created from the transaction client
  // inside the import service, so a rollback cannot leave an orphan batch.
  const importRepository = createImportRepository(db);
  const authService = createAuthService({ usersRepository });
  const auditService = createAuditService({ auditRepository });
  const usersService = createUsersService({ db, usersRepository, auditService });
  const channelsService = createChannelsService({ channelsRepository, auditService });
  const campaignsService = createCampaignsService({ campaignsRepository, channelsRepository, auditService });
  const goalsService = createGoalsService({ db, goalsRepository, auditService });
  const importService = createImportService({ db, importRepository });
  const authController = createAuthController({ authService, auditService });
  const importController = createImportController({ importService, referenceRepository });
  const store = sessionStore ?? createPgSessionStore(db);

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Server-rendered EJS with one public layout; React islands will add their own scripts in later milestones.
  app.set('view engine', 'ejs');
  app.set('views', viewsDir);
  app.use(expressLayouts);

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

  // Custom serializers keep `set-cookie` (the live session id) and `x-csrf-token` out of the log stream; the
  // pino-http defaults log every response header. See `src/lib/logger.js`.
  app.use(pinoHttp({ logger, serializers: HTTP_LOG_SERIALIZERS, genReqId: (req) => req.id }));
  app.use(compression());
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // Fonts, the single stylesheet and SVG assets live here. Fingerprinted React assets will get immutable caching.
  app.use(express.static(publicDir));

  // Session → CSRF → locals → routes is the required order: the token lives in the session, the templates read the
  // token and the current user, and only then can a route guard redirect or render.
  app.use(createSessionMiddleware({ store }));
  app.use(csrfProtection);
  app.use((req, res, next) => {
    res.locals.currentUser = req.session?.user ?? null;
    res.locals.can = (permission) => can(req.session?.user?.role, permission);
    next();
  });

  app.use('/', publicRoutes);
  app.use(createAuthRouter({ authController }));
  // Mounted after `csrfProtection`: every mutating API call carries `X-CSRF-Token`, including multipart uploads,
  // whose body cannot be parsed by the global CSRF middleware.
  app.use('/api/v1', createApiRouter({ importController }));
  app.use('/app', createAppRouter({
    requireAuth,
    referenceRepository,
    usersService,
    auditService,
    channelsService,
    campaignsService,
    goalsService,
    importController,
  }));

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

  // Pages get the designed 404; API clients keep the JSON contract from the shared middleware. No database access,
  // so an unknown URL still renders the correct page when PostgreSQL is down.
  app.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    notFoundPage(req, res);
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
