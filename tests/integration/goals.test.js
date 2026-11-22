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
  // A leftover session cookie would make the next test depend on test order. Goal rows are shared across the file:
  // each test uses a different channel/metric/period combination so the overlap rule itself stays meaningful.
  await pool.query('DELETE FROM sessions');
  app = makeApp();
});

/**
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
 * @param {string} code Channel code fixed in the seed.
 * @returns {Promise<string>} Channel id as a digit string.
 */
async function channelId(code) {
  const { rows } = await pool.query('SELECT id::text AS id FROM channels WHERE code = $1', [code]);
  return rows[0].id;
}

/**
 * @param {{ metric: string, channelId?: string | null, periodStart: string }} goal
 * @returns {Promise<Record<string, string> | undefined>}
 */
async function goalRow({ metric, channelId: scopedChannelId = null, periodStart }) {
  const { rows } = await pool.query(
    `SELECT id::text AS id, metric, channel_id::text AS channel_id, target_value::text AS target_value,
            period_start::text AS period_start, period_end::text AS period_end
       FROM goals
      WHERE metric = $1
        AND channel_id IS NOT DISTINCT FROM $2::bigint
        AND period_start = $3::date`,
    [metric, scopedChannelId, periodStart],
  );
  return rows[0];
}

/**
 * @param {string} entityId
 * @returns {Promise<string[]>} Audit actions recorded for the goal, oldest first.
 */
async function auditActions(entityId) {
  const { rows } = await pool.query(
    'SELECT action FROM audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY id',
    ['goal', entityId],
  );
  return rows.map((row) => row.action);
}

/**
 * @param {Record<string, string | null | undefined>} overrides
 * @returns {Record<string, string>}
 */
function createPayload(overrides) {
  return {
    metric: 'cac',
    channelId: '',
    targetValue: '42,50',
    periodStart: '2026-12-01',
    periodEnd: '2026-12-31',
    _csrf: '',
    ...overrides,
  };
}

/**
 * Counts the data rows of the first table on a page.
 * @param {string} html
 * @returns {number}
 */
function tableRowCount(html) {
  const start = html.indexOf('<tbody');
  const end = html.indexOf('</tbody>');
  const body = start === -1 || end === -1 ? '' : html.slice(start, end);
  return (body.match(/<tr\b/g) ?? []).length;
}

describe('goals list', () => {
  it('shows seeded global goals with their units and replaces the placeholder', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/goals');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(tableRowCount(res.text)).toBe(4);
    // Every metric carries its documented unit next to the planned value.
    expect(res.text).toContain('50,00');
    expect(res.text).toContain('<span class="byn">BYN</span>');
    expect(res.text).toContain('120,0%');
    expect(res.text).toContain('3,00');
    expect(res.text).toContain('12 мес.');
    expect(res.text).toContain('Вся компания');
    expect(res.text).toContain('Активна');
    expect(res.text).not.toContain('следующем этапе');
    // A viewer reads the list but gets no mutation form.
    expect(res.text).not.toContain('name="targetValue"');
  });
});

describe('goal mutations', () => {
  it('creates a channel-scoped goal with kopeck precision and audits it', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const instagram = await channelId('instagram');

    const res = await agent.post('/app/goals').type('form').send(
      createPayload({
        channelId: instagram,
        targetValue: '42,50',
        _csrf: csrf,
      }),
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/goals');

    const created = await goalRow({ metric: 'cac', channelId: instagram, periodStart: '2026-12-01' });
    expect(created).toBeDefined();
    expect(created.channel_id).toBe(instagram);
    expect(created.target_value).toBe('42.50');
    expect(await auditActions(created.id)).toContain(AUDIT_ACTIONS.GOAL_CREATE);
  });

  it('rejects an overlapping period for the same metric and channel without inserting a row', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const google = await channelId('google');

    const base = await agent.post('/app/goals').type('form').send(
      createPayload({
        channelId: google,
        targetValue: '45,00',
        periodStart: '2026-12-01',
        periodEnd: '2026-12-31',
        _csrf: csrf,
      }),
    );
    expect(base.status).toBe(302);

    const overlap = await agent.post('/app/goals').type('form').send(
      createPayload({
        channelId: google,
        targetValue: '44,00',
        periodStart: '2026-12-15',
        periodEnd: '2027-01-15',
        _csrf: csrf,
      }),
    );

    expect(overlap.status).toBe(400);
    expect(overlap.headers['content-type']).toContain('text/html');
    expect(overlap.text).toContain('пересекающийся период');
    expect(await goalRow({ metric: 'cac', channelId: google, periodStart: '2026-12-15' })).toBeUndefined();
    // The rejected submit keeps the entered values on the form.
    expect(overlap.text).toContain('value="44,00"');
  });

  it('allows the same period for a different metric or a different channel', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const google = await channelId('google');
    const yandex = await channelId('yandex');

    const otherMetric = await agent.post('/app/goals').type('form').send(
      createPayload({
        metric: 'romi',
        channelId: google,
        targetValue: '130',
        periodStart: '2026-12-01',
        periodEnd: '2026-12-31',
        _csrf: csrf,
      }),
    );
    expect(otherMetric.status).toBe(302);
    expect(await goalRow({ metric: 'romi', channelId: google, periodStart: '2026-12-01' })).toBeDefined();

    const otherChannel = await agent.post('/app/goals').type('form').send(
      createPayload({
        channelId: yandex,
        targetValue: '46,00',
        periodStart: '2026-12-01',
        periodEnd: '2026-12-31',
        _csrf: csrf,
      }),
    );
    expect(otherChannel.status).toBe(302);
    expect(await goalRow({ metric: 'cac', channelId: yandex, periodStart: '2026-12-01' })).toBeDefined();
  });

  it('accepts a non-overlapping period after an existing goal', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const instagram = await channelId('instagram');

    const res = await agent.post('/app/goals').type('form').send(
      createPayload({
        channelId: instagram,
        targetValue: '40,00',
        periodStart: '2027-01-01',
        periodEnd: '2027-01-31',
        _csrf: csrf,
      }),
    );

    expect(res.status).toBe(302);
    expect(await goalRow({ metric: 'cac', channelId: instagram, periodStart: '2027-01-01' })).toBeDefined();
  });

  it('rejects an inverted period, a negative amount, a fractional customer count and an unknown metric', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const instagram = await channelId('instagram');

    const inverted = await agent.post('/app/goals').type('form').send(
      createPayload({
        metric: 'romi',
        channelId: instagram,
        targetValue: '120',
        periodStart: '2027-02-10',
        periodEnd: '2027-02-01',
        _csrf: csrf,
      }),
    );
    expect(inverted.status).toBe(400);
    expect(inverted.text).toContain('Дата окончания не может быть раньше даты старта');
    expect(await goalRow({ metric: 'romi', channelId: instagram, periodStart: '2027-02-10' })).toBeUndefined();

    const negative = await agent.post('/app/goals').type('form').send(
      createPayload({
        channelId: instagram,
        targetValue: '-5',
        periodStart: '2027-02-01',
        periodEnd: '2027-02-28',
        _csrf: csrf,
      }),
    );
    expect(negative.status).toBe(400);
    expect(negative.text).toMatch(/отрицательн/i);
    expect(await goalRow({ metric: 'cac', channelId: instagram, periodStart: '2027-02-01' })).toBeUndefined();

    const fractionalCustomers = await agent.post('/app/goals').type('form').send(
      createPayload({
        metric: 'new_customers',
        channelId: instagram,
        targetValue: '2,5',
        periodStart: '2027-02-01',
        periodEnd: '2027-02-28',
        _csrf: csrf,
      }),
    );
    expect(fractionalCustomers.status).toBe(400);
    expect(fractionalCustomers.text).toContain('целое');
    expect(
      await goalRow({ metric: 'new_customers', channelId: instagram, periodStart: '2027-02-01' }),
    ).toBeUndefined();

    const unknownMetric = await agent.post('/app/goals').type('form').send(
      createPayload({
        metric: 'roas',
        channelId: instagram,
        periodStart: '2027-02-01',
        periodEnd: '2027-02-28',
        _csrf: csrf,
      }),
    );
    expect(unknownMetric.status).toBe(400);
    expect(unknownMetric.text).toContain('метрик');
  });

  it('forbids goal creation for a viewer with the styled 403 page and rejects a missing CSRF token', async () => {
    const viewer = await signedIn(VIEWER);
    const viewerCsrf = await getAppCsrf(viewer);
    const instagram = await channelId('instagram');

    const forbidden = await viewer.post('/app/goals').type('form').send(
      createPayload({
        channelId: instagram,
        periodStart: '2027-03-01',
        periodEnd: '2027-03-31',
        _csrf: viewerCsrf,
      }),
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers['content-type']).toContain('text/html');
    expect(forbidden.text).toContain('Недостаточно прав');
    expect(await goalRow({ metric: 'cac', channelId: instagram, periodStart: '2027-03-01' })).toBeUndefined();

    const analyst = await signedIn(ANALYST);
    const noCsrf = await analyst.post('/app/goals').type('form').send(
      createPayload({
        channelId: instagram,
        periodStart: '2027-03-01',
        periodEnd: '2027-03-31',
      }),
    );
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.headers['content-type']).toContain('text/plain');
    expect(noCsrf.text).toBe('CSRF token mismatch');
  });

  it('edits the target and period, audits the change, and refuses an edit that would overlap', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const telegram = await channelId('telegram');

    const created = await agent.post('/app/goals').type('form').send(
      createPayload({
        metric: 'ltv_cac',
        channelId: telegram,
        targetValue: '2,5',
        periodStart: '2026-03-01',
        periodEnd: '2026-03-31',
        _csrf: csrf,
      }),
    );
    expect(created.status).toBe(302);
    const goal = await goalRow({ metric: 'ltv_cac', channelId: telegram, periodStart: '2026-03-01' });
    expect(goal).toBeDefined();
    expect(goal.target_value).toBe('2.50');

    const updated = await agent.post(`/app/goals/${goal.id}`).type('form').send({
      targetValue: '3,25',
      periodStart: '2026-03-05',
      periodEnd: '2026-03-31',
      _csrf: csrf,
    });
    expect(updated.status).toBe(302);
    expect(updated.headers.location).toBe('/app/goals');

    const after = await goalRow({ metric: 'ltv_cac', channelId: telegram, periodStart: '2026-03-05' });
    expect(after).toBeDefined();
    expect(after.id).toBe(goal.id);
    expect(after.target_value).toBe('3.25');
    expect(await auditActions(goal.id)).toContain(AUDIT_ACTIONS.GOAL_UPDATE);

    const january = await agent.post('/app/goals').type('form').send(
      createPayload({
        metric: 'ltv_cac',
        channelId: telegram,
        targetValue: '2,75',
        periodStart: '2027-01-01',
        periodEnd: '2027-01-31',
        _csrf: csrf,
      }),
    );
    expect(january.status).toBe(302);

    const overlappingEdit = await agent.post(`/app/goals/${after.id}`).type('form').send({
      targetValue: '3,50',
      periodStart: '2027-01-15',
      periodEnd: '2027-02-15',
      _csrf: csrf,
    });
    expect(overlappingEdit.status).toBe(400);
    expect(overlappingEdit.text).toContain('пересекающийся период');
    // The rejected edit keeps the goal on its old period and target.
    const unchanged = await goalRow({ metric: 'ltv_cac', channelId: telegram, periodStart: '2026-03-05' });
    expect(unchanged.target_value).toBe('3.25');
  });

  it('forbids deletion for a viewer and lets an analyst delete a goal with an audit entry', async () => {
    const analyst = await signedIn(ANALYST);
    const analystCsrf = await getAppCsrf(analyst);
    const tiktok = await channelId('tiktok');

    const created = await analyst.post('/app/goals').type('form').send(
      createPayload({
        metric: 'payback',
        channelId: tiktok,
        targetValue: '12',
        periodStart: '2027-02-01',
        periodEnd: '2027-02-28',
        _csrf: analystCsrf,
      }),
    );
    expect(created.status).toBe(302);
    const goal = await goalRow({ metric: 'payback', channelId: tiktok, periodStart: '2027-02-01' });
    expect(goal).toBeDefined();

    const viewer = await signedIn(VIEWER);
    const viewerCsrf = await getAppCsrf(viewer);
    const forbidden = await viewer
      .post(`/app/goals/${goal.id}/delete`)
      .type('form')
      .send({ _csrf: viewerCsrf });
    expect(forbidden.status).toBe(403);
    expect(forbidden.text).toContain('Недостаточно прав');
    expect(await goalRow({ metric: 'payback', channelId: tiktok, periodStart: '2027-02-01' })).toBeDefined();

    const deleted = await analyst
      .post(`/app/goals/${goal.id}/delete`)
      .type('form')
      .send({ _csrf: analystCsrf });
    expect(deleted.status).toBe(302);
    expect(deleted.headers.location).toBe('/app/goals');
    expect(await goalRow({ metric: 'payback', channelId: tiktok, periodStart: '2027-02-01' })).toBeUndefined();
    expect(await auditActions(goal.id)).toContain(AUDIT_ACTIONS.GOAL_DELETE);
  });

  it('lets an administrator create a global goal', async () => {
    const agent = await signedIn(ADMIN);
    const csrf = await getAppCsrf(agent);

    const res = await agent.post('/app/goals').type('form').send(
      createPayload({
        metric: 'new_customers',
        channelId: '',
        targetValue: '500',
        periodStart: '2027-04-01',
        periodEnd: '2027-04-30',
        _csrf: csrf,
      }),
    );

    expect(res.status).toBe(302);
    const created = await goalRow({ metric: 'new_customers', channelId: null, periodStart: '2027-04-01' });
    expect(created).toBeDefined();
    expect(created.channel_id).toBeNull();
    expect(created.target_value).toBe('500.00');
    expect(await auditActions(created.id)).toContain(AUDIT_ACTIONS.GOAL_CREATE);
  });
});
