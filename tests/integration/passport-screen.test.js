import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { createAuditRepository } from '../../src/repositories/audit.repo.js';
import { createCampaignsRepository } from '../../src/repositories/campaigns.repo.js';
import { createChannelsRepository } from '../../src/repositories/channels.repo.js';
import { createReferenceRepository } from '../../src/repositories/reference.repo.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { createCampaignsService } from '../../src/services/campaigns.service.js';
import { createChannelsService } from '../../src/services/channels.service.js';
import { createMetricsModule } from '../../src/services/metrics/index.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
import { countIslands, extractDataProps } from '../helpers/dataProps.js';
import { wrapDb } from '../helpers/queryCounter.js';

const VIEWER = 'viewer@metrika.by';

/** The passport frame must not depend on the build output for its HTML contract. */
const NO_ASSETS = { assets: { assets: () => ({ scripts: [], preloads: [] }) } };

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
  await pool.query('DELETE FROM sessions');
  app = makeApp(NO_ASSETS);
});

async function signedIn() {
  const agent = request.agent(app);
  const login = await loginAs(agent, VIEWER);
  expect(login.status).toBe(302);
  return agent;
}

/**
 * @param {string} code
 * @returns {Promise<string>} Channel id as a decimal string.
 */
async function channelId(code) {
  const { rows } = await pool.query('SELECT id::text AS id FROM channels WHERE code = $1', [code]);
  return rows[0].id;
}

/**
 * @param {string} code
 * @param {{ active?: boolean }} [options]
 * @returns {Promise<string>} Id of a channel inserted for one test.
 */
async function insertChannel(code, { active = true } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO channels (code, name, kind, is_active, target_cac_cents, target_romi_pct)
     VALUES ($1, $2, 'paid', $3, 5000, 100)
     RETURNING id::text AS id`,
    [code, code, active],
  );
  return rows[0].id;
}

describe('channel passport screen', () => {
  it('renders one island mount node for a viewer and leaves the numbers to React', async () => {
    const agent = await signedIn();
    const id = await channelId('instagram');

    const res = await agent.get(`/app/channels/${id}`);

    expect(res.status).toBe(200);
    expect(countIslands(res.text, 'channel')).toBe(1);
    expect(res.text).toContain('data-island="channel"');
    expect(res.text).toContain('skeleton--chart');
    expect(res.text).toContain('<noscript>');
    expect(res.text).not.toContain('kpi__value');
  });

  it('gives the page exactly the object /api/v1/channels/:id returns, for the same period', async () => {
    const agent = await signedIn();
    const id = await channelId('instagram');

    for (const query of ['', '?days=90']) {
      const page = await agent.get(`/app/channels/${id}${query}`);
      const api = await agent.get(`/api/v1/channels/${id}${query}`);

      expect(page.status, query).toBe(200);
      expect(api.status, query).toBe(200);
      expect(extractDataProps(page.text, 'channel')).toEqual(api.body);
    }

    const short = extractDataProps((await agent.get(`/app/channels/${id}`)).text, 'channel');
    const long = extractDataProps((await agent.get(`/app/channels/${id}?days=90`)).text, 'channel');
    expect(long.period.days).toBe(90);
    expect(long.period.from).not.toBe(short.period.from);
  });

  it('carries the same CAC, LTV and ROMI as the channel row of /api/v1/channels', async () => {
    const agent = await signedIn();
    const id = await channelId('instagram');
    const page = await agent.get(`/app/channels/${id}`);
    const channels = await agent.get('/api/v1/channels');
    const row = channels.body.rows.find((item) => item.channelId === id);
    const props = extractDataProps(page.text, 'channel');

    expect(row).toBeDefined();
    expect(props.health).toMatchObject({
      cacCents: row.cacCents,
      ltv12Cents: row.ltv12Cents,
      romiPct: row.romiPct,
      spendCents: row.spendCents,
      revenueCents: row.revenueCents,
      status: row.status,
    });
    expect(props.charts.cac.series).toHaveLength(12);
    expect(props.charts.romi.series).toHaveLength(12);
    expect(props.charts.spendRevenue.hasData).toBe(true);
  });

  it('shows retention, the five-stage funnel and target comparisons', async () => {
    const agent = await signedIn();
    const id = await channelId('instagram');

    const props = extractDataProps((await agent.get(`/app/channels/${id}`)).text, 'channel');

    expect(props.retention.horizonMonths).toBe(12);
    expect(props.retention.cohorts.length).toBeGreaterThan(0);
    expect(props.funnel.stages.map((stage) => stage.key)).toEqual([
      'impressions',
      'clicks',
      'leads',
      'newCustomers',
      'orders',
    ]);
    expect(props.funnel.meterMax).toBeGreaterThanOrEqual(1);
    expect(props.funnel.stages.every((stage) => stage.meterMax >= 1)).toBe(true);
    expect(props.targets.map((target) => target.metric)).toEqual(['cac', 'romi']);
    expect(props.campaigns.length).toBeGreaterThan(0);
    expect(JSON.stringify(props)).not.toMatch(/NaN|Infinity/);
  });

  it('answers an unknown channel id with the designed 404 page', async () => {
    const agent = await signedIn();

    for (const id of ['999999', 'abc', '9223372036854775808']) {
      const res = await agent.get(`/app/channels/${id}`);
      expect(res.status, id).toBe(404);
      expect(res.text, id).toContain('Страница не найдена');
    }
  });

  it('renders a channel without statistics as no_data with zero funnel and meter max 1', async () => {
    const agent = await signedIn();
    const id = await insertChannel('passport_empty');

    const res = await agent.get(`/app/channels/${id}`);
    const props = extractDataProps(res.text, 'channel');

    expect(res.status).toBe(200);
    expect(props.health.status).toBe('no_data');
    expect(props.funnel.stages.map((stage) => stage.value)).toEqual([0, 0, 0, 0, 0]);
    expect(props.funnel.stages.every((stage) => stage.meterMax >= 1)).toBe(true);
    expect(props.funnel.meterMax).toBe(1);
    expect(props.charts.cac.hasData).toBe(false);
    expect(props.retention.hasData).toBe(false);
    expect(JSON.stringify(props)).not.toMatch(/NaN|Infinity/);
  });

  it('marks an archived channel in the model and in the page', async () => {
    const agent = await signedIn();
    const id = await insertChannel('passport_archived', { active: false });

    const res = await agent.get(`/app/channels/${id}`);
    const props = extractDataProps(res.text, 'channel');

    expect(res.status).toBe(200);
    expect(props.channel).toMatchObject({ isActive: false, statusLabel: 'В архиве' });
    // The archive badge is in the server frame as well, so it is visible before the island mounts.
    expect(res.text).toContain('В архиве');
  });

  it('keeps the whole passport within the 26-query budget, independent of campaign count', async () => {
    const counter = wrapDb(pool);
    const referenceRepository = createReferenceRepository(counter.db);
    const metrics = createMetricsModule({ db: counter.db, referenceRepository });
    const channelsRepository = createChannelsRepository(counter.db);
    const campaignsRepository = createCampaignsRepository(counter.db);
    const auditService = createAuditService({ auditRepository: createAuditRepository(counter.db) });
    const channelsService = createChannelsService({ channelsRepository, auditService });
    const campaignsService = createCampaignsService({ campaignsRepository, channelsRepository, auditService });
    const anchor = await referenceRepository.getDataAnchor();
    const id = await channelId('instagram');

    counter.reset();
    await channelsService.getChannelDetail(id);
    await campaignsService.listCampaignsForChannel(id);
    await metrics.services.channelPassport.getChannelPassport({ anchor, channelId: id });
    await metrics.services.ltv.getCohortMatrix({ anchor, channelId: id });
    const queries = counter.count();

    expect(queries, `passport used ${queries} queries`).toBeLessThanOrEqual(26);
  });
});
