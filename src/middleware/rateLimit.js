import rateLimit from 'express-rate-limit';
import { renderLoginPage } from '../lib/loginPage.js';
import { normalizeEmail } from '../services/auth.service.js';
import { safeRedirectTarget } from './auth.js';

/** Brute-force window fixed by the design spec: five attempts per e-mail and address in fifteen minutes. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 5;
const RATE_LIMIT_MESSAGE = 'Слишком много попыток входа. Попробуйте снова через 15 минут.';

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
    keyGenerator: (req) => `${req.ip}:${normalizeEmail(req.body?.email).slice(0, 254)}`,
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
