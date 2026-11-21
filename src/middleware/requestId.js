import crypto from 'node:crypto';

/**
 * Assigns every request a correlation id, exposes it as `x-request-id` and on `req.id` so pino-http and later
 * audit code can reference the same value. Ids are always generated locally: trusting a client-supplied header
 * would let a caller forge log correlation and inject arbitrary characters into logs.
 */
export function requestId(req, res, next) {
  req.id = crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}
