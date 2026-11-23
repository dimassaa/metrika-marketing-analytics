import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTIONS } from '../../src/config/audit-actions.js';
import { METRICS_CONFIG } from '../../src/config/metrics.js';
import { addDays } from '../../src/lib/dates.js';
import { ValidationError } from '../../src/lib/errors.js';
import { centsToBynDecimal } from '../../src/lib/metrics-math.js';
import { createChannelsRepository } from '../../src/repositories/channels.repo.js';
import { createCohortsRepository } from '../../src/repositories/cohorts.repo.js';
import { createMetricsRepository } from '../../src/repositories/metrics.repo.js';
import { createScenariosRepository } from '../../src/repositories/scenarios.repo.js';
import { createScenariosService } from '../../src/services/decisions/scenarios.service.js';
import { createLtvService } from '../../src/services/metrics/ltv.service.js';
import { resolveWeekRange } from '../../src/services/metrics/weekly-series.js';
import { clearDecisionTables, SEED_ANCHOR, seedDecisions } from '../helpers/decisionSeeds.js';
import { closeTestPool, getTestPool } from '../helpers/db.js';

/** @type {import('pg').Pool} */
let pool;
/** @type {ReturnType<typeof createScenariosService>} */
let scenariosService;
/** @type {ReturnType<typeof createMetricsRepository>} */
let metricsRepository;
/** @type {ReturnType<typeof createChannelsRepository>} */
let channelsRepository;
/** @type {ReturnType<typeof createLtvService>} */
let ltvService;
/** @type {ReturnType<typeof createScenariosRepository>} */
let scenariosRepository;
/** @type {Array<{ id: string, code: string, name: string }>} */
let channels;

beforeAll(async () => {
  await seedDecisions();
  pool = getTestPool();
  metricsRepository = createMetricsRepository(pool);
  channelsRepository = createChannelsRepository(pool);
  ltvService = createLtvService({ cohortsRepository: createCohortsRepository(pool) });
  scenariosRepository = createScenariosRepository(pool);
  scenariosService = createScenariosService({
    db: pool,
    metricsRepository,
    channelsRepository,
    ltvService,
  });

  const { rows } = await pool.query('SELECT id::text AS id, code, name FROM channels ORDER BY code');
  channels = rows;
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await clearDecisionTables(pool);
});

/**
 * @param {object} built `buildScenario` result.
 * @returns {bigint} Current spend of the optimizable channels — the cap/warning base.
 */
function optimizableBaseline(built) {
  return built.channels
    .filter((channel) => channel.model === 'saturation')
    .reduce((sum, channel) => sum + BigInt(channel.current.spendCents), 0n);
}

/**
 * @param {string} entity
 * @param {string} entityId
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function auditRows(entity, entityId) {
  const { rows } = await pool.query(
    'SELECT action, payload FROM audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY id',
    [entity, entityId],
  );
  return rows;
}

/**
 * @param {string} id
 * @returns {Promise<Record<string, any>>}
 */
async function scenarioRow(id) {
  const { rows } = await pool.query(
    `SELECT id::text AS id, name, created_by::text AS created_by, params, result
       FROM scenarios WHERE id = $1::bigint`,
    [id],
  );
  return rows[0];
}

describe('scenario persistence', () => {
  it('stores a versioned snapshot, the author and one audit row in a transaction', async () => {
    const built = await scenariosService.buildScenario({ anchor: SEED_ANCHOR });
    const saved = await scenariosService.saveScenario(
      { name: '  Рост бюджета  ', anchor: SEED_ANCHOR },
      { id: '1', ip: '127.0.0.1' },
    );

    const row = await scenarioRow(saved.id);
    expect(row.name).toBe('Рост бюджета');
    expect(row.created_by).toBe('1');

    expect(row.params.schemaVersion).toBe(1);
    expect(row.params.anchor).toBe(SEED_ANCHOR);
    expect(row.params.budgetPeriod).toBe('week');
    expect(row.params.history.weeks).toBe(METRICS_CONFIG.saturation.historyWeeks);
    expect(row.params.optimizer).toEqual({ ...METRICS_CONFIG.saturation });
    expect(typeof row.params.budgetCents).toBe('string');
    // An omitted budget means "what the optimizable channels spend now": the cap base, not the all-channel total.
    const optimizableBaseline = built.channels
      .filter((channel) => channel.model === 'saturation')
      .reduce((sum, channel) => sum + BigInt(channel.current.spendCents), 0n);
    expect(row.params.budgetCents).toBe(optimizableBaseline.toString());
    expect(row.params.channelIds).toEqual(channels.map((channel) => channel.id));

    expect(row.result.channels).toHaveLength(channels.length);
    // JSONB cannot store bigint; stringifying must not throw, which a bigint inside the result would.
    expect(() => JSON.stringify(row.result)).not.toThrow();
    expect(row.result.totals.current.spendCents).toBe(built.totals.current.spendCents);

    const audit = await auditRows('scenario', saved.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe(AUDIT_ACTIONS.SCENARIO_CREATE);
    expect(audit[0].payload).toMatchObject({
      name: 'Рост бюджета',
      budgetCents: row.params.budgetCents,
    });
  });

  it('recomputes the result instead of trusting a client-sent one', async () => {
    const saved = await scenariosService.saveScenario(
      {
        name: 'Сервер считает сам',
        anchor: SEED_ANCHOR,
        // A caller cannot inject a result: the service signature has no such field and the stored row must not echo it.
        result: { channels: [], totals: null, warnings: [] },
      },
      { id: '1' },
    );

    const row = await scenarioRow(saved.id);
    expect(row.result.channels).toHaveLength(channels.length);
    expect(row.result.totals.planned.spendCents).toBe(row.params.budgetCents);
    expect(row.result.warnings).not.toEqual([]);
  });

  it('rejects a name shorter than 3 or longer than 120 characters', async () => {
    await expect(
      scenariosService.saveScenario({ name: 'ab', anchor: SEED_ANCHOR }, { id: '1' }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      scenariosService.saveScenario({ name: 'x'.repeat(121), anchor: SEED_ANCHOR }, { id: '1' }),
    ).rejects.toBeInstanceOf(ValidationError);

    const { rows } = await pool.query('SELECT count(*)::int AS total FROM scenarios');
    expect(rows[0].total).toBe(0);
  });

  it('enforces the 3× cap, warns above 2× and accepts the exact boundaries', async () => {
    const built = await scenariosService.buildScenario({ anchor: SEED_ANCHOR });
    const baseline = optimizableBaseline(built);

    const threeTimes = baseline * BigInt(METRICS_CONFIG.scenarios.maxBudgetMultiplier);
    const accepted = await scenariosService.buildScenario({
      anchor: SEED_ANCHOR,
      budgetByn: centsToBynDecimal(threeTimes),
    });
    expect(accepted.totals.planned.spendCents).toBe(threeTimes.toString());
    expect(accepted.warnings.some((warning) => warning.includes('экстраполяция'))).toBe(true);

    await expect(
      scenariosService.buildScenario({
        anchor: SEED_ANCHOR,
        budgetByn: centsToBynDecimal(threeTimes + 1n),
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const twice = baseline * BigInt(METRICS_CONFIG.scenarios.warnBudgetMultiplier);
    const atTwo = await scenariosService.buildScenario({
      anchor: SEED_ANCHOR,
      budgetByn: centsToBynDecimal(twice),
    });
    expect(atTwo.warnings.some((warning) => warning.includes('экстраполяция'))).toBe(false);

    const aboveTwo = await scenariosService.buildScenario({
      anchor: SEED_ANCHOR,
      budgetByn: centsToBynDecimal(twice + 100n),
    });
    expect(aboveTwo.warnings.some((warning) => warning.includes('экстраполяция'))).toBe(true);
  });

  it('keeps linear/no_data channels visible but out of the plan and the optimizer', async () => {
    const built = await scenariosService.buildScenario({ anchor: SEED_ANCHOR });
    const excluded = built.channels.filter((channel) => channel.model !== 'saturation');

    expect(excluded.length).toBeGreaterThan(0);
    for (const channel of excluded) {
      expect(channel.planned).toBeNull();
      expect(channel.forecast).toBeNull();
      expect(channel.note).toBeTruthy();
      expect(built.warnings.some((warning) => warning.startsWith(`${channel.channelName}:`))).toBe(true);
    }

    const optimizableIds = built.channels
      .filter((channel) => channel.model === 'saturation')
      .map((channel) => channel.channelId);
    const baselineCents = optimizableBaseline(built);
    const allCurrentCents = built.channels.reduce(
      (sum, channel) => sum + BigInt(channel.current.spendCents),
      0n,
    );
    // `current` is every selected channel; the cap base is only the saturation subset.
    expect(built.totals.current.spendCents).toBe(allCurrentCents.toString());
    expect(allCurrentCents).toBeGreaterThanOrEqual(baselineCents);

    const withoutExcluded = await scenariosService.buildScenario({
      anchor: SEED_ANCHOR,
      channelIds: optimizableIds,
      budgetByn: centsToBynDecimal(baselineCents),
    });

    expect(withoutExcluded.totals.planned).toEqual(built.totals.planned);
  });

  it('turns a spend history with fewer than eight positive weeks into a visible linear note', async () => {
    const suffix = Date.now().toString(36);
    const channelInsert = await pool.query(
      `INSERT INTO channels (code, name, kind)
       VALUES ($1, 'Линейный тест', 'paid')
       RETURNING id::text AS id`,
      [`linear_${suffix}`],
    );
    const channelId = channelInsert.rows[0].id;

    try {
      const campaign = await pool.query(
        `INSERT INTO campaigns (channel_id, code, name, started_on)
         VALUES ($1::bigint, $2, 'Линейная кампания', '2026-05-18')
         RETURNING id::text AS id`,
        [channelId, `linear_campaign_${suffix}`],
      );
      const campaignId = campaign.rows[0].id;

      // Three positive weeks inside the last four complete weeks: the linear channel's spend must appear in the
      // all-channel "current" total even though it is outside the optimizable baseline.
      for (let index = 0; index < 3; index += 1) {
        await pool.query(
          `INSERT INTO daily_stats (campaign_id, stat_date, spend_cents, impressions, clicks, leads)
           VALUES ($1::bigint, $2::date, 100000, 1000, 100, 10)`,
          [campaignId, addDays('2026-10-19', index * 7)],
        );
        await pool.query(
          `INSERT INTO customers (external_id, first_channel_id, first_campaign_id, acquired_at, first_order_at)
           VALUES ($1, $2::bigint, $3::bigint, $4::timestamptz, $4::timestamptz)`,
          [`linear_customer_${suffix}_${index}`, channelId, campaignId, `${addDays('2026-10-19', index * 7)}T12:00:00Z`],
        );
      }

      const built = await scenariosService.buildScenario({ anchor: SEED_ANCHOR });
      const linear = built.channels.find((channel) => channel.channelId === channelId);

      expect(linear.model).toBe('linear');
      expect(linear.planned).toBeNull();
      expect(linear.note).toBe('Линейная кривая — без оптимума');
      expect(built.warnings).toContain('Линейный тест: Линейная кривая — без оптимума');

      const allCurrentCents = built.channels.reduce(
        (sum, channel) => sum + BigInt(channel.current.spendCents),
        0n,
      );
      const baselineCents = optimizableBaseline(built);
      const linearCurrentCents = BigInt(linear.current.spendCents);
      expect(linearCurrentCents).toBeGreaterThan(0n);
      expect(built.totals.current.spendCents).toBe(allCurrentCents.toString());
      expect(allCurrentCents).toBeGreaterThan(baselineCents);
      // The linear spend is in "current" but not in the base the cap and warning use.
      expect(allCurrentCents - baselineCents).toBeGreaterThanOrEqual(linearCurrentCents);
    } finally {
      await pool.query('DELETE FROM customers WHERE first_channel_id = $1::bigint', [channelId]);
      await pool.query('DELETE FROM campaigns WHERE channel_id = $1::bigint', [channelId]);
      await pool.query('DELETE FROM channels WHERE id = $1::bigint', [channelId]);
    }
  });
});

describe('scenario transaction atomicity', () => {
  it('does not store a scenario when the audit insert fails', async () => {
    const failing = createScenariosService({
      db: pool,
      metricsRepository,
      channelsRepository,
      ltvService,
      auditServiceFactory: () => ({
        async record() {
          throw new Error('audit insert failed');
        },
      }),
    });

    await expect(
      failing.saveScenario({ name: 'Сценарий без аудита', anchor: SEED_ANCHOR }, { id: '1' }),
    ).rejects.toThrow('audit insert failed');

    const { rows } = await pool.query('SELECT count(*)::int AS total FROM scenarios');
    expect(rows[0].total).toBe(0);
    const audit = await pool.query("SELECT count(*)::int AS total FROM audit_log WHERE entity = 'scenario'");
    expect(audit.rows[0].total).toBe(0);
  });

  it('does not write an audit row when the scenario insert fails', async () => {
    await expect(
      scenariosService.saveScenario(
        { name: 'Сценарий без автора', anchor: SEED_ANCHOR },
        // No such user: the FK on `scenarios.created_by` rejects the insert after the snapshot was computed.
        { id: '999999' },
      ),
    ).rejects.toMatchObject({ code: '23503' });

    const { rows } = await pool.query('SELECT count(*)::int AS total FROM scenarios');
    expect(rows[0].total).toBe(0);
    const audit = await pool.query("SELECT count(*)::int AS total FROM audit_log WHERE entity = 'scenario'");
    expect(audit.rows[0].total).toBe(0);
  });
});

describe('scenario snapshot reads', () => {
  it('marks a tampered params version invalid and keeps both reads alive', async () => {
    const saved = await scenariosService.saveScenario(
      { name: 'Снимок для дрейфа', anchor: SEED_ANCHOR },
      { id: '1' },
    );

    await pool.query(`UPDATE scenarios SET params = '{"schemaVersion":99}'::jsonb WHERE id = $1::bigint`, [saved.id]);

    const detail = await scenariosService.getScenarioDetail(saved.id);
    expect(detail.invalid).toBe(true);
    expect(detail.invalidReason).toMatch(/схем/);
    expect(detail.result).toBeNull();

    const list = await scenariosService.listScenarios({ page: 1 });
    expect(list.total).toBe(1);
    expect(list.rows[0].invalid).toBe(true);

    await expect(scenariosService.getScenarioDetail('999999')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects an unknown field in the stored result instead of silently ignoring it', async () => {
    const saved = await scenariosService.saveScenario(
      { name: 'Снимок с лишним полем', anchor: SEED_ANCHOR },
      { id: '1' },
    );
    await pool.query(
      `UPDATE scenarios SET result = result || '{"extra":1}'::jsonb WHERE id = $1::bigint`,
      [saved.id],
    );

    const detail = await scenariosService.getScenarioDetail(saved.id);
    expect(detail.invalid).toBe(true);
    expect(detail.result).toBeNull();
  });

  it('returns the saved snapshot after the underlying facts and channel names change', async () => {
    const saved = await scenariosService.saveScenario(
      { name: 'Неизменный снимок', anchor: SEED_ANCHOR },
      { id: '1' },
    );
    const before = await scenariosService.getScenarioDetail(saved.id);
    const changedChannel = channels.find((channel) => before.result.channels.some((row) => row.channelId === channel.id));
    const stat = await pool.query(
      `SELECT id::text AS id, spend_cents::bigint::text AS spend_cents
         FROM daily_stats
        WHERE stat_date BETWEEN '2026-05-18' AND '2026-11-15'
        ORDER BY id
        LIMIT 1`,
    );
    const statRow = stat.rows[0];

    try {
      await pool.query("UPDATE channels SET name = 'Переименованный канал' WHERE id = $1::bigint", [
        changedChannel.id,
      ]);
      // One changed fact is enough: the detail must not refit from it, and restoring one row keeps the shared seed
      // intact for any test that runs after this one.
      await pool.query('UPDATE daily_stats SET spend_cents = spend_cents + 100000 WHERE id = $1::bigint', [
        statRow.id,
      ]);

      const after = await scenariosService.getScenarioDetail(saved.id);
      expect(after.invalid).toBe(false);
      expect(after.savedAnchor).toBe(SEED_ANCHOR);
      expect(after.result).toEqual(before.result);
    } finally {
      await pool.query('UPDATE daily_stats SET spend_cents = $2::bigint WHERE id = $1::bigint', [
        statRow.id,
        statRow.spend_cents,
      ]);
      await pool.query('UPDATE channels SET name = $2 WHERE id = $1::bigint', [changedChannel.id, changedChannel.name]);
    }
  });

  it('reads LTV once per build with the full channel list', async () => {
    const spy = vi.spyOn(ltvService, 'getChannelLtv');
    try {
      const result = await scenariosService.buildScenario({ anchor: SEED_ANCHOR });
      expect(result.channels.length).toBeGreaterThan(1);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ anchor: SEED_ANCHOR, horizonMonths: 12, channelIds: null });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('scenario list pagination', () => {
  it('returns fifty snapshots per page with hasMore', async () => {
    const built = await scenariosService.buildScenario({ anchor: SEED_ANCHOR });
    const { firstWeekStart, lastWeekStart } = resolveWeekRange(SEED_ANCHOR, METRICS_CONFIG.saturation.historyWeeks);
    const params = {
      schemaVersion: 1,
      anchor: SEED_ANCHOR,
      history: {
        from: firstWeekStart,
        to: addDays(lastWeekStart, 6),
        weeks: METRICS_CONFIG.saturation.historyWeeks,
      },
      budgetCents: built.totals.planned.spendCents,
      channelIds: built.channels.map((channel) => channel.channelId),
      optimizer: { ...METRICS_CONFIG.saturation },
      budgetPeriod: 'week',
    };

    await pool.query(
      `INSERT INTO scenarios (name, created_by, params, result)
       SELECT 'Сценарий ' || g, 1, $1::jsonb, $2::jsonb
         FROM generate_series(1, 51) AS g`,
      [JSON.stringify(params), JSON.stringify(built)],
    );

    const firstPage = await scenariosService.listScenarios({ page: 1 });
    expect(firstPage.rows).toHaveLength(50);
    expect(firstPage.total).toBe(51);
    expect(firstPage.page).toBe(1);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.rows.every((row) => row.invalid === false)).toBe(true);

    const secondPage = await scenariosService.listScenarios({ page: 2 });
    expect(secondPage.rows).toHaveLength(1);
    expect(secondPage.page).toBe(2);
    expect(secondPage.hasMore).toBe(false);
  });
});
