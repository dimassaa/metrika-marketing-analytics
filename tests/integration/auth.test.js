import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { DEMO_PASSWORD, loginAs, makeApp } from '../helpers/app.js';
import { getCsrf } from '../helpers/csrf.js';

const ADMIN = 'admin@metrika.by';
const ANALYST = 'analyst@metrika.by';
const VIEWER = 'viewer@metrika.by';

/** @type {import('pg').Pool} */
let pool;
/** @type {import('express').Express} */
let app;

/** @returns {Promise<number>} Rows in the session store table; used to prove a rejected request created none. */
async function countSessions() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM sessions');
  return rows[0].n;
}

/** @returns {Promise<import('supertest').Response>} A fresh anonymous agent cookie-jar over the current app. */
function newAgent() {
  return request.agent(app);
}

beforeAll(async () => {
  await resetTestDatabase();
  await seed();
  pool = getTestPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  // Sessions and the rate-limit store are per-test fixtures: a leftover cookie or a consumed attempt would make the
  // next test depend on test order.
  await pool.query('DELETE FROM sessions');
  app = makeApp();
});

describe('login page', () => {
  it('renders the form with a CSRF token', async () => {
    const res = await newAgent().get('/login');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('name="_csrf"');
    expect(res.text).toContain('action="/login"');
    expect(res.text).toContain('admin@metrika.by');
  });
});

describe('POST /login', () => {
  it('rejects a request without a CSRF token and creates no session', async () => {
    const res = await newAgent()
      .post('/login')
      .type('form')
      .send({ email: ADMIN, password: DEMO_PASSWORD });

    expect(res.status).toBe(403);
    expect(await countSessions()).toBe(0);
  });

  it('signs a valid user in and sets an HttpOnly session cookie', async () => {
    const agent = newAgent();
    const csrf = await getCsrf(agent);

    const res = await agent.post('/login').type('form').send({ email: ADMIN, password: DEMO_PASSWORD, _csrf: csrf });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/dashboard');
    const cookie = res.headers['set-cookie'].find((value) => value.startsWith('metrika.sid='));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(await countSessions()).toBeGreaterThan(0);
  });

  it('answers a wrong password with one generic message', async () => {
    const agent = newAgent();
    const csrf = await getCsrf(agent);

    const res = await agent
      .post('/login')
      .type('form')
      .send({ email: ADMIN, password: 'definitely-not-the-password', _csrf: csrf });

    expect(res.status).toBe(401);
    expect(res.text).toContain('Неверный email или пароль');
    expect(res.text).not.toContain('не найден');
  });

  it('answers an inactive user with the same generic message', async () => {
    await pool.query('UPDATE users SET is_active = false WHERE email = $1', [ANALYST]);
    try {
      const agent = newAgent();
      const csrf = await getCsrf(agent);

      const res = await agent
        .post('/login')
        .type('form')
        .send({ email: ANALYST, password: DEMO_PASSWORD, _csrf: csrf });

      expect(res.status).toBe(401);
      expect(res.text).toContain('Неверный email или пароль');
    } finally {
      await pool.query('UPDATE users SET is_active = true WHERE email = $1', [ANALYST]);
    }
  });

  it('ignores an external next target', async () => {
    const agent = newAgent();
    const csrf = await getCsrf(agent);

    const res = await agent
      .post('/login')
      .type('form')
      .send({ email: ADMIN, password: DEMO_PASSWORD, next: 'https://evil.example', _csrf: csrf });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/dashboard');
  });

  it('honours a next target inside the app', async () => {
    const agent = newAgent();
    const csrf = await getCsrf(agent);

    const res = await agent
      .post('/login')
      .type('form')
      .send({ email: ADMIN, password: DEMO_PASSWORD, next: '/app/admin/users', _csrf: csrf });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/admin/users');
  });

  it('stops after five failed attempts inside the window', async () => {
    const agent = newAgent();
    const csrf = await getCsrf(agent);
    const attempt = () =>
      agent
        .post('/login')
        .type('form')
        .send({ email: VIEWER, password: 'definitely-not-the-password', _csrf: csrf });

    const statuses = [];
    for (let index = 0; index < 6; index += 1) {
      statuses.push((await attempt()).status);
    }

    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });
});

describe('POST /logout', () => {
  it('destroys the session and sends the next visit back to login', async () => {
    const agent = newAgent();
    const login = await loginAs(agent, ADMIN);
    expect(login.status).toBe(302);

    // Authenticated GETs publish the current token for fetch-based islands; the form fallback is `_csrf`.
    const dashboard = await agent.get('/app/dashboard');
    expect(dashboard.status).toBe(200);
    const csrf = dashboard.headers['x-csrf-token'];
    expect(csrf).toBeTruthy();

    const logout = await agent.post('/logout').type('form').send({ _csrf: csrf });
    expect(logout.status).toBe(302);
    expect(logout.headers.location).toBe('/login');

    const after = await agent.get('/app/dashboard');
    expect(after.status).toBe(302);
    expect(after.headers.location).toMatch(/^\/login\?next=/);
  });
});
