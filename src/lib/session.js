import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { env } from '../config/env.js';

const PgStore = connectPgSimple(session);

export const SESSION_COOKIE_NAME = 'metrika.sid';
/** Absolute session lifetime; the cookie and the store row expire together. */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Cookie attributes for both `Set-Cookie` and `clearCookie`.
 *
 * `clearCookie` only removes the cookie when path and domain match the ones used to set it, so this object is the
 * single source for both calls. `secure` follows COOKIE_SECURE: production runs behind TLS, local HTTP does not.
 * @returns {import('express-session').CookieOptions & { maxAge: number }}
 */
export function sessionCookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.cookieSecure,
    maxAge: SESSION_TTL_MS,
  };
}

/**
 * Creates the PostgreSQL-backed session store. The caller injects the pool: production passes the shared pool,
 * integration tests pass the test pool or a MemoryStore, so no test ever writes sessions to the development database.
 * @param {import('pg').Pool} pool
 * @returns {import('express-session').Store}
 */
export function createPgSessionStore(pool) {
  return new PgStore({
    pool,
    // connect-pg-simple defaults to a table named `session`; the schema in db/migrations owns `sessions`.
    tableName: 'sessions',
    ttl: SESSION_TTL_MS / 1000,
  });
}

/**
 * @param {{ store: import('express-session').Store }} options
 * @returns {import('express').RequestHandler}
 */
export function createSessionMiddleware({ store }) {
  return session({
    name: SESSION_COOKIE_NAME,
    secret: env.sessionSecret,
    store,
    resave: false,
    // Anonymous visitors get no session row until CSRF middleware actually issues a token.
    saveUninitialized: false,
    cookie: sessionCookieOptions(),
  });
}

/**
 * Promise wrapper around `req.session.regenerate`. Login must rotate the session id to defeat session fixation,
 * and the callback API would otherwise force nested callbacks into the controller.
 * @param {import('express').Request} req
 * @returns {Promise<void>}
 */
export function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Promise wrapper around `req.session.destroy`.
 * @param {import('express').Request} req
 * @returns {Promise<void>}
 */
export function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}
