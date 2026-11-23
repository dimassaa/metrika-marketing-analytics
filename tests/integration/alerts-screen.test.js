import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { formatDateTimeRu } from '../../src/lib/format.js';
import { clearDecisionTables, seedDecisions } from '../helpers/decisionSeeds.js';
import { closeTestPool, getTestPool } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
import { getAppCsrf } from '../helpers/csrf.js';
import { countIslands, extractDataProps } from '../helpers/dataProps.js';

const ANALYST = 'analyst@metrika.by';
const VIEWER = 'viewer@metrika.by';

/** The frame's HTML contract must not depend on the build output. */
const NO_ASSETS = { assets: { assets: () => ({ scripts: [], preloads: [] }) } };

/** @type {import('pg').Pool} */
let pool;
/** @type {import('express').Express} */
let app;

beforeAll(async () => {
  await seedDecisions();
  pool = getTestPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await clearDecisionTables(pool);
  app = makeApp(NO_ASSETS);
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
 * @returns {Promise<number>}
 */
async function alertCount() {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM alerts');
  return rows[0].total;
}

/**
 * @returns {Promise<string | null>} Latest stored check time, as an ISO string.
 */
async function lastDetectedAt() {
  const { rows } = await pool.query('SELECT max(detected_at)::text AS last FROM alerts');
  return rows[0]?.last ?? null;
}

describe('alerts screen', () => {
  it('replaces the placeholder with exactly one alert island', async () => {
    const agent = await signedIn(ANALYST);

    const res = await agent.get('/app/alerts');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).not.toContain('следующем этапе');
    expect(countIslands(res.text, 'alerts')).toBe(1);
    expect(res.text).toContain('data-island="alerts"');
    expect(res.text).toContain('skeleton--chart');
    expect(res.text).toContain('<noscript>');
  });

  it('gives the page the same model the API returns after the automatic recalculation', async () => {
    const agent = await signedIn(ANALYST);

    // The page recalculation runs first; the API then reads the rows the page just wrote.
    for (const query of ['', '?status=all', '?severity=critical']) {
      const page = await agent.get(`/app/alerts${query}`);
      const api = await agent.get(`/api/v1/alerts${query}`);

      expect(page.status, query).toBe(200);
      expect(api.status, query).toBe(200);
      expect(extractDataProps(page.text, 'alerts'), query).toEqual(api.body);
    }
  });

  it('changes the rows with the status and severity filters', async () => {
    const agent = await signedIn(ANALYST);

    const active = extractDataProps((await agent.get('/app/alerts')).text, 'alerts');
    const all = extractDataProps((await agent.get('/app/alerts?status=all')).text, 'alerts');
    const critical = extractDataProps((await agent.get('/app/alerts?severity=critical')).text, 'alerts');

    expect(active.rows.length).toBeGreaterThan(0);
    expect(active.rows.every((row) => row.status === 'active')).toBe(true);
    expect(all.rows.length).toBeGreaterThanOrEqual(active.rows.length);
    expect(critical.rows.every((row) => row.severity === 'critical')).toBe(true);
    expect(critical.rows.length).toBeLessThanOrEqual(all.rows.length);
  });

  it('falls back to active on the page for a stale bookmark while the API rejects it', async () => {
    const agent = await signedIn(ANALYST);

    const page = await agent.get('/app/alerts?status=bogus');
    const api = await agent.get('/api/v1/alerts?status=bogus');

    expect(page.status).toBe(200);
    expect(extractDataProps(page.text, 'alerts').filters.status).toBe('active');
    expect(api.status).toBe(400);
    expect(api.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('does not recalculate or write anything for a viewer', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/alerts');
    const props = extractDataProps(res.text, 'alerts');

    expect(res.status).toBe(200);
    expect(await alertCount()).toBe(0);
    expect(props.rows).toEqual([]);
    expect(props.empty).toBe(true);
    expect(props.summary.lastRecalculatedLabel).toBe('Ещё не проверяли');
    expect(res.text).not.toContain('action="/app/alerts/recalculate"');
    expect(res.text).not.toContain('/dismiss');
  });

  it('throttles the automatic recalculation and takes the label from MAX(detected_at)', async () => {
    const agent = await signedIn(ANALYST);

    const first = await agent.get('/app/alerts');
    expect(first.status).toBe(200);
    expect(await alertCount()).toBeGreaterThan(0);
    const firstCheck = await lastDetectedAt();

    // Time travel: a second request within the hour must not overwrite the stored check time.
    await pool.query("UPDATE alerts SET detected_at = '2020-01-01T00:00:00Z'");
    const second = await agent.get('/app/alerts');
    const props = extractDataProps(second.text, 'alerts');

    expect(await alertCount()).toBeGreaterThan(0);
    expect(new Date(await lastDetectedAt()).toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(props.summary.lastRecalculatedLabel).toBe(formatDateTimeRu('2020-01-01T00:00:00Z'));
    expect(props.summary.lastRecalculatedLabel).not.toBe(formatDateTimeRu(firstCheck));
    expect(props.summary.isStale).toBe(true);
  });

  it('recalculates on the manual POST inside the throttle window and refreshes the session stamp', async () => {
    const agent = await signedIn(ANALYST);
    await agent.get('/app/alerts');

    const { rows: before } = await pool.query(
      "SELECT (sess->>'alertsRecalculatedAt')::bigint AS stamp FROM sessions",
    );
    const csrf = await getAppCsrf(agent, '/app/alerts');
    await pool.query("UPDATE alerts SET detected_at = '2020-01-01T00:00:00Z'");

    const res = await agent
      .post('/app/alerts/recalculate')
      .type('form')
      .send({ _csrf: csrf, status: 'all', severity: 'warning' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/app/alerts');
    expect(res.headers.location).toContain('status=all');
    expect(res.headers.location).toContain('severity=warning');
    expect(new Date(await lastDetectedAt()).toISOString()).not.toBe('2020-01-01T00:00:00.000Z');

    const { rows: after } = await pool.query(
      "SELECT (sess->>'alertsRecalculatedAt')::bigint AS stamp FROM sessions",
    );
    expect(Number(after[0].stamp)).toBeGreaterThanOrEqual(Number(before[0].stamp));
  });

  it('serves fifty rows per page and reports more rows', async () => {
    const agent = await signedIn(VIEWER);
    const { rows: channels } = await pool.query(
      'SELECT id::text AS id FROM channels ORDER BY id LIMIT 8',
    );
    const rules = ['cac_spike', 'romi_below_target', 'romi_negative', 'payback_long', 'ltv_cac_low'];

    let inserted = 0;
    for (const periodStart of ['2026-10-19', '2026-10-12']) {
      for (const channel of channels) {
        for (const rule of rules) {
          if (inserted >= 51) break;
          await pool.query(
            `INSERT INTO alerts (channel_id, rule, period_start, severity, value, threshold, status)
             VALUES ($1::bigint, $2, $3::date, 'warning', 1, 1, 'active')`,
            [channel.id, rule, periodStart],
          );
          inserted += 1;
        }
        if (inserted >= 51) break;
      }
      if (inserted >= 51) break;
    }
    expect(inserted).toBe(51);

    const res = await agent.get('/app/alerts');
    const props = extractDataProps(res.text, 'alerts');

    expect(res.status).toBe(200);
    expect(props.rows).toHaveLength(50);
    expect(props.pagination.total).toBe(51);
    expect(props.pagination.hasMore).toBe(true);
    expect(res.text).toContain('page=2');
  });
});
