import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { CHANNELS } from '../../db/seed/data.js';
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
  // A leftover cookie would make the next test depend on test order; the channel rows themselves are shared because
  // the archive toggle test deliberately reuses the channel created two tests earlier.
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
 * @param {string} code Channel code fixed in the seed or in this file.
 * @returns {Promise<{ id: string, is_active: boolean, target_cac_cents: string, target_romi_pct: string } | undefined>}
 */
async function channelRow(code) {
  const { rows } = await pool.query(
    `SELECT id::text AS id, is_active, target_cac_cents::text AS target_cac_cents,
            target_romi_pct::text AS target_romi_pct
       FROM channels
      WHERE code = $1`,
    [code],
  );
  return rows[0];
}

/**
 * @param {string} entityId
 * @returns {Promise<string[]>} Audit actions recorded for the channel, oldest first.
 */
async function auditActions(entityId) {
  const { rows } = await pool.query(
    'SELECT action FROM audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY id',
    ['channel', entityId],
  );
  return rows.map((row) => row.action);
}

describe('channels list', () => {
  it('shows the eight demo channels and BYN targets to a viewer without the manage form', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/channels');

    expect(res.status).toBe(200);
    for (const channel of CHANNELS) {
      expect(res.text).toContain(channel.name);
    }
    // Instagram's 45 BYN target CAC proves the kopeck-to-BYN bridge and the glyph span.
    expect(res.text).toContain('45,00');
    expect(res.text).toContain('<span class="byn">BYN</span>');
    expect(res.text).not.toContain('name="code"');
    expect(res.text).not.toContain('следующем этапе');
  });

  it('renders the channel passport with prefilled manage fields for an analyst', async () => {
    const agent = await signedIn(ANALYST);
    const instagram = await channelRow('instagram');

    const res = await agent.get(`/app/channels/${instagram.id}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Instagram');
    expect(res.text).toContain('45,00');
    expect(res.text).toContain('name="name"');
    expect(res.text).toContain('name="targetCacByn"');
  });

  it('answers a missing channel with the designed 404 page', async () => {
    const agent = await signedIn(ANALYST);

    const res = await agent.get('/app/channels/999999');

    expect(res.status).toBe(404);
    expect(res.text).toContain('Страница не найдена');
  });
});

describe('channel mutations', () => {
  it('forbids channel creation for a viewer with the styled 403 page', async () => {
    const agent = await signedIn(VIEWER);
    const csrf = await getAppCsrf(agent);

    const res = await agent
      .post('/app/channels')
      .type('form')
      .send({ code: 'viewer_channel', name: 'Viewer channel', kind: 'paid', _csrf: csrf });

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Недостаточно прав');
    expect(await channelRow('viewer_channel')).toBeUndefined();
  });

  it('rejects a channel POST without a CSRF token before any RBAC or validation runs', async () => {
    const agent = await signedIn(ANALYST);

    const res = await agent
      .post('/app/channels')
      .type('form')
      .send({ code: 'no_csrf', name: 'No CSRF', kind: 'paid' });

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toBe('CSRF token mismatch');
  });

  it('creates a channel with kopeck-precise CAC, numeric ROMI and an audit entry', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const list = await agent.get('/app/channels');
    expect(list.text).toContain('name="code"');

    const res = await agent
      .post('/app/channels')
      .type('form')
      .send({
        code: 'viber_ads',
        name: 'Viber Ads',
        kind: 'paid',
        targetCacByn: '38,50',
        targetRomiPct: '115',
        _csrf: csrf,
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/app/channels');

    const created = await channelRow('viber_ads');
    expect(created).toBeDefined();
    expect(created.target_cac_cents).toBe('3850');
    expect(created.target_romi_pct).toBe('115.00');

    expect(await auditActions(created.id)).toContain(AUDIT_ACTIONS.CHANNEL_CREATE);
    const { rows } = await pool.query(
      'SELECT payload FROM audit_log WHERE action = $1 AND entity_id = $2',
      [AUDIT_ACTIONS.CHANNEL_CREATE, created.id],
    );
    // The payload keeps cents as a string: a bigint would make JSON.stringify throw inside node-postgres.
    expect(rows[0].payload).toMatchObject({ code: 'viber_ads', targetCacCents: '3850' });
  });

  it('re-renders the list with a Russian message for duplicate and malformed codes', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);

    const duplicate = await agent
      .post('/app/channels')
      .type('form')
      .send({ code: 'instagram', name: 'Instagram duplicate', kind: 'paid', _csrf: csrf });

    expect(duplicate.status).toBe(400);
    expect(duplicate.headers['content-type']).toContain('text/html');
    expect(duplicate.text).toContain('уже существует');
    // Submitted values come back escaped, so a correction does not start from an empty form.
    expect(duplicate.text).toContain('value="instagram"');

    const malformed = await agent
      .post('/app/channels')
      .type('form')
      .send({ code: 'Bad-Code!', name: 'Malformed', kind: 'paid', _csrf: csrf });

    expect(malformed.status).toBe(400);
    expect(malformed.headers['content-type']).toContain('text/html');
    expect(malformed.text).toContain('Код');
    expect(await channelRow('Bad-Code!')).toBeUndefined();
  });

  it('refuses to archive a channel that still has active campaigns', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const instagram = await channelRow('instagram');

    const res = await agent.post(`/app/channels/${instagram.id}/archive`).type('form').send({ _csrf: csrf });

    expect(res.status).toBe(400);
    expect(res.text).toContain('активными кампаниями');
    expect((await channelRow('instagram')).is_active).toBe(true);
    expect(await auditActions(instagram.id)).not.toContain(AUDIT_ACTIONS.CHANNEL_ARCHIVE);
  });

  it('toggles archive and restore for a channel without campaigns, auditing both', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const before = await channelRow('viber_ads');
    expect(before.is_active).toBe(true);

    const archive = await agent.post(`/app/channels/${before.id}/archive`).type('form').send({ _csrf: csrf });
    expect(archive.status).toBe(302);
    expect((await channelRow('viber_ads')).is_active).toBe(false);

    const restore = await agent.post(`/app/channels/${before.id}/archive`).type('form').send({ _csrf: csrf });
    expect(restore.status).toBe(302);
    expect((await channelRow('viber_ads')).is_active).toBe(true);

    const actions = await auditActions(before.id);
    expect(actions).toContain(AUDIT_ACTIONS.CHANNEL_ARCHIVE);
    expect(actions).toContain(AUDIT_ACTIONS.CHANNEL_RESTORE);
  });

  it('stores a script-like name literally and escapes it on the list page', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent);
    const name = '<script>alert(1)</script>';

    const created = await agent
      .post('/app/channels')
      .type('form')
      .send({ code: 'xss_test', name, kind: 'paid', _csrf: csrf });
    expect(created.status).toBe(302);

    const { rows } = await pool.query('SELECT name FROM channels WHERE code = $1', ['xss_test']);
    expect(rows[0].name).toBe(name);

    const list = await agent.get('/app/channels');

    expect(list.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(list.text).not.toContain(name);
  });
});
