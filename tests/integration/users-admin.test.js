import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { hash } from '@node-rs/argon2';
import { seed } from '../../db/seed/seed.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
import { getAppCsrf } from '../helpers/csrf.js';
import { AUDIT_ACTIONS } from '../../src/config/audit-actions.js';

const ADMIN = 'admin@metrika.by';
const ANALYST = 'analyst@metrika.by';
const VIEWER = 'viewer@metrika.by';
const JUNIOR = 'junior@metrika.by';
const RESET = 'reset@metrika.by';
const JUNIOR_PASSWORD = 'TempPass2026!';
const SEEDED_EMAILS = [ADMIN, ANALYST, VIEWER, JUNIOR];
const SEEDED_ROLES = new Map([
  [ADMIN, 'admin'],
  [ANALYST, 'analyst'],
  [VIEWER, 'viewer'],
]);

/** @type {import('pg').Pool} */
let pool;
/** @type {import('express').Express} */
let app;
/** @type {string} */
let juniorPasswordHash;

beforeAll(async () => {
  await resetTestDatabase();
  await seed();
  pool = getTestPool();
  // The shared fixture exists before any test, so a filtered `vitest -t` run can exercise any case in isolation.
  juniorPasswordHash = await hash(JUNIOR_PASSWORD);
  await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ($1, $2, 'Младший аналитик', 'analyst')`,
    [JUNIOR, juniorPasswordHash],
  );
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  // Every case starts from the seeded roster, an active analyst fixture and an empty journal. Accounts created by a
  // previous case are removed so the next assertion about the roster is not order-dependent.
  await pool.query('DELETE FROM sessions');
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM users WHERE lower(email) <> ALL($1::text[])', [SEEDED_EMAILS]);
  for (const [email, role] of SEEDED_ROLES) {
    await pool.query("UPDATE users SET role = $2, is_active = true WHERE lower(email) = lower($1)", [email, role]);
  }
  await pool.query(
    `UPDATE users
        SET role = 'analyst', is_active = true, password_hash = $2, last_login_at = NULL
      WHERE lower(email) = lower($1)`,
    [JUNIOR, juniorPasswordHash],
  );
  app = makeApp();
});

/**
 * @param {string} email
 * @param {string} [password]
 * @returns {Promise<import('supertest').SuperAgentTest>}
 */
async function signedIn(email, password) {
  const agent = request.agent(app);
  const login = await loginAs(agent, email, password);
  expect(login.status).toBe(302);
  return agent;
}

/**
 * @param {string} email
 * @returns {Promise<{ id: string, role: string, is_active: boolean, password_hash: string } | undefined>}
 */
async function userRow(email) {
  const { rows } = await pool.query(
    'SELECT id::text AS id, role, is_active, password_hash FROM users WHERE lower(email) = lower($1)',
    [email],
  );
  return rows[0];
}

/**
 * @param {string} email
 * @returns {Promise<number>}
 */
async function countByEmail(email) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users WHERE lower(email) = lower($1)', [email]);
  return rows[0].n;
}

/**
 * @param {string} entityId
 * @returns {Promise<string[]>}
 */
async function auditActions(entityId) {
  const { rows } = await pool.query(
    'SELECT action FROM audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY id',
    ['user', entityId],
  );
  return rows.map((row) => row.action);
}

/**
 * Counts live server-side sessions for a user id, so the assertion does not depend on how pg types BIGINT.
 * @param {string} userId
 * @returns {Promise<number>}
 */
async function sessionCount(userId) {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM sessions WHERE (sess->'user'->>'id')::bigint = $1::bigint",
    [userId],
  );
  return rows[0].n;
}

/**
 * Returns the first table body; the audit page renders action codes in filter options, so row assertions must be
 * scoped to `<tbody>`.
 * @param {string} html
 * @returns {string}
 */
function tableBody(html) {
  const start = html.indexOf('<tbody');
  const end = html.indexOf('</tbody>');
  return start === -1 || end === -1 ? '' : html.slice(start, end);
}

/**
 * @param {string} html
 * @returns {string}
 */
function temporaryPassword(html) {
  const match = html.match(/<code class="temp-password">([^<]+)<\/code>/);
  return match?.[1] ?? '';
}

/**
 * Counts data rows in the first table body. Used for the journal pagination check.
 * @param {string} html
 * @returns {number}
 */
function tableRowCount(html) {
  return (tableBody(html).match(/<tr\b/g) ?? []).length;
}

describe('user administration', () => {
  it('creates a user with a hashed temporary password, records the audit entry and lets them sign in', async () => {
    const createdEmail = 'created@metrika.by';
    const admin = await signedIn(ADMIN);
    const csrf = await getAppCsrf(admin);

    const res = await admin.post('/app/admin/users').type('form').send({
      email: createdEmail,
      fullName: 'Новый аналитик',
      role: 'analyst',
      password: JUNIOR_PASSWORD,
      _csrf: csrf,
    });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/admin/users');

    const created = await userRow(createdEmail);
    expect(created).toBeDefined();
    expect(created.role).toBe('analyst');
    expect(created.is_active).toBe(true);
    expect(created.password_hash).toMatch(/^\$argon2id\$/);
    expect(created.password_hash).not.toContain(JUNIOR_PASSWORD);

    const newAgent = request.agent(app);
    const login = await loginAs(newAgent, createdEmail, JUNIOR_PASSWORD);
    expect(login.status).toBe(302);

    const list = await admin.get('/app/admin/users');
    expect(list.status).toBe(200);
    expect(list.text).not.toContain('следующем этапе');
    expect(tableBody(list.text)).toContain(createdEmail);
    expect(await auditActions(created.id)).toContain(AUDIT_ACTIONS.USER_CREATE);
  });

  it('rejects a duplicate e-mail in another case and a password shorter than ten characters', async () => {
    const admin = await signedIn(ADMIN);
    const csrf = await getAppCsrf(admin);

    const duplicate = await admin.post('/app/admin/users').type('form').send({
      email: 'JUNIOR@metrika.by',
      fullName: 'Дубль',
      role: 'viewer',
      password: 'AnotherPass2026!',
      _csrf: csrf,
    });

    expect(duplicate.status).toBe(400);
    expect(duplicate.headers['content-type']).toContain('text/html');
    expect(duplicate.text).toContain('уже существует');
    expect(await countByEmail(JUNIOR)).toBe(1);

    const short = await admin.post('/app/admin/users').type('form').send({
      email: 'short@metrika.by',
      fullName: 'Короткий пароль',
      role: 'viewer',
      password: 'short',
      _csrf: csrf,
    });

    expect(short.status).toBe(400);
    expect(short.headers['content-type']).toContain('text/html');
    expect(short.text).toContain('Пароль');
    expect(await countByEmail('short@metrika.by')).toBe(0);
  });

  it('forbids viewers and analysts, and rejects an admin POST without a CSRF token', async () => {
    for (const email of [VIEWER, ANALYST]) {
      const agent = await signedIn(email);
      const csrf = await getAppCsrf(agent);

      const res = await agent.post('/app/admin/users').type('form').send({
        email: `forbidden-${email}`,
        fullName: 'Запрещённый',
        role: 'viewer',
        password: 'Forbidden2026!',
        _csrf: csrf,
      });

      expect(res.status).toBe(403);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('Недостаточно прав');
    }

    const admin = await signedIn(ADMIN);
    const noCsrf = await admin.post('/app/admin/users').type('form').send({
      email: 'no-csrf@metrika.by',
      fullName: 'Без токена',
      role: 'viewer',
      password: 'NoCsrf2026!',
    });

    expect(noCsrf.status).toBe(403);
    expect(noCsrf.headers['content-type']).toContain('text/plain');
    expect(noCsrf.text).toBe('CSRF token mismatch');
    expect(await countByEmail('no-csrf@metrika.by')).toBe(0);
  });

  it('forbids every user mutation for viewers and analysts with the styled 403 page', async () => {
    const juniorId = (await userRow(JUNIOR)).id;
    for (const email of [VIEWER, ANALYST]) {
      const agent = await signedIn(email);
      const csrf = await getAppCsrf(agent);
      const attempts = [
        [`/app/admin/users/${juniorId}/role`, { role: 'viewer' }],
        [`/app/admin/users/${juniorId}/toggle-active`, {}],
        [`/app/admin/users/${juniorId}/reset-password`, {}],
      ];

      for (const [path, body] of attempts) {
        const res = await agent
          .post(path)
          .type('form')
          .send({ ...body, _csrf: csrf });

        expect(res.status).toBe(403);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.text).toContain('Недостаточно прав');
      }
    }

    const junior = await userRow(JUNIOR);
    expect(junior.role).toBe('analyst');
    expect(junior.is_active).toBe(true);
  });

  it('answers oversized and non-numeric user ids with the designed 404 page', async () => {
    const admin = await signedIn(ADMIN);
    const csrf = await getAppCsrf(admin);
    const suffixes = ['role', 'toggle-active', 'reset-password'];

    for (const id of ['abc', '0', '9223372036854775808']) {
      for (const suffix of suffixes) {
        const res = await admin
          .post(`/app/admin/users/${id}/${suffix}`)
          .type('form')
          .send({ role: 'viewer', _csrf: csrf });

        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.text).toContain('Страница не найдена');
      }
    }
  });

  it('revokes sessions on a role change and reads the new role from the database after re-login', async () => {
    const admin = await signedIn(ADMIN);
    const csrf = await getAppCsrf(admin);
    const juniorId = (await userRow(JUNIOR)).id;

    const promote = await admin
      .post(`/app/admin/users/${juniorId}/role`)
      .type('form')
      .send({ role: 'admin', _csrf: csrf });
    expect(promote.status).toBe(302);

    const juniorAdmin = await signedIn(JUNIOR, JUNIOR_PASSWORD);
    expect((await juniorAdmin.get('/app/admin/users')).status).toBe(200);

    const demote = await admin
      .post(`/app/admin/users/${juniorId}/role`)
      .type('form')
      .send({ role: 'viewer', _csrf: csrf });
    expect(demote.status).toBe(302);
    expect((await userRow(JUNIOR)).role).toBe('viewer');
    expect(await sessionCount(juniorId)).toBe(0);

    const stale = await juniorAdmin.get('/app/admin/users');
    expect(stale.status).toBe(302);
    expect(stale.headers.location).toMatch(/^\/login/);

    const juniorViewer = await signedIn(JUNIOR, JUNIOR_PASSWORD);
    const forbidden = await juniorViewer.get('/app/admin/users');
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers['content-type']).toContain('text/html');
    expect(forbidden.text).toContain('Недостаточно прав');
    expect((await juniorViewer.get('/app/dashboard')).status).toBe(200);
    expect(await auditActions(juniorId)).toContain(AUDIT_ACTIONS.USER_ROLE_CHANGE);
  });

  it('refuses to deactivate the acting administrator', async () => {
    const admin = await signedIn(ADMIN);
    const csrf = await getAppCsrf(admin);
    const adminId = (await userRow(ADMIN)).id;

    const res = await admin.post(`/app/admin/users/${adminId}/toggle-active`).type('form').send({ _csrf: csrf });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Нельзя заблокировать собственную учётную запись');
    expect((await userRow(ADMIN)).is_active).toBe(true);
  });

  it('refuses to remove the administrator role from the acting administrator', async () => {
    const admin = await signedIn(ADMIN);
    const csrf = await getAppCsrf(admin);
    const adminId = (await userRow(ADMIN)).id;

    const res = await admin
      .post(`/app/admin/users/${adminId}/role`)
      .type('form')
      .send({ role: 'viewer', _csrf: csrf });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('снять с себя роль администратора');
    expect((await userRow(ADMIN)).role).toBe('admin');
  });

  it('keeps at least one active administrator when another admin tries to demote the last one', async () => {
    const admin = await signedIn(ADMIN);
    const csrf = await getAppCsrf(admin);
    const adminId = (await userRow(ADMIN)).id;
    const juniorId = (await userRow(JUNIOR)).id;

    const promote = await admin
      .post(`/app/admin/users/${juniorId}/role`)
      .type('form')
      .send({ role: 'admin', _csrf: csrf });
    expect(promote.status).toBe(302);

    // Simulate a stale privileged session: the actor is no longer an active admin in the database, so the only active
    // admin is the target. The service-level guard must refuse to demote the last one.
    await pool.query('UPDATE users SET is_active = false WHERE id = $1::bigint', [adminId]);
    try {
      const res = await admin
        .post(`/app/admin/users/${juniorId}/role`)
        .type('form')
        .send({ role: 'viewer', _csrf: csrf });

      expect(res.status).toBe(400);
      expect(res.text).toContain('без активного администратора');
      expect((await userRow(JUNIOR)).role).toBe('admin');
    } finally {
      await pool.query('UPDATE users SET is_active = true WHERE id = $1::bigint', [adminId]);
    }

    const demote = await admin
      .post(`/app/admin/users/${juniorId}/role`)
      .type('form')
      .send({ role: 'viewer', _csrf: csrf });
    expect(demote.status).toBe(302);
  });

  it('refuses to deactivate the last active administrator', async () => {
    const admin = await signedIn(ADMIN);
    const csrf = await getAppCsrf(admin);
    const adminId = (await userRow(ADMIN)).id;
    const juniorId = (await userRow(JUNIOR)).id;

    const promote = await admin
      .post(`/app/admin/users/${juniorId}/role`)
      .type('form')
      .send({ role: 'admin', _csrf: csrf });
    expect(promote.status).toBe(302);

    await pool.query('UPDATE users SET is_active = false WHERE id = $1::bigint', [adminId]);
    try {
      const res = await admin
        .post(`/app/admin/users/${juniorId}/toggle-active`)
        .type('form')
        .send({ _csrf: csrf });

      expect(res.status).toBe(400);
      expect(res.text).toContain('без активного администратора');
      expect((await userRow(JUNIOR)).is_active).toBe(true);
    } finally {
      await pool.query('UPDATE users SET is_active = true WHERE id = $1::bigint', [adminId]);
    }

    const demote = await admin
      .post(`/app/admin/users/${juniorId}/role`)
      .type('form')
      .send({ role: 'viewer', _csrf: csrf });
    expect(demote.status).toBe(302);
  });

  it('normalises zero-padded ids before applying the last-admin guard', async () => {
    const admin = await signedIn(ADMIN);
    const csrf = await getAppCsrf(admin);
    const adminId = (await userRow(ADMIN)).id;
    const juniorId = (await userRow(JUNIOR)).id;
    const paddedId = juniorId.padStart(juniorId.length + 2, '0');

    const promote = await admin
      .post(`/app/admin/users/${juniorId}/role`)
      .type('form')
      .send({ role: 'admin', _csrf: csrf });
    expect(promote.status).toBe(302);

    // The actor keeps an admin session, but the database knows only the target as an active admin. Both paths must
    // resolve `007` to the same row id (`7`) and refuse to remove the last administrator.
    await pool.query('UPDATE users SET is_active = false WHERE id = $1::bigint', [adminId]);
    try {
      const demote = await admin
        .post(`/app/admin/users/${paddedId}/role`)
        .type('form')
        .send({ role: 'viewer', _csrf: csrf });
      expect(demote.status).toBe(400);
      expect(demote.text).toContain('без активного администратора');

      const deactivate = await admin
        .post(`/app/admin/users/${paddedId}/toggle-active`)
        .type('form')
        .send({ _csrf: csrf });
      expect(deactivate.status).toBe(400);
      expect(deactivate.text).toContain('без активного администратора');

      const junior = await userRow(JUNIOR);
      expect(junior.role).toBe('admin');
      expect(junior.is_active).toBe(true);
    } finally {
      await pool.query('UPDATE users SET is_active = true WHERE id = $1::bigint', [adminId]);
    }
  });

  it('deactivates a user, revokes the live session and blocks the login until reactivation', async () => {
    const juniorId = (await userRow(JUNIOR)).id;
    const junior = await signedIn(JUNIOR, JUNIOR_PASSWORD);
    expect((await junior.get('/app/dashboard')).status).toBe(200);

    const admin = await signedIn(ADMIN);
    const csrf = await getAppCsrf(admin);
    const deactivate = await admin
      .post(`/app/admin/users/${juniorId}/toggle-active`)
      .type('form')
      .send({ _csrf: csrf });

    expect(deactivate.status).toBe(302);
    expect((await userRow(JUNIOR)).is_active).toBe(false);
    expect(await sessionCount(juniorId)).toBe(0);

    const stale = await junior.get('/app/dashboard');
    expect(stale.status).toBe(302);
    expect(stale.headers.location).toMatch(/^\/login/);

    const blockedLogin = await loginAs(request.agent(app), JUNIOR, JUNIOR_PASSWORD);
    expect(blockedLogin.status).toBe(401);

    const reactivate = await admin
      .post(`/app/admin/users/${juniorId}/toggle-active`)
      .type('form')
      .send({ _csrf: csrf });
    expect(reactivate.status).toBe(302);
    expect((await userRow(JUNIOR)).is_active).toBe(true);
    expect(await auditActions(juniorId)).toContain(AUDIT_ACTIONS.USER_DEACTIVATE);
  });

  it('resets a password through POST/Redirect/GET, shows it once and never writes the secret to the audit payload', async () => {
    const admin = await signedIn(ADMIN);
    const csrf = await getAppCsrf(admin);
    const oldPassword = 'OldPass2026!';

    const created = await admin.post('/app/admin/users').type('form').send({
      email: RESET,
      fullName: 'Сброс пароля',
      role: 'analyst',
      password: oldPassword,
      _csrf: csrf,
    });
    expect(created.status).toBe(302);

    const target = await userRow(RESET);
    const targetAgent = await signedIn(RESET, oldPassword);
    expect((await targetAgent.get('/app/dashboard')).status).toBe(200);

    const reset = await admin.post(`/app/admin/users/${target.id}/reset-password`).type('form').send({ _csrf: csrf });

    expect(reset.status).toBe(302);
    expect(reset.headers.location).toBe('/app/admin/users');
    expect(await sessionCount(target.id)).toBe(0);

    // The next GET consumes the flash: the password and the target e-mail are visible exactly once.
    const confirmation = await admin.get('/app/admin/users');
    expect(confirmation.status).toBe(200);
    const newPassword = temporaryPassword(confirmation.text);
    expect(newPassword.length).toBeGreaterThanOrEqual(10);
    expect(newPassword).not.toBe(oldPassword);
    expect(confirmation.text).toContain(RESET);

    const again = await admin.get('/app/admin/users');
    expect(again.status).toBe(200);
    expect(temporaryPassword(again.text)).toBe('');
    expect(again.text).not.toContain(newPassword);

    const updated = await userRow(RESET);
    expect(updated.password_hash).toMatch(/^\$argon2id\$/);
    expect(updated.password_hash).not.toContain(newPassword);

    expect((await targetAgent.get('/app/dashboard')).status).toBe(302);
    expect((await loginAs(request.agent(app), RESET, oldPassword)).status).toBe(401);
    expect((await loginAs(request.agent(app), RESET, newPassword)).status).toBe(302);

    const { rows } = await pool.query("SELECT payload FROM audit_log WHERE entity = 'user' AND entity_id = $1", [
      target.id,
    ]);
    const payloads = JSON.stringify(rows.map((row) => row.payload));
    expect(payloads).not.toContain(oldPassword);
    expect(payloads).not.toContain(newPassword);
    expect(payloads).not.toContain('argon2');
    expect(await auditActions(target.id)).toContain(AUDIT_ACTIONS.USER_PASSWORD_RESET);
  });
});

describe('audit journal and profile', () => {
  it('lists user actions for an admin, filters them and keeps the section closed to other roles', async () => {
    const admin = await signedIn(ADMIN);
    const adminId = (await userRow(ADMIN)).id;
    const juniorId = (await userRow(JUNIOR)).id;

    // The journal is populated here, so the case does not depend on the administration cases above.
    for (const action of [
      AUDIT_ACTIONS.USER_CREATE,
      AUDIT_ACTIONS.USER_ROLE_CHANGE,
      AUDIT_ACTIONS.USER_DEACTIVATE,
      AUDIT_ACTIONS.USER_PASSWORD_RESET,
    ]) {
      await pool.query(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, payload)
         VALUES ($1::bigint, $2, 'user', $3, '{}'::jsonb)`,
        [adminId, action, juniorId],
      );
    }

    const all = await admin.get('/app/audit?entity=user');
    expect(all.status).toBe(200);
    expect(all.headers['content-type']).toContain('text/html');
    expect(all.text).not.toContain('следующем этапе');
    const userRows = tableBody(all.text);
    for (const action of [
      AUDIT_ACTIONS.USER_CREATE,
      AUDIT_ACTIONS.USER_ROLE_CHANGE,
      AUDIT_ACTIONS.USER_DEACTIVATE,
      AUDIT_ACTIONS.USER_PASSWORD_RESET,
    ]) {
      expect(userRows).toContain(action);
    }

    const passwordResetOnly = await admin.get('/app/audit?action=user.password_reset');
    expect(passwordResetOnly.status).toBe(200);
    const filtered = tableBody(passwordResetOnly.text);
    expect(filtered).toContain(AUDIT_ACTIONS.USER_PASSWORD_RESET);
    expect(filtered).not.toContain(AUDIT_ACTIONS.USER_ROLE_CHANGE);

    const byActor = await admin.get(`/app/audit?userId=${adminId}`);
    expect(byActor.status).toBe(200);
    expect(tableBody(byActor.text)).toContain(ADMIN);

    for (const email of [ANALYST, VIEWER]) {
      const agent = await signedIn(email);
      const res = await agent.get('/app/audit');
      expect(res.status).toBe(403);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('Недостаточно прав');
    }
  });

  it('renders the profile for every role instead of the placeholder', async () => {
    const viewer = await signedIn(VIEWER);

    const res = await viewer.get('/app/profile');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).not.toContain('следующем этапе');
    expect(res.text).toContain('Смена пароля');
    expect(res.text).toContain(VIEWER);
  });

  it('paginates the journal at fifty rows and keeps filters in the pager', async () => {
    const admin = await signedIn(ADMIN);
    const adminId = (await userRow(ADMIN)).id;
    await pool.query(
      `INSERT INTO audit_log (user_id, action, entity, payload)
       SELECT $1::bigint, $2, 'channel', '{}'::jsonb
         FROM generate_series(1, 55)`,
      [adminId, AUDIT_ACTIONS.CHANNEL_UPDATE],
    );

    const first = await admin.get('/app/audit?entity=channel');
    expect(first.status).toBe(200);
    expect(tableRowCount(first.text)).toBe(50);
    expect(first.text).toContain('Страница 1 из 2');
    expect(first.text).toContain('page=2');

    const second = await admin.get('/app/audit?entity=channel&page=2');
    expect(second.status).toBe(200);
    expect(tableRowCount(second.text)).toBe(5);
    expect(second.text).toContain('page=1');

    // A page past the end is clamped instead of rendering an empty table with a wrong range.
    const beyond = await admin.get('/app/audit?entity=channel&page=99');
    expect(beyond.status).toBe(200);
    expect(tableRowCount(beyond.text)).toBe(5);
    expect(beyond.text).toContain('Страница 2 из 2');
  });

  it('rejects a wrong current password and changes the own password after verifying it', async () => {
    const junior = await signedIn(JUNIOR, JUNIOR_PASSWORD);
    const otherSession = await signedIn(JUNIOR, JUNIOR_PASSWORD);
    const csrf = await getAppCsrf(junior, '/app/profile');
    const juniorId = (await userRow(JUNIOR)).id;
    expect(await sessionCount(juniorId)).toBe(2);

    const wrong = await junior.post('/app/profile/password').type('form').send({
      currentPassword: 'definitely-wrong',
      newPassword: 'JuniorNewPass2026!',
      _csrf: csrf,
    });

    expect(wrong.status).toBe(400);
    expect(wrong.headers['content-type']).toContain('text/html');
    expect(wrong.text).toContain('Текущий пароль указан неверно');
    expect((await loginAs(request.agent(app), JUNIOR, JUNIOR_PASSWORD)).status).toBe(302);

    const changed = await junior.post('/app/profile/password').type('form').send({
      currentPassword: JUNIOR_PASSWORD,
      newPassword: 'JuniorNewPass2026!',
      _csrf: csrf,
    });

    expect(changed.status).toBe(302);
    expect(changed.headers.location).toBe('/app/profile');

    // The browser that changed the password stays signed in; every other session is revoked.
    expect(await sessionCount(juniorId)).toBe(1);
    expect((await junior.get('/app/dashboard')).status).toBe(200);
    const otherStale = await otherSession.get('/app/dashboard');
    expect(otherStale.status).toBe(302);
    expect(otherStale.headers.location).toMatch(/^\/login/);

    expect((await loginAs(request.agent(app), JUNIOR, JUNIOR_PASSWORD)).status).toBe(401);
    expect((await loginAs(request.agent(app), JUNIOR, 'JuniorNewPass2026!')).status).toBe(302);
    expect(await auditActions(juniorId)).toContain(AUDIT_ACTIONS.USER_PASSWORD_CHANGE);
  });
});
