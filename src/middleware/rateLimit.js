import rateLimit from 'express-rate-limit';
import { clientIp } from '../lib/clientIp.js';
import { renderLoginPage } from '../lib/loginPage.js';
import { normalizeEmail } from '../services/auth.service.js';
import { safeRedirectTarget } from './auth.js';

/** Brute-force window fixed by the design spec: five attempts per e-mail and address in fifteen minutes. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 5;
const RATE_LIMIT_MESSAGE = 'Слишком много попыток входа. Попробуйте снова через 15 минут.';

/** Import quota from the spec: twenty files per person per fifteen minutes. */
const IMPORT_WINDOW_MS = 15 * 60 * 1000;
const IMPORT_ATTEMPT_LIMIT = 20;
const IMPORT_RATE_LIMIT_MESSAGE = 'Слишком много импортов. Попробуйте снова через 15 минут.';

/**
 * Address part of a limiter key. `req.ip` is only used when it is an IP literal: a forged header accepted by an
 * over-trusted proxy must not rotate the key. The socket address is the honest fallback.
 * @param {import('express').Request} req
 * @returns {string}
 */
function rateLimitAddress(req) {
  return clientIp(req) ?? req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Builds a dedicated login limiter with its own in-memory store.
 *
 * The limiter is created per application rather than shared as a module singleton: integration tests build a fresh
 * app for each case, so one test's five attempts cannot exhaust another test's window. In production a single app
 * instance gets a single store, which is the intended behaviour.
 *
 * @returns {import('express').RequestHandler}
 */
export function createLoginRateLimiter() {
  return rateLimit({
    windowMs: LOGIN_WINDOW_MS,
    limit: LOGIN_ATTEMPT_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    // The design spec locks the account after five *failed* attempts; a successful login must not use up the quota.
    skipSuccessfulRequests: true,
    // Keying by address alone would let one office IP exhaust every account; keying by e-mail alone would let an
    // attacker lock a known account from anywhere. The pair limits both vectors.
    keyGenerator: (req) => `${rateLimitAddress(req)}:${normalizeEmail(req.body?.email).slice(0, 254)}`,
    handler: (req, res) => {
      renderLoginPage(req, res, {
        status: 429,
        error: RATE_LIMIT_MESSAGE,
        email: typeof req.body?.email === 'string' ? req.body.email : '',
        next: safeRedirectTarget(req.body?.next),
      });
    },
  });
}

/**
 * Builds the import limiter with its own store, one per application instance.
 *
 * The quota belongs to a person, not to an address: several analysts may share an office IP, and one person must not
 * be able to reset their quota by switching networks. The session user id is therefore the key, with the address as
 * the fallback for a request that reached the limiter without a session (the route guard normally rejects it first).
 *
 * @returns {import('express').RequestHandler}
 */
export function createImportRateLimiter() {
  return rateLimit({
    windowMs: IMPORT_WINDOW_MS,
    limit: IMPORT_ATTEMPT_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.session?.user?.id ?? rateLimitAddress(req)),
    handler: (req, res) => {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: IMPORT_RATE_LIMIT_MESSAGE },
      });
    },
  });
}
