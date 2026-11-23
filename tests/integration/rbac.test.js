import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
import { getAppCsrf } from '../helpers/csrf.js';
import { extractDataProps } from '../helpers/dataProps.js';
import { formatDateRu, minskToday } from '../../src/lib/dates.js';

const ADMIN = 'admin@metrika.by';
const ANALYST = 'analyst@metrika.by';
const VIEWER = 'viewer@metrika.by';

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
  // Sessions are per-test fixtures: a leftover cookie would make the next test depend on test order.
  await pool.query('DELETE FROM sessions');
  app = makeApp();
});

/**
 * Logs an agent in through the real form and asserts the redirect, so a broken login fails here instead of as a
 * confusing 403 in the RBAC assertion.
 * @param {string} email
 * @returns {Promise<import('supertest').SuperAgentTest>}
 */
async function signedIn(email) {
  const agent = request.agent(app);
  const login = await loginAs(agent, email);
  expect(login.status).toBe(302);
  return agent;
}

/**
 * Returns the `<tbody>` slice of a rendered table; used to count data rows without depending on how many times a
 * user name repeats elsewhere on the page.
 * @param {string} html
 * @returns {string}
 */
function tableBody(html) {
  const start = html.indexOf('<tbody');
  const end = html.indexOf('</tbody>');
  return start === -1 || end === -1 ? '' : html.slice(start, end);
}

describe('app shell RBAC', () => {
  it('sends an anonymous dashboard request to the login form with a next target', async () => {
    const res = await request(app).get('/app/dashboard');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login?next=%2Fapp%2Fdashboard');
  });

  it('renders the shell for a viewer without the admin section', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/dashboard');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Данные по');
    expect(res.text).not.toContain('/app/admin/users');
  });

  it('answers a viewer on the users screen with the styled 403 page', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/admin/users');

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Недостаточно прав');
  });

  it('lets an analyst open the import screen but not the users screen', async () => {
    const agent = await signedIn(ANALYST);

    const users = await agent.get('/app/admin/users');
    expect(users.status).toBe(403);

    const importPage = await agent.get('/app/import');
    expect(importPage.status).toBe(200);
    expect(importPage.text).toContain('Импорт CSV');
    // The M1 placeholder wording must be gone now that the screen ships.
    expect(importPage.text).not.toContain('следующем этапе');
  });

  it('answers a viewer on the import screen with the styled 403 page', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/import');

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Недостаточно прав');
  });

  it('lists the three seeded users for an admin', async () => {
    const agent = await signedIn(ADMIN);

    const res = await agent.get('/app/admin/users');

    expect(res.status).toBe(200);
    const rows = tableBody(res.text);
    expect((rows.match(/<tr/g) ?? []).length).toBe(3);
    for (const email of [ADMIN, ANALYST, VIEWER]) {
      expect(rows).toContain(email);
    }
    expect(rows).toContain('Администратор');
    expect(rows).toContain('Аналитик');
    expect(rows).toContain('Наблюдатель');
    // The M1 placeholder wording must be gone now that the screen manages accounts.
    expect(res.text).not.toContain('следующем этапе');
  });

  it('serves the audit journal and the profile instead of the old placeholders', async () => {
    const admin = await signedIn(ADMIN);
    const audit = await admin.get('/app/audit');

    expect(audit.status).toBe(200);
    expect(audit.text).toContain('Журнал действий');
    expect(audit.text).not.toContain('следующем этапе');

    const viewer = await signedIn(VIEWER);
    const profile = await viewer.get('/app/profile');

    expect(profile.status).toBe(200);
    expect(profile.text).toContain('Смена пароля');
    expect(profile.text).not.toContain('следующем этапе');
  });

  it('shows the data anchor taken from the latest daily stats date', async () => {
    const { rows } = await pool.query('SELECT max(stat_date)::text AS anchor FROM daily_stats');
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/dashboard');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Данные по');
    expect(res.text).toContain(formatDateRu(rows[0].anchor));
  });

  it('falls back to Minsk today and an honest empty state when the data tables are empty', async () => {
    // Users are kept on purpose: the dashboard still has to render for a signed-in person on an empty stand.
    await pool.query('TRUNCATE daily_stats, touchpoints, orders, customers RESTART IDENTITY CASCADE');
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/dashboard');

    expect(res.status).toBe(200);
    expect(res.text).toContain(`Данные по ${formatDateRu(minskToday())}`);
    // The island model carries the empty dashboard: spend and customers are measured zeros, CAC and ROMI are dashes.
    const props = extractDataProps(res.text);
    expect(props.kpis.spendLabel).toBe('0,00');
    expect(props.kpis.newCustomersLabel).toBe('0');
    expect(props.kpis.cacLabel).toBe('—');
    expect(props.kpis.romiLabel).toBe('—');
    expect(props.verdict.status).toBe('no_data');
    expect(res.text).not.toContain('NaN');
  });

  it('answers an unknown app URL with the HTML 404 page', async () => {
    const res = await request(app).get('/app/unknown');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Страница не найдена');
  });
});

describe('decisions RBAC, CSRF and audit', () => {
  beforeEach(async () => {
    // The empty-stand test above truncates the fact tables; decisions need the seeded history for their windows.
    await resetTestDatabase();
    await seed();
    await pool.query('TRUNCATE alerts, scenarios, audit_log RESTART IDENTITY');
    app = makeApp({ assets: { assets: () => ({ scripts: [], preloads: [] }) } });
  });

  it('opens the alerts and scenarios screens for a viewer without management controls', async () => {
    const agent = await signedIn(VIEWER);

    const alerts = await agent.get('/app/alerts');
    const scenarios = await agent.get('/app/scenarios');

    expect(alerts.status).toBe(200);
    expect(alerts.text).toContain('Алерты');
    expect(alerts.text).not.toContain('action="/app/alerts/recalculate"');
    expect(alerts.text).not.toContain('/dismiss');

    expect(scenarios.status).toBe(200);
    expect(scenarios.text).toContain('Сценарии');
    expect(scenarios.text).not.toContain('method="post" action="/app/scenarios"');
    expect(scenarios.text).not.toContain('Сохранить сценарий');
  });

  it('rejects every viewer mutation with the styled 403 page, even without visible buttons', async () => {
    const agent = await signedIn(VIEWER);
    const csrf = await getAppCsrf(agent, '/app/dashboard');

    const recalculate = await agent
      .post('/app/alerts/recalculate')
      .type('form')
      .send({ _csrf: csrf });
    expect(recalculate.status).toBe(403);
    expect(recalculate.headers['content-type']).toMatch(/text\/html/);
    expect(recalculate.text).toContain('Недостаточно прав');

    const dismiss = await agent
      .post('/app/alerts/1/dismiss')
      .type('form')
      .send({ _csrf: csrf, reason: 'Не моё' });
    expect(dismiss.status).toBe(403);
    expect(dismiss.text).toContain('Недостаточно прав');

    const save = await agent
      .post('/app/scenarios')
      .type('form')
      .send({ _csrf: csrf, name: 'Чужой сценарий' });
    expect(save.status).toBe(403);
    expect(save.text).toContain('Недостаточно прав');

    // Nothing reached the database. The login itself writes `auth.login`; no decision entity may be touched.
    const scenarios = await pool.query('SELECT count(*)::int AS total FROM scenarios');
    expect(scenarios.rows[0].total).toBe(0);
    const audit = await pool.query(
      "SELECT count(*)::int AS total FROM audit_log WHERE entity IN ('alert', 'scenario')",
    );
    expect(audit.rows[0].total).toBe(0);
  });

  it('rejects every viewer API mutation with the JSON 403 contract after successful reads', async () => {
    const agent = await signedIn(VIEWER);
    const csrf = await getAppCsrf(agent, '/app/dashboard');

    expect((await agent.get('/api/v1/alerts')).status).toBe(200);
    expect((await agent.get('/api/v1/scenarios')).status).toBe(200);

    for (const [path, body] of [
      ['/api/v1/alerts/recalculate', {}],
      ['/api/v1/alerts/1/dismiss', { reason: 'Не моё' }],
      ['/api/v1/scenarios', { name: 'Чужой API сценарий' }],
    ]) {
      const res = await agent.post(path).set('X-CSRF-Token', csrf).send(body);

      expect(res.status, path).toBe(403);
      expect(res.type, path).toMatch(/application\/json/);
      expect(res.body.error.code, path).toBe('FORBIDDEN');
    }

    const scenarios = await pool.query('SELECT count(*)::int AS total FROM scenarios');
    expect(scenarios.rows[0].total).toBe(0);
  });

  it.each([
    ['analyst', ANALYST],
    ['admin', ADMIN],
  ])('lets an %s use every API mutation with a valid token', async (_role, email) => {
    const agent = await signedIn(email);
    await agent.get('/app/alerts');
    const csrf = await getAppCsrf(agent, '/app/alerts');
    const { rows } = await pool.query(
      "SELECT id::text AS id FROM alerts WHERE status = 'active' ORDER BY id LIMIT 1",
    );
    expect(rows).toHaveLength(1);

    const recalculate = await agent
      .post('/api/v1/alerts/recalculate')
      .set('X-CSRF-Token', csrf);
    expect(recalculate.status).toBe(200);
    expect(recalculate.type).toMatch(/application\/json/);

    const dismiss = await agent
      .post(`/api/v1/alerts/${rows[0].id}/dismiss`)
      .set('X-CSRF-Token', csrf)
      .send({ reason: 'API проверка' });
    expect(dismiss.status).toBe(200);
    expect(dismiss.body.alert).toMatchObject({ id: rows[0].id, status: 'dismissed' });

    const save = await agent
      .post('/api/v1/scenarios')
      .set('X-CSRF-Token', csrf)
      .send({ name: `Сценарий ${email}` });
    expect(save.status).toBe(201);
    expect(save.body.mode).toBe('detail');
  });

  it('rejects an analyst mutation without a CSRF token', async () => {
    const agent = await signedIn(ANALYST);

    const recalculate = await agent.post('/app/alerts/recalculate').type('form').send({});
    expect(recalculate.status).toBe(403);

    const save = await agent.post('/app/scenarios').type('form').send({ name: 'Без токена' });
    expect(save.status).toBe(403);

    const api = await agent.post('/api/v1/scenarios').send({ name: 'Без токена' });
    expect(api.status).toBe(403);
    expect(api.body.error.code).toBe('FORBIDDEN');
  });

  it('accepts an analyst mutation with the session token on both paths', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent, '/app/alerts');

    const recalculate = await agent
      .post('/app/alerts/recalculate')
      .type('form')
      .send({ _csrf: csrf });
    expect(recalculate.status).toBe(302);
    expect(recalculate.headers.location).toContain('/app/alerts');

    const apiRecalculate = await agent
      .post('/api/v1/alerts/recalculate')
      .set('X-CSRF-Token', csrf);
    expect(apiRecalculate.status).toBe(200);
    expect(apiRecalculate.type).toMatch(/application\/json/);

    const save = await agent
      .post('/app/scenarios')
      .type('form')
      .send({ _csrf: csrf, name: 'Сценарий аналитика' });
    expect(save.status).toBe(302);
    expect(save.headers.location).toMatch(/^\/app\/scenarios\/\d+$/);

    const apiSave = await agent
      .post('/api/v1/scenarios')
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Сценарий через API' });
    expect(apiSave.status).toBe(201);
  });

  it('writes exactly one audit row for a dismissal and rejects the duplicate with 400', async () => {
    const agent = await signedIn(ANALYST);
    await agent.get('/app/alerts');
    const csrf = await getAppCsrf(agent, '/app/alerts');
    const { rows } = await pool.query("SELECT id::text AS id FROM alerts WHERE status = 'active' ORDER BY id LIMIT 1");
    const id = rows[0].id;

    const first = await agent
      .post(`/app/alerts/${id}/dismiss`)
      .type('form')
      .send({ _csrf: csrf, reason: 'Подорожало' });
    expect(first.status).toBe(302);

    const audit = await pool.query(
      'SELECT action, entity, entity_id, payload FROM audit_log WHERE entity = $1 AND entity_id = $2',
      ['alert', id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe('alert.dismiss');
    expect(audit.rows[0].payload.reason).toBe('Подорожало');

    const status = await pool.query('SELECT status FROM alerts WHERE id = $1::bigint', [id]);
    expect(status.rows[0].status).toBe('dismissed');

    const second = await agent
      .post(`/app/alerts/${id}/dismiss`)
      .type('form')
      .send({ _csrf: csrf, reason: 'Ещё раз' });
    expect(second.status).toBe(400);

    const auditAfter = await pool.query(
      'SELECT count(*)::int AS total FROM audit_log WHERE entity = $1 AND entity_id = $2',
      ['alert', id],
    );
    expect(auditAfter.rows[0].total).toBe(1);
  });
});
