import { createApp } from '../../src/app.js';
import { getTestPool } from './db.js';
import { getCsrf } from './csrf.js';

/** Password of every seeded demo account; mirrors `DEMO_PASSWORD` in `db/seed/data.js`. */
export const DEMO_PASSWORD = 'Metrika2026!';

/**
 * Builds a fresh application over the test database.
 *
 * A new app per test also means a fresh login rate-limit store: the limiter lives inside `createApp`, so attempts
 * made by one test cannot consume another test's window. The session store defaults to the PostgreSQL table and
 * therefore uses `getTestPool()`, never the development database.
 * @param {{ trustProxy?: false | true | number | string }} [options] Forwarded to `createApp`; the forged-header
 *   regressions pass `trustProxy: 1` to make Express read `X-Forwarded-For`.
 * @returns {import('express').Express}
 */
export function makeApp(options = {}) {
  return createApp({ db: getTestPool(), ...options });
}

/**
 * Logs an agent in through the real HTTP form, CSRF included.
 * @param {import('supertest').SuperAgentTest} agent
 * @param {string} email
 * @param {string} [password]
 * @returns {Promise<import('supertest').Response>} The POST /login response; callers assert its redirect.
 */
export async function loginAs(agent, email, password = DEMO_PASSWORD) {
  const csrf = await getCsrf(agent);
  return agent.post('/login').type('form').send({ email, password, _csrf: csrf });
}
