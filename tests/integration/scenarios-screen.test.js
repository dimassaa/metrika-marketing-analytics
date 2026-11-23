import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
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
 * @param {bigint} cents
 * @returns {string} Plain decimal amount accepted by the budget parser.
 */
function bynFromCents(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

describe('scenarios builder screen', () => {
  it('replaces the placeholder with exactly one scenarios island', async () => {
    const agent = await signedIn(VIEWER);

    const res = await agent.get('/app/scenarios');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).not.toContain('следующем этапе');
    expect(countIslands(res.text, 'scenarios')).toBe(1);
    expect(res.text).toContain('data-island="scenarios"');
    expect(res.text).toContain('skeleton--chart');
    expect(extractDataProps(res.text, 'scenarios').mode).toBe('builder');
  });

  it('gives the page the same builder model the API returns', async () => {
    const agent = await signedIn(VIEWER);
    const base = extractDataProps((await agent.get('/app/scenarios')).text, 'scenarios');
    const queryBudget = bynFromCents(BigInt(base.budget.weeklyCents));

    for (const query of ['', `?budgetByn=${encodeURIComponent(queryBudget)}`]) {
      const page = await agent.get(`/app/scenarios${query}`);
      const api = await agent.get(`/api/v1/scenarios${query}`);

      expect(page.status, query).toBe(200);
      expect(api.status, query).toBe(200);
      expect(extractDataProps(page.text, 'scenarios'), query).toEqual(api.body);
    }
  });

  it('narrows the builder to the selected channels', async () => {
    const agent = await signedIn(VIEWER);
    const base = extractDataProps((await agent.get('/app/scenarios')).text, 'scenarios');
    const optimizable = base.channels.filter((channel) => channel.model === 'saturation').slice(0, 2);
    expect(optimizable.length).toBe(2);

    const res = await agent.get(
      `/app/scenarios?channelIds=${optimizable.map((channel) => channel.channelId).join(',')}`,
    );
    const props = extractDataProps(res.text, 'scenarios');

    expect(res.status).toBe(200);
    expect(props.channels.map((channel) => channel.channelId).sort()).toEqual(
      optimizable.map((channel) => channel.channelId).sort(),
    );
  });

  it('rejects a malformed, zero, negative or oversized budget on both paths with BYN wording', async () => {
    const agent = await signedIn(VIEWER);
    const base = extractDataProps((await agent.get('/app/scenarios')).text, 'scenarios');
    const oversized = bynFromCents(BigInt(base.budget.capCents) + 100n);

    for (const budget of ['abc', '-1', '0', oversized]) {
      const page = await agent.get(`/app/scenarios?budgetByn=${encodeURIComponent(budget)}`);
      const api = await agent.get(`/api/v1/scenarios?budgetByn=${encodeURIComponent(budget)}`);

      expect(page.status, budget).toBe(400);
      expect(api.status, budget).toBe(400);
      expect(api.body.error.code, budget).toBe('VALIDATION_ERROR');
      expect(page.text, budget).toMatch(/BYN/i);
      expect(api.body.error.message, budget).toMatch(/BYN/i);
      expect(api.body.error.message, budget).not.toMatch(/NaN|undefined/i);
    }
  });

  it('rejects an unusable budget when saving, not just when previewing', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent, '/app/scenarios');
    const base = extractDataProps((await agent.get('/app/scenarios')).text, 'scenarios');
    const oversized = bynFromCents(BigInt(base.budget.capCents) + 100n);

    for (const budget of ['-1', '0', oversized]) {
      const res = await agent
        .post('/app/scenarios')
        .type('form')
        .send({ _csrf: csrf, name: 'Плохой бюджет', budgetByn: budget });

      expect(res.status, budget).toBe(400);
      expect(res.text, budget).toMatch(/BYN/i);
    }

    const { rows } = await pool.query('SELECT count(*)::int AS total FROM scenarios');
    expect(rows[0].total).toBe(0);
  });
});

describe('scenario detail', () => {
  it('saves a scenario and returns the same detail object from the page and the API', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent, '/app/scenarios');
    const base = extractDataProps((await agent.get('/app/scenarios')).text, 'scenarios');
    const budget = bynFromCents(BigInt(base.budget.weeklyCents));

    const saved = await agent
      .post('/app/scenarios')
      .type('form')
      .send({ _csrf: csrf, name: 'Проверка снимка', budgetByn: budget });

    expect(saved.status).toBe(302);
    expect(saved.headers.location).toMatch(/^\/app\/scenarios\/\d+$/);

    const id = saved.headers.location.split('/').at(-1);
    const page = await agent.get(`/app/scenarios/${id}`);
    const api = await agent.get(`/api/v1/scenarios/${id}`);

    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    expect(api.headers['cache-control']).toBe('no-store');

    const props = extractDataProps(page.text, 'scenarios');
    expect(props.mode).toBe('detail');
    expect(props.id).toBe(id);
    expect(props.name).toBe('Проверка снимка');
    expect(props).toEqual(api.body);
  });

  it('answers a missing scenario with the designed 404 page and JSON 404 on the API', async () => {
    const agent = await signedIn(VIEWER);

    const page = await agent.get('/app/scenarios/999999');
    const api = await agent.get('/api/v1/scenarios/999999');

    expect(page.status).toBe(404);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.text).toContain('Страница не найдена');

    expect(api.status).toBe(404);
    expect(api.body.error.code).toBe('NOT_FOUND');
  });

  it('creates a scenario through the API with 201 and returns its detail', async () => {
    const agent = await signedIn(ANALYST);
    const csrf = await getAppCsrf(agent, '/app/scenarios');
    const base = extractDataProps((await agent.get('/app/scenarios')).text, 'scenarios');

    const res = await agent
      .post('/api/v1/scenarios')
      .set('X-CSRF-Token', csrf)
      .send({ name: 'API сценарий', budgetByn: bynFromCents(BigInt(base.budget.weeklyCents)) });

    expect(res.status).toBe(201);
    expect(res.type).toMatch(/application\/json/);
    expect(res.body.mode).toBe('detail');
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('API сценарий');

    const detail = await agent.get(`/api/v1/scenarios/${res.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(res.body);
  });
});
