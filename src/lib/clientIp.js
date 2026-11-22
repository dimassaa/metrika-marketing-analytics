import { isIP } from 'node:net';
import { logger } from './logger.js';

/**
 * Validates an address before it reaches an `INET` column or a rate-limit key.
 *
 * `req.ip` is attacker-controlled whenever Express trusts a proxy hop: a forged `X-Forwarded-For` becomes `req.ip`
 * verbatim. Passing it to `audit_log.ip` (INET) raises SQLSTATE 22P02 *after* the mutation committed, turning a
 * successful write into a 500 with no audit row. Anything that is not an IP literal is therefore "unknown", never a
 * value to store or key on.
 *
 * @param {unknown} value Raw address, usually `req.ip`.
 * @returns {string | null} The address as an IP literal, or null when it is missing or malformed.
 */
export function normalizeIp(value) {
  if (typeof value !== 'string' || value === '') return null;
  return isIP(value) === 0 ? null : value;
}

/** A misconfigured proxy would otherwise emit the same warning on every request; one line per process is enough. */
let invalidIpWarned = false;

/**
 * Reads the caller address from a request, keeping only a valid IP literal.
 * @param {import('express').Request} req
 * @returns {string | null} Valid IP, or null when the header the proxy trust let through is not an address.
 */
export function clientIp(req) {
  const raw = req?.ip;
  const valid = normalizeIp(raw);
  if (valid === null && raw && !invalidIpWarned) {
    invalidIpWarned = true;
    logger.warn({ ip: raw, requestId: req?.id }, 'ignoring non-IP client address');
  }
  return valid;
}
