import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
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
