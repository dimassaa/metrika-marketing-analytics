import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
import { getAppCsrf } from '../helpers/csrf.js';
import { AUDIT_ACTIONS } from '../../src/config/audit-actions.js';

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
  // A leftover session cookie would make the next test depend on test order. Campaign rows are shared across the
  // file because the edit/pause and delete cases deliberately reuse seeded and just-created campaigns.
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
 * @param {string} code Campaign code fixed in the seed or in this file.
 * @returns {Promise<Record<string, string> | undefined>}
 */
async function campaignRow(code) {
  const { rows } = await pool.query(
    `SELECT id::text AS id, channel_id::text AS channel_id, status, name,
            started_on::text AS started_on, ended_on::text AS ended_on,
            budget_cents::text AS budget_cents
       FROM campaigns
      WHERE code = $1`,
    [code],
  );
  return rows[0];
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
 * Counts the data rows of the first table on a page, so a filter test bounds the list instead of only checking that
 * some names appear somewhere in the HTML.
 * @param {string} html
 * @returns {number}
 */
function tableRowCount(html) {
  const start = html.indexOf('<tbody');
  const end = html.indexOf('</tbody>');
  const body = start === -1 || end === -1 ? '' : html.slice(start, end);
  return (body.match(/<tr\b/g) ?? []).length;
}

/**
 * @param {string} entityId
 * @returns {Promise<string[]>} Audit actions recorded for the campaign, oldest first.
 */
async function auditActions(entityId) {
  const { rows } = await pool.query(
    'SELECT action FROM audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY id',
    ['campaign', entityId],
  );
  return rows.map((row) => row.action);
}

/**
 * @param {Record<string, string>} overrides
 * @returns {Record<string, string>}
 */
function createPayload(overrides) {
  return {
    channelId: '',
    code: 'campaign_test',
    name: 'Тестовая кампания',
    status: 'active',
    startedOn: '2026-09-01',
    endedOn: '',
    budgetByn: '1 500,00',
    _csrf: '',
    ...overrides,
  };
}

describe('campaigns list', () => {
  it('filters by status, channel and text query without touching the placeholder page', async () => {
    const agent = await signedIn(VIEWER);
    const instagram = await channelId('instagram');

    const active = await agent.get('/app/campaigns?status=active');
    expect(active.status).toBe(200);

    const { rows: activeRows } = await pool.query("SELECT count(*)::int AS n FROM campaigns WHERE status = 'active'");
    expect(tableRowCount(active.text)).toBe(activeRows[0].n);
    // The finished campaign of the seed is the only one that must disappear from the active filter.
    expect(active.text).not.toContain('Блогеры — видеообзоры');
    expect(active.text).not.toContain('следующем этапе');
    // A viewer may read the list but not see the creation form.
    expect(active.text).not.toContain('name="budgetByn"');

    const byChannel = await agent.get(`/app/campaigns?channelId=${instagram}`);
    expect(byChannel.status).toBe(200);

    const { rows: channelRows } = await pool.query(
      'SELECT count(*)::int AS n FROM campaigns WHERE channel_id = $1::bigint',
      [instagram],
    );
    expect(tableRowCount(byChannel.text)).toBe(channelRows[0].n);
    expect(byChannel.text).toContain('Instagram — ретаргетинг');
    expect(byChannel.text).not.toContain('Google Ads — брендовый поиск');

    const search = await agent.get('/app/campaigns?q=seo_blog');
    expect(search.status).toBe(200);
    expect(tableRowCount(search.text)).toBe(1);
    expect(search.text).toContain('SEO — блог о кофе');
  });

  it('shows budget and spend totals in BYN with the NBRB glyph', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/campaigns');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Бюджет');
    expect(res.text).toContain('Расход');
    expect(res.text).toContain('<span class="byn">BYN</span>');
  });
});

describe('campaign mutations', () => {
  it('creates a campaign with a kopeck-precise budget and writes an audit entry', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const instagram = await channelId('instagram');

    const res = await agent.post('/app/campaigns').type('form').send(
      createPayload({
        channelId: instagram,
        code: 'campaign_create_test',
        name: 'Весенняя кампания',
        budgetByn: '5 000,00',
        _csrf: csrf,
      }),
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/campaigns');

    const created = await campaignRow('campaign_create_test');
    expect(created).toBeDefined();
    expect(created.channel_id).toBe(instagram);
    expect(created.budget_cents).toBe('500000');
    expect(created.status).toBe('active');
    expect(await auditActions(created.id)).toContain(AUDIT_ACTIONS.CAMPAIGN_CREATE);
  });

  it('rejects duplicate and malformed campaign codes with Russian messages', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const instagram = await channelId('instagram');

    const duplicate = await agent.post('/app/campaigns').type('form').send(
      createPayload({
        channelId: instagram,
        code: 'instagram_retarget',
        name: 'Дубль существующей кампании',
        _csrf: csrf,
      }),
    );

    expect(duplicate.status).toBe(400);
    expect(duplicate.text).toContain('уже существует');
    expect(duplicate.text).toContain('value="instagram_retarget"');

    const malformed = await agent.post('/app/campaigns').type('form').send(
      createPayload({
        channelId: instagram,
        code: 'Bad Code!',
        _csrf: csrf,
      }),
    );

    expect(malformed.status).toBe(400);
    expect(malformed.text).toContain('Код кампании');
    expect(await campaignRow('Bad Code!')).toBeUndefined();
  });

  it('keeps the form with Russian messages for an inverted date range and an archived channel', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const instagram = await channelId('instagram');

    const inverted = await agent.post('/app/campaigns').type('form').send(
      createPayload({
        channelId: instagram,
        code: 'campaign_bad_dates',
        startedOn: '2026-09-10',
        endedOn: '2026-09-01',
        _csrf: csrf,
      }),
    );

    expect(inverted.status).toBe(400);
    expect(inverted.headers['content-type']).toContain('text/html');
    expect(inverted.text).toContain('Дата окончания не может быть раньше даты старта');
    // The submitted values come back, so only the bad field needs correcting.
    expect(inverted.text).toContain('value="campaign_bad_dates"');
    expect(await campaignRow('campaign_bad_dates')).toBeUndefined();

    const { rows } = await pool.query(
      `INSERT INTO channels (code, name, kind, is_active)
       VALUES ('test_archived', 'Архивный канал', 'paid', false)
       RETURNING id::text AS id`,
    );
    const archivedId = rows[0].id;

    const archived = await agent.post('/app/campaigns').type('form').send(
      createPayload({
        channelId: archivedId,
        code: 'campaign_archived',
        _csrf: csrf,
      }),
    );

    expect(archived.status).toBe(400);
    expect(archived.headers['content-type']).toContain('text/html');
    expect(archived.text).toContain('архивн');
    expect(await campaignRow('campaign_archived')).toBeUndefined();

    const missing = await agent.post('/app/campaigns').type('form').send(
      createPayload({
        channelId: '999999',
        code: 'campaign_missing_channel',
        _csrf: csrf,
      }),
    );

    expect(missing.status).toBe(400);
    expect(missing.text).toContain('Канал не найден');
    expect(await campaignRow('campaign_missing_channel')).toBeUndefined();
  });

  it('creates a campaign from the channel quick form without an end date and returns to the passport', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const instagram = await channelId('instagram');

    const { endedOn: _omitted, ...payload } = createPayload({
      channelId: instagram,
      code: 'campaign_quick_form',
      name: 'Быстрая кампания канала',
      from: 'channel',
      _csrf: csrf,
    });

    const res = await agent.post('/app/campaigns').type('form').send(payload);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/app/channels/${instagram}`);

    const created = await campaignRow('campaign_quick_form');
    expect(created).toBeDefined();
    expect(created.ended_on).toBeNull();
  });

  it('refuses to delete a seeded campaign with statistics and orders', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const seeded = await campaignRow('instagram_retarget');

    const res = await agent.post(`/app/campaigns/${seeded.id}/delete`).type('form').send({ _csrf: csrf });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Нельзя удалить кампанию');
    expect(res.text).toContain('Завершена');
    expect(await campaignRow('instagram_retarget')).toBeDefined();
    expect(await auditActions(seeded.id)).not.toContain(AUDIT_ACTIONS.CAMPAIGN_DELETE);
  });

  it('deletes an empty mis-created campaign and audits it', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const instagram = await channelId('instagram');

    const created = await agent.post('/app/campaigns').type('form').send(
      createPayload({
        channelId: instagram,
        code: 'campaign_delete_test',
        name: 'Пустая кампания',
        _csrf: csrf,
      }),
    );
    expect(created.status).toBe(302);

    const empty = await campaignRow('campaign_delete_test');
    const res = await agent.post(`/app/campaigns/${empty.id}/delete`).type('form').send({ _csrf: csrf });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/campaigns');
    expect(await campaignRow('campaign_delete_test')).toBeUndefined();
    expect(await auditActions(empty.id)).toContain(AUDIT_ACTIONS.CAMPAIGN_DELETE);
  });

  it('pauses a campaign through the edit endpoint and audits the update', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const before = await campaignRow('instagram_reels');

    const res = await agent.post(`/app/campaigns/${before.id}`).type('form').send({
      name: 'Instagram — Reels (пауза)',
      status: 'paused',
      startedOn: before.started_on,
      endedOn: '',
      budgetByn: '8 500,00',
      _csrf: csrf,
    });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/campaigns');

    const after = await campaignRow('instagram_reels');
    expect(after.status).toBe('paused');
    expect(after.name).toBe('Instagram — Reels (пауза)');
    expect(after.budget_cents).toBe('850000');
    expect(await auditActions(before.id)).toContain(AUDIT_ACTIONS.CAMPAIGN_UPDATE);
  });

  it('forbids campaign creation for a viewer with the styled 403 page', async () => {
    const agent = await signedIn(VIEWER);
    const csrf = await getAppCsrf(agent);
    const instagram = await channelId('instagram');

    const res = await agent.post('/app/campaigns').type('form').send(
      createPayload({
        channelId: instagram,
        code: 'viewer_campaign',
        _csrf: csrf,
      }),
    );

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Недостаточно прав');
    expect(await campaignRow('viewer_campaign')).toBeUndefined();
  });

  it('rejects a campaign POST without a CSRF token before any RBAC or validation runs', async () => {
    const agent = await signedIn(ANALYST);
    const instagram = await channelId('instagram');

    const res = await agent.post('/app/campaigns').type('form').send(
      createPayload({
        channelId: instagram,
        code: 'no_csrf_campaign',
      }),
    );

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toBe('CSRF token mismatch');
  });
});

describe('campaign table on the channel passport', () => {
  it('lists only this channel campaigns and offers the quick add form', async () => {
    const agent = await signedIn(ANALYST);
    const instagram = await channelId('instagram');

    const res = await agent.get(`/app/channels/${instagram}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Instagram — ретаргетинг');
    expect(res.text).toContain('Instagram — холодный трафик');
    expect(res.text).not.toContain('Google Ads — брендовый поиск');
    expect(res.text).toContain('action="/app/campaigns"');
    expect(res.text).toContain(`name="channelId" value="${instagram}"`);
  });

  it('keeps the campaign table visible but hides the quick form from a viewer', async () => {
    const agent = await signedIn(VIEWER);
    const instagram = await channelId('instagram');

    const res = await agent.get(`/app/channels/${instagram}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Instagram — ретаргетинг');
    expect(res.text).not.toContain('action="/app/campaigns"');
  });
});
