import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
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

/** @type {import('pg').Pool} */
let pool;
/** @type {import('express').Express} */
let app;

beforeAll(async () => {
  await resetTestDatabase();
  await seed();
  pool = getTestPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  // Sessions are per-test fixtures; the user rows intentionally survive because the cases build on a created account.
  await pool.query('DELETE FROM sessions');
  app = makeApp();
});

/**
 * @param {string} email
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
 * Counts live server-side sessions for a user id as strings, so the assertion does not depend on how pg types BIGINT.
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
    const admin = await signedIn(ADMIN);
    const csrf = await getAppCsrf(admin);

    const res = await admin.post('/app/admin/users').type('form').send({
      email: JUNIOR,
      fullName: 'Младший аналитик',
      role: 'analyst',
      password: JUNIOR_PASSWORD,
      _csrf: csrf,
    });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/admin/users');

    const created = await userRow(JUNIOR);
    expect(created).toBeDefined();
    expect(created.role).toBe('analyst');
    expect(created.is_active).toBe(true);
    expect(created.password_hash).toMatch(/^\$argon2id\$/);
    expect(created.password_hash).not.toContain(JUNIOR_PASSWORD);

    const junior = request.agent(app);
    const login = await loginAs(junior, JUNIOR, JUNIOR_PASSWORD);
    expect(login.status).toBe(302);

    const list = await admin.get('/app/admin/users');
    expect(list.status).toBe(200);
    expect(list.text).not.toContain('следующем этапе');
    expect(tableBody(list.text)).toContain(JUNIOR);
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
    // admin is the target. The guard must refuse to demote the last one even though the request itself is authorised.
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

  it('resets a password once, revokes sessions and never writes the secret to the audit payload', async () => {
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

    expect(reset.status).toBe(200);
    expect(reset.headers['content-type']).toContain('text/html');
    const newPassword = temporaryPassword(reset.text);
    expect(newPassword.length).toBeGreaterThanOrEqual(10);
    expect(newPassword).not.toBe(oldPassword);
    expect(await sessionCount(target.id)).toBe(0);

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

    const adminId = (await userRow(ADMIN)).id;
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
    const csrf = await getAppCsrf(junior, '/app/profile');
    const juniorId = (await userRow(JUNIOR)).id;

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
    expect((await loginAs(request.agent(app), JUNIOR, JUNIOR_PASSWORD)).status).toBe(401);
    expect((await loginAs(request.agent(app), JUNIOR, 'JuniorNewPass2026!')).status).toBe(302);
    expect(await auditActions(juniorId)).toContain(AUDIT_ACTIONS.USER_PASSWORD_CHANGE);
  });
});
