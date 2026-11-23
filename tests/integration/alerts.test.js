import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '../../src/config/audit-actions.js';
import { addDays } from '../../src/lib/dates.js';
import { ValidationError } from '../../src/lib/errors.js';
import { createAlertsRepository } from '../../src/repositories/alerts.repo.js';
import { createAttributionRepository } from '../../src/repositories/attribution.repo.js';
import { createChannelsRepository } from '../../src/repositories/channels.repo.js';
import { createCohortsRepository } from '../../src/repositories/cohorts.repo.js';
import { createMetricsRepository } from '../../src/repositories/metrics.repo.js';
import { createAlertsService } from '../../src/services/decisions/alerts.service.js';
import { createAttributionService } from '../../src/services/metrics/attribution.service.js';
import { createLtvService } from '../../src/services/metrics/ltv.service.js';
import { clearDecisionTables, SEED_ANCHOR, seedDecisions } from '../helpers/decisionSeeds.js';
import { closeTestPool, getTestPool } from '../helpers/db.js';

/** @type {import('pg').Pool} */
let pool;
/** @type {ReturnType<typeof createAlertsService>} */
let alertsService;
/** @type {ReturnType<typeof createMetricsRepository>} */
let metricsRepository;
/** @type {ReturnType<typeof createChannelsRepository>} */
let channelsRepository;
/** @type {ReturnType<typeof createAlertsRepository>} */
let alertsRepository;
/** @type {Array<{ id: string, code: string, name: string }>} */
let channels;

beforeAll(async () => {
  await seedDecisions();
  pool = getTestPool();
  metricsRepository = createMetricsRepository(pool);
  channelsRepository = createChannelsRepository(pool);
  alertsRepository = createAlertsRepository(pool);

  const attributionService = createAttributionService({
    attributionRepository: createAttributionRepository(pool),
    metricsRepository,
    channelsRepository,
  });
  const ltvService = createLtvService({ cohortsRepository: createCohortsRepository(pool) });

  alertsService = createAlertsService({
    db: pool,
    metricsRepository,
    channelsRepository,
    attributionService,
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
 * @param {string} periodStart
 * @returns {Promise<Set<string>>} `channelId|rule` keys that already have a row of the period in any status.
 */
async function periodKeys(periodStart) {
  const { rows } = await pool.query(
    'SELECT channel_id::text AS channel_id, rule FROM alerts WHERE period_start = $1::date',
    [periodStart],
  );
  return new Set(rows.map((row) => `${row.channel_id}|${row.rule}`));
}

describe('alert recalculation', () => {
  it('deduplicates a repeated recalculation on the real unique key and refreshes detected_at', async () => {
    const windows = alertsService.resolveWindows(SEED_ANCHOR);
    const first = await alertsService.recalculate({ anchor: SEED_ANCHOR });

    expect(first.periodStart).toBe('2026-10-19');
    expect(first.triggered).toBeGreaterThan(0);
    expect(first.inserted).toBe(first.triggered);
    expect(first.updated).toBe(0);

    const countAfterFirst = await pool.query('SELECT count(*)::int AS total FROM alerts');
    expect(countAfterFirst.rows[0].total).toBe(first.triggered);

    // A deterministic time travel: the second run must touch detected_at regardless of how fast the test executes.
    await pool.query("UPDATE alerts SET detected_at = '2020-01-01T00:00:00Z'");

    const second = await alertsService.recalculate({ anchor: SEED_ANCHOR });
    const countAfterSecond = await pool.query('SELECT count(*)::int AS total FROM alerts');

    expect(second.triggered).toBe(first.triggered);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(first.triggered);
    expect(countAfterSecond.rows[0].total).toBe(countAfterFirst.rows[0].total);

    const { rows } = await pool.query(
      'SELECT period_start::text AS period_start, detected_at FROM alerts ORDER BY id',
    );
    expect(rows.every((row) => row.period_start === windows.now.periodStart)).toBe(true);
    expect(rows.every((row) => row.detected_at > new Date('2020-01-01T00:00:00Z'))).toBe(true);
  });

  it('resolves an alert when its rule stops firing and keeps a dismissed row dismissed', async () => {
    const windows = alertsService.resolveWindows(SEED_ANCHOR);
    const first = await alertsService.recalculate({ anchor: SEED_ANCHOR });
    expect(first.triggered).toBeGreaterThan(0);

    const active = await alertsRepository.listCurrentPeriodActive(windows.now.periodStart);
    expect(active.length).toBeGreaterThan(0);
    const target = active[0];

    const dismissed = await alertsService.dismiss({
      id: target.id,
      reason: 'Проверено вручную',
      actor: { id: '1', ip: '127.0.0.1' },
    });
    expect(dismissed.status).toBe('dismissed');

    const again = await alertsService.recalculate({ anchor: SEED_ANCHOR });
    expect(again.keptDismissed).toBeGreaterThan(0);

    const stored = await alertsRepository.findAlertById(target.id);
    expect(stored.status).toBe('dismissed');

    const audit = await auditRows('alert', target.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe(AUDIT_ACTIONS.ALERT_DISMISS);
    expect(audit[0].payload).toMatchObject({ reason: 'Проверено вручную', rule: target.rule });
  });
});

describe('alert lifecycle', () => {
  it('closes previous periods, stale current rows and reopens a resolved candidate', async () => {
    const windows = alertsService.resolveWindows(SEED_ANCHOR);
    const previousPeriod = addDays(windows.now.periodStart, -7);

    const old = await pool.query(
      `INSERT INTO alerts (channel_id, rule, period_start, severity, value, threshold)
       VALUES ($1::bigint, 'romi_negative', $2::date, 'critical', '0.0000', '0.0000')
       RETURNING id::text AS id`,
      [channels[0].id, previousPeriod],
    );
    const oldId = old.rows[0].id;

    const first = await alertsService.recalculate({ anchor: SEED_ANCHOR });
    expect(first.triggered).toBeGreaterThan(0);

    const oldRow = await alertsRepository.findAlertById(oldId);
    expect(oldRow.status).toBe('resolved');

    // A row of the current period whose rule does not fire is stale after the recalculation. It must be active before
    // the run so the test proves the `staleIds` subtraction, not just the previous-period sweep.
    const existingKeys = await periodKeys(windows.now.periodStart);
    const rules = ['cac_spike', 'romi_below_target', 'romi_negative', 'payback_long', 'ltv_cac_low'];
    let staleKey = null;
    for (const channel of channels) {
      for (const rule of rules) {
        const key = `${channel.id}|${rule}`;
        if (!existingKeys.has(key)) {
          staleKey = { channelId: channel.id, rule };
          break;
        }
      }
      if (staleKey) break;
    }
    expect(staleKey).not.toBeNull();

    const stale = await pool.query(
      `INSERT INTO alerts (channel_id, rule, period_start, severity, value, threshold, status)
       VALUES ($1::bigint, $2, $3::date, 'warning', '1.0000', '1.0000', 'active')
       RETURNING id::text AS id`,
      [staleKey.channelId, staleKey.rule, windows.now.periodStart],
    );

    const second = await alertsService.recalculate({ anchor: SEED_ANCHOR });
    expect(second.resolved).toBeGreaterThanOrEqual(1);
    const staleRow = await alertsRepository.findAlertById(stale.rows[0].id);
    expect(staleRow.status).toBe('resolved');

    // A fired rule that had been resolved comes back to active on the next run.
    const triggered = await alertsRepository.listCurrentPeriodActive(windows.now.periodStart);
    expect(triggered.length).toBeGreaterThan(0);
    const reopenId = triggered[0].id;
    await pool.query("UPDATE alerts SET status = 'resolved' WHERE id = $1::bigint", [reopenId]);

    const third = await alertsService.recalculate({ anchor: SEED_ANCHOR });
    expect(third.updated).toBeGreaterThan(0);
    const reopened = await alertsRepository.findAlertById(reopenId);
    expect(reopened.status).toBe('active');
  });

  it('keeps every channel in both four-week windows and zero-fills idle channels', async () => {
    const windows = alertsService.resolveWindows(SEED_ANCHOR);
    const totals = await metricsRepository.listChannelWindowTotals({
      nowFrom: windows.now.from,
      nowTo: windows.now.to,
      prevFrom: windows.prev.from,
      prevTo: windows.prev.to,
    });

    // The SQL pivot returns a row pair per channel even when a channel has no statistics at all.
    expect(totals).toHaveLength(channels.length * 2);
    for (const channel of channels) {
      const rows = totals.filter((row) => row.channelId === channel.id);
      expect(rows.map((row) => row.window).sort()).toEqual(['now', 'prev']);
    }

    // The two windows are separate aggregates, not the same query twice: a paid channel spends a different amount in
    // the current four weeks than in the four before them.
    const paid = totals.find((row) => row.window === 'now' && row.spendCents > 0n);
    expect(paid).toBeDefined();
    const paidNow = paid.spendCents;
    const paidPrev = totals.find((row) => row.channelId === paid.channelId && row.window === 'prev').spendCents;
    expect(paidNow).not.toBe(paidPrev);

    const idleCodes = ['email', 'seo'];
    for (const code of idleCodes) {
      const channel = channels.find((row) => row.code === code);
      const idle = totals.filter((row) => row.channelId === channel.id);
      expect(idle).toHaveLength(2);
      expect(idle.every((row) => row.spendCents === 0n)).toBe(true);
    }

    // Free channels have customers but no spend, so the guard keeps every rule silent for them.
    await alertsService.recalculate({ anchor: SEED_ANCHOR });
    const idleIds = channels.filter((row) => idleCodes.includes(row.code)).map((row) => row.id);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS total FROM alerts WHERE channel_id = ANY($1::bigint[])',
      [idleIds],
    );
    expect(rows[0].total).toBe(0);
  });
});

describe('alert dismissal transaction', () => {
  it('rolls the status back when the audit write fails and never audits a second dismissal', async () => {
    const windows = alertsService.resolveWindows(SEED_ANCHOR);
    await alertsService.recalculate({ anchor: SEED_ANCHOR });
    const active = await alertsRepository.listCurrentPeriodActive(windows.now.periodStart);
    expect(active.length).toBeGreaterThan(0);
    const target = active[0];

    const failingService = createAlertsService({
      db: pool,
      metricsRepository,
      channelsRepository,
      attributionService: {
        async getAttributionReport() {
          throw new Error('reads must not happen during dismiss');
        },
      },
      ltvService: {
        async getChannelLtv() {
          throw new Error('reads must not happen during dismiss');
        },
      },
      auditServiceFactory: () => ({
        async record() {
          throw new Error('audit insert failed');
        },
      }),
    });

    await expect(
      failingService.dismiss({ id: target.id, reason: 'Сбой аудита', actor: { id: '1' } }),
    ).rejects.toThrow('audit insert failed');

    const unchanged = await alertsRepository.findAlertById(target.id);
    expect(unchanged.status).toBe('active');
    expect(await auditRows('alert', target.id)).toHaveLength(0);

    await alertsService.dismiss({ id: target.id, reason: 'Настоящая причина', actor: { id: '1' } });

    const closed = await alertsRepository.findAlertById(target.id);
    expect(closed.status).toBe('dismissed');

    const audit = await auditRows('alert', target.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toEqual({
      channelId: target.channelId,
      rule: target.rule,
      periodStart: target.periodStart,
      severity: target.severity,
      reason: 'Настоящая причина',
    });

    await expect(
      alertsService.dismiss({ id: target.id, reason: 'Повтор', actor: { id: '1' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await auditRows('alert', target.id)).toHaveLength(1);
  });

  it('rejects a reason longer than 200 characters before touching the row', async () => {
    const windows = alertsService.resolveWindows(SEED_ANCHOR);
    await alertsService.recalculate({ anchor: SEED_ANCHOR });
    const [target] = await alertsRepository.listCurrentPeriodActive(windows.now.periodStart);

    await expect(
      alertsService.dismiss({ id: target.id, reason: 'x'.repeat(201), actor: { id: '1' } }),
    ).rejects.toBeInstanceOf(ValidationError);

    const stored = await alertsRepository.findAlertById(target.id);
    expect(stored.status).toBe('active');
    expect(await auditRows('alert', target.id)).toHaveLength(0);
  });
});

describe('alert pagination', () => {
  it('returns fifty rows per page and reports hasMore', async () => {
    const rules = ['cac_spike', 'romi_below_target', 'romi_negative', 'payback_long', 'ltv_cac_low'];
    const values = [];
    for (let index = 0; index < 51; index += 1) {
      values.push({
        channelId: channels[0].id,
        rule: rules[index % rules.length],
        periodStart: addDays('2020-01-06', index * 7),
      });
    }

    for (const row of values) {
      await pool.query(
        `INSERT INTO alerts (channel_id, rule, period_start, severity, value, threshold)
         VALUES ($1::bigint, $2, $3::date, 'warning', '1.0000', '0.5000')`,
        [row.channelId, row.rule, row.periodStart],
      );
    }

    const firstPage = await alertsService.list({ page: 1 });
    expect(firstPage.rows).toHaveLength(50);
    expect(firstPage.total).toBe(51);
    expect(firstPage.page).toBe(1);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.summary.active).toBe(51);

    const secondPage = await alertsService.list({ page: 2 });
    expect(secondPage.rows).toHaveLength(1);
    expect(secondPage.page).toBe(2);
    expect(secondPage.hasMore).toBe(false);
  });
});
