import { ForbiddenError } from '../lib/errors.js';
import { issueCsrfToken, verifyCsrfToken } from '../lib/csrf.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Reads the submitted token. The header is the path React islands and fetch calls use; `_csrf` is the plain form
 * fallback. A repeated form field arrives as an array under express.urlencoded, which is rejected rather than coerced.
 * @param {import('express').Request} req
 * @returns {string | undefined}
 */
function submittedToken(req) {
  const header = req.get('x-csrf-token');
  if (header) return header;
  return typeof req.body?._csrf === 'string' ? req.body._csrf : undefined;
}

/**
 * Double-submit CSRF protection for every non-safe method.
 *
 * The token local is only populated for authenticated sessions; the anonymous login form asks for a token through
 * `renderLoginPage`. Public pages therefore never create a session just to carry a token, and a rejected anonymous
 * POST leaves the session store untouched.
 *
 * Safe requests from an authenticated user also publish the token in `X-CSRF-Token`, which is how the app shell and
 * future islands obtain it without a hidden form.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function csrfProtection(req, res, next) {
  const safeMethod = SAFE_METHODS.has(req.method);

  if (!safeMethod && !verifyCsrfToken(req, submittedToken(req))) {
    next(new ForbiddenError('CSRF token mismatch'));
    return;
  }

  if (req.session?.user) {
    const token = issueCsrfToken(req);
    // A plain enumerable property: express-ejs-layouts copies locals with a for-in loop before rendering the layout.
    res.locals.csrfToken = token;
    // Authenticated pages are per-user and carry a CSRF token; shared caches must never store them.
    res.set('Cache-Control', 'no-store');
    if (safeMethod) {
      res.set('X-CSRF-Token', token);
    }
  }

  next();
}
