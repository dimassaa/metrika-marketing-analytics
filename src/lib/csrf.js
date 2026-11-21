import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Returns the session's CSRF token, creating one on first use. The token is 32 random bytes encoded as base64url,
 * so it is URL-safe and cannot be guessed. Storing it in the session is what makes it a real double-submit check:
 * an attacker who can read the page still cannot read the httpOnly session cookie.
 * @param {import('express').Request} req Request with an initialised session.
 * @returns {string}
 * @throws {Error} When the session middleware did not run first; that is a wiring bug, not a user error.
 */
export function issueCsrfToken(req) {
  if (!req.session) {
    throw new Error('CSRF token requires session middleware to run first');
  }
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomBytes(32).toString('base64url');
  }
  return req.session.csrfToken;
}

/**
 * Compares the submitted token with the session token in constant time.
 *
 * `timingSafeEqual` throws on different buffer lengths, so the length check comes first; base64url encodes 32 bytes
 * into a fixed 43-character string, which leaks nothing beyond "the token had the wrong shape".
 *
 * @param {import('express').Request} req
 * @param {unknown} token Raw value from the `x-csrf-token` header or the `_csrf` form field.
 * @returns {boolean}
 */
export function verifyCsrfToken(req, token) {
  const expected = req.session?.csrfToken;
  if (typeof expected !== 'string' || typeof token !== 'string' || token.length === 0) {
    return false;
  }
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const submittedBuffer = Buffer.from(token, 'utf8');
  if (expectedBuffer.length !== submittedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, submittedBuffer);
}
