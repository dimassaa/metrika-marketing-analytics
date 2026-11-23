import { AUDIT_ACTIONS } from '../../config/audit-actions.js';
import { DECISIONS_CONFIG } from '../../config/decisions.js';
import { METRICS_CONFIG } from '../../config/metrics.js';
import { addDays, toDateOnly } from '../../lib/dates.js';
import { withTransaction } from '../../lib/db.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { parseBigIntId } from '../../lib/ids.js';
import { centsPercent, centsRatio, roundNumber } from '../../lib/metrics-math.js';
import { centsFromDb } from '../../lib/money.js';
import { createAlertsRepository } from '../../repositories/alerts.repo.js';
import { createAuditRepository } from '../../repositories/audit.repo.js';
import { createAuditService } from '../audit.service.js';
import { buildWeeklySeries, resolveWeekRange } from '../metrics/weekly-series.js';

/**
 * Alert windows and exact rule evaluation (metrics spec §7).
 *
 * The module is pure: it receives already-aggregated channel totals and returns candidates that a persistence layer
 * (Task 5) writes into `alerts`. No repository, no Express and no clock is imported here, so every boundary can be
 * unit-tested with hand-built kopecks. All rule comparisons use integer cross-multiplication; the decimal strings
 * in the candidate are a storage trail for `NUMERIC(14,4)`, never the input of a comparison.
 */

/** Four decimals match the `NUMERIC(14,4)` target for `alerts.value`/`threshold`; migration 006 lands in Task 5. */
const ALERT_DECIMALS = 4;

/** Alert threshold from metrics spec §7; deliberately separate from the health `watch` limit, which may move. */
const PAYBACK_LIMIT_MONTHS = 12;

/** `payback = CAC × 12 / LTV12` (metrics spec §3.3), kept as a bigint so the ratio never passes through a float. */
const MONTHS_PER_YEAR = 12n;

/** Target ROMI comes from `channels.target_romi_pct NUMERIC(10,2)::text`, i.e. at most two decimals. */
const TARGET_PERCENT_PATTERN = /^\d+(?:\.\d{1,2})?$/;

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {bigint} The same non-negative kopeck amount.
 * @throws {TypeError} When the value is not a non-negative bigint.
 */
function assertCents(value, name) {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new TypeError(`${name} must be a non-negative bigint of kopecks, got ${String(value)}`);
  }
  return value;
}

/**
 * @param {{ spendCents: bigint, newCustomers: number, revenueCents: bigint }} input
 * @param {string} name Window name used in the error.
 * @returns {void}
 * @throws {TypeError} When a field is missing or breaks the aggregate contract.
 */
function assertWindow(input, name) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError(`${name} window must be an object`);
  }
  assertCents(input.spendCents, `${name}.spendCents`);
  assertCents(input.revenueCents, `${name}.revenueCents`);
  if (!Number.isInteger(input.newCustomers) || input.newCustomers < 0) {
    throw new TypeError(
      `${name}.newCustomers must be a non-negative integer, got ${String(input.newCustomers)}`,
    );
  }
}

/**
 * Parses the target ROMI without floating point.
 *
 * `Number('1.15') * 100` can land on `114.99999999999999`; the integer split keeps the threshold exact, so
 * `ROMI = target` is recognized as "not below" for every two-decimal target the schema allows.
 *
 * @param {string | number | null | undefined} target `channels.target_romi_pct` text or an internal number.
 * @returns {number | null} Target in hundredths of a percent (`20.00` → `2000`), or null when not set.
 * @throws {TypeError} When the value is not a non-negative NUMERIC with at most two decimals.
 */
function parseTargetHundredths(target) {
  if (target === null || target === undefined) return null;

  const raw = String(target).trim();
  if (!TARGET_PERCENT_PATTERN.test(raw)) {
    throw new TypeError(
      `targetRomiPct must be a non-negative NUMERIC percent with at most two decimals, got ${JSON.stringify(target)}`,
    );
  }

  const [whole, fraction = ''] = raw.split('.');
  const hundredths = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(hundredths)) {
    throw new TypeError(`targetRomiPct is too large: ${JSON.stringify(target)}`);
  }
  return hundredths;
}

/**
 * @param {number} hundredths Target in hundredths of a percent.
 * @returns {string} Four-decimal percentage accepted by `NUMERIC(14,4)`, e.g. `2000 → '20.0000'`.
 */
function formatTargetPercent(hundredths) {
  const whole = Math.trunc(hundredths / 100);
  const fraction = hundredths % 100;
  return `${whole}.${String(fraction).padStart(2, '0')}00`;
}

/**
 * @param {number | null} value Finite value or null.
 * @returns {string} Fixed four-decimal decimal string for `NUMERIC(14,4)`.
 * @throws {TypeError} When the value is not finite, which would mean a broken rule input.
 */
function formatDecimal(value) {
  if (value === null || typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`alert value must be a finite number, got ${String(value)}`);
  }
  return roundNumber(value, ALERT_DECIMALS).toFixed(ALERT_DECIMALS);
}

/**
 * `CAC_now > CAC_prev × ratio` cross-multiplied: `S_n·C_p·den > S_p·C_n·num`.
 *
 * Every factor is a positive integer, so the comparison is exact. A float comparison would make the tests at
 * `1.2×` and `1.2× + 1 kopeck` depend on IEEE rounding instead of the rule.
 *
 * @param {{
 *   now: { spendCents: bigint, newCustomers: number },
 *   prev: { spendCents: bigint, newCustomers: number },
 *   ratio: { num: number, den: number },
 * }} input
 * @returns {boolean}
 */
function cacExceeds({ now, prev, ratio }) {
  return (
    now.spendCents * BigInt(prev.newCustomers) * BigInt(ratio.den) >
    prev.spendCents * BigInt(now.newCustomers) * BigInt(ratio.num)
  );
}

/**
 * Reporting windows for the alert rules: four complete weeks plus the four before them.
 *
 * `resolveWeekRange` owns the "only full Monday–Sunday weeks" rule; this wrapper only shifts the previous window
 * and exposes `periodStart`, the Monday that keys deduplication. The report date (`anchor`) is deliberately not
 * part of the key: recalculating the same completed window twice must hit the same `alerts` row.
 *
 * @param {string} anchor Data anchor as `YYYY-MM-DD` (metrics spec §0.1), not the system clock.
 * @param {number} [weeks] Window length in weeks, default `METRICS_CONFIG.alerts.windowWeeks`.
 * @returns {{
 *   anchor: string,
 *   weeks: number,
 *   now: { from: string, to: string, periodStart: string },
 *   prev: { from: string, to: string },
 * }}
 * @throws {ValidationError} When `weeks` is not an integer in `[1, 52]`.
 * @throws {TypeError | RangeError} When `anchor` is not a real `YYYY-MM-DD` calendar date.
 */
export function resolveAlertWindows(anchor, weeks = METRICS_CONFIG.alerts.windowWeeks) {
  const { firstWeekStart, lastWeekStart } = resolveWeekRange(anchor, weeks);

  return {
    anchor,
    weeks,
    now: {
      from: firstWeekStart,
      to: addDays(lastWeekStart, 6),
      periodStart: firstWeekStart,
    },
    prev: {
      from: addDays(firstWeekStart, -7 * weeks),
      to: addDays(firstWeekStart, -1),
    },
  };
}

/**
 * Evaluates every alert rule for one channel and one pair of windows.
 *
 * The global guard is `spend > 0 && customers > 0` in both windows. Without it a channel that simply did not run
 * would divide by zero and produce a "critical" alert; the spec explicitly forbids that false positive. When the
 * guard fails the array is empty for all rules.
 *
 * Candidate order is the spec table order. `cac_spike` is at most one candidate: when the critical fraction is
 * exceeded, its `severity` and `threshold` both move to 1.5× so the stored row explains the severity it carries.
 *
 * @param {{
 *   channel?: { targetRomiPct?: string | number | null } | null,
 *   now: { spendCents: bigint, newCustomers: number, revenueCents: bigint },
 *   prev: { spendCents: bigint, newCustomers: number, revenueCents: bigint },
 *   ltv12Cents?: bigint | null,
 *   targetRomiPct?: string | number | null,
 * }} input `channel` is accepted for call-site symmetry; when `targetRomiPct` is omitted its `targetRomiPct`
 *   is used. `ltv12Cents` is the twelve-month LTV in kopecks, `null` when the cohort cannot be measured.
 * @returns {Array<{ rule: string, severity: 'warning' | 'critical', value: string, threshold: string }>}
 * @throws {TypeError} When a window, LTV or target breaks its contract.
 */
export function evaluateChannelAlerts({
  channel = null,
  now,
  prev,
  ltv12Cents = null,
  targetRomiPct = channel?.targetRomiPct ?? null,
} = {}) {
  assertWindow(now, 'now');
  assertWindow(prev, 'prev');
  const ltvCents =
    ltv12Cents === null || ltv12Cents === undefined
      ? null
      : assertCents(ltv12Cents, 'ltv12Cents');
  const targetHundredths = parseTargetHundredths(targetRomiPct);

  if (
    now.spendCents <= 0n ||
    prev.spendCents <= 0n ||
    now.newCustomers <= 0 ||
    prev.newCustomers <= 0
  ) {
    return [];
  }

  /** @type {Array<{ rule: string, severity: 'warning' | 'critical', value: string, threshold: string }>} */
  const candidates = [];

  if (cacExceeds({ now, prev, ratio: METRICS_CONFIG.alerts.cacSpikeWarnRatio })) {
    const critical = cacExceeds({
      now,
      prev,
      ratio: METRICS_CONFIG.alerts.cacSpikeCriticalRatio,
    });
    const ratio = critical
      ? METRICS_CONFIG.alerts.cacSpikeCriticalRatio
      : METRICS_CONFIG.alerts.cacSpikeWarnRatio;
    const cacNowByn = centsRatio(
      now.spendCents,
      BigInt(now.newCustomers) * 100n,
      ALERT_DECIMALS,
    );
    const thresholdByn = centsRatio(
      prev.spendCents * BigInt(ratio.num),
      BigInt(prev.newCustomers) * BigInt(ratio.den) * 100n,
      ALERT_DECIMALS,
    );

    candidates.push({
      rule: 'cac_spike',
      severity: critical ? 'critical' : 'warning',
      value: formatDecimal(cacNowByn),
      threshold: formatDecimal(thresholdByn),
    });
  }

  // ROMI is a percentage, so the integer comparison multiplies by 10 000: (R−S)·100 / S < T/100.
  const romiPct = centsPercent(
    now.revenueCents - now.spendCents,
    now.spendCents,
    ALERT_DECIMALS,
  );
  if (
    targetHundredths !== null &&
    (now.revenueCents - now.spendCents) * 10_000n < BigInt(targetHundredths) * now.spendCents
  ) {
    candidates.push({
      rule: 'romi_below_target',
      severity: 'warning',
      value: formatDecimal(romiPct),
      threshold: formatTargetPercent(targetHundredths),
    });
  }

  if (now.revenueCents < now.spendCents) {
    candidates.push({
      rule: 'romi_negative',
      severity: 'critical',
      value: formatDecimal(romiPct),
      threshold: formatDecimal(0),
    });
  }

  if (ltvCents !== null && ltvCents > 0n && now.spendCents > BigInt(now.newCustomers) * ltvCents) {
    const paybackMonths = centsRatio(
      now.spendCents * MONTHS_PER_YEAR,
      BigInt(now.newCustomers) * ltvCents,
      ALERT_DECIMALS,
    );
    candidates.push({
      rule: 'payback_long',
      severity: 'warning',
      value: formatDecimal(paybackMonths),
      threshold: formatDecimal(PAYBACK_LIMIT_MONTHS),
    });
  }

  if (ltvCents !== null && ltvCents * BigInt(now.newCustomers) < now.spendCents) {
    const ltvCac = centsRatio(
      ltvCents * BigInt(now.newCustomers),
      now.spendCents,
      ALERT_DECIMALS,
    );
    candidates.push({
      rule: 'ltv_cac_low',
      severity: 'critical',
      value: formatDecimal(ltvCac),
      threshold: formatDecimal(1),
    });
  }

  return candidates;
}

/** A reason is free text for the audit journal only; 200 characters keeps a pasted log from filling the row. */
const MAX_REASON_LENGTH = 200;

/** @param {unknown} value @returns {number} */
function nextPage(value) {
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

/**
 * Normalises the optional dismissal reason. It is stored only in `audit_log`, never on the alert row, so the
 * validation lives at the service boundary instead of a database column.
 * @param {unknown} reason
 * @returns {string | null}
 * @throws {ValidationError} When the value is not a string or is too long.
 */
function normalizeReason(reason) {
  if (reason === null || reason === undefined) return null;
  if (typeof reason !== 'string') throw new ValidationError('Причина должна быть строкой');
  const text = reason.trim();
  if (text.length > MAX_REASON_LENGTH) {
    throw new ValidationError(`Причина не длиннее ${MAX_REASON_LENGTH} символов`);
  }
  return text === '' ? null : text;
}

/**
 * @param {string} anchor Raw data anchor.
 * @returns {string} A validated `YYYY-MM-DD` date.
 * @throws {ValidationError} When the anchor is missing or not a real calendar date.
 */
function normalizeAnchor(anchor) {
  if (anchor === null || anchor === undefined || anchor === '') {
    throw new ValidationError('Не указана отчётная дата');
  }
  try {
    return toDateOnly(anchor);
  } catch {
    throw new ValidationError('Некорректная отчётная дата');
  }
}

/**
 * Builds `channelId → revenueCents` from the default attribution model of one report.
 *
 * The report returns rows for every channel, including zero-revenue ones; the map keeps the zero as a measured value
 * (a channel with spend and customers but no attributed orders has ROMI −100 %, not "no data").
 *
 * @param {{ models: Record<string, { revenueByChannel: Array<{ channelId: string, revenueCents: string }> }> }} report
 * @returns {Map<string, bigint>}
 */
function revenueByChannel(report) {
  const model = METRICS_CONFIG.attribution.defaultModel;
  const rows = report?.models?.[model]?.revenueByChannel ?? [];
  return new Map(rows.map((row) => [row.channelId, centsFromDb(row.revenueCents) ?? 0n]));
}

/**
 * Alert persistence and lifecycle (metrics spec §7).
 *
 * The pure half of this module decides whether a rule fires. This service is the only place that combines the
 * aggregate queries, the stored rows and the audit journal, so the rule maths stays testable without a database.
 *
 * The service never holds a pool: reads use injected repositories, and the write path opens
 * `withTransaction(db, …)` and creates a repository (and an audit service) from the checked-out client. That is what
 * makes "dismiss writes the status and the audit row together" true rather than aspirational; an injected
 * `auditServiceFactory` can fail the audit write and prove the status rolled back.
 *
 * @param {{
 *   db: { connect: () => Promise<import('pg').PoolClient> },
 *   metricsRepository: ReturnType<typeof import('../../repositories/metrics.repo.js').createMetricsRepository>,
 *   channelsRepository: ReturnType<typeof import('../../repositories/channels.repo.js').createChannelsRepository>,
 *   attributionService: ReturnType<typeof import('../metrics/attribution.service.js').createAttributionService>,
 *   ltvService: ReturnType<typeof import('../metrics/ltv.service.js').createLtvService>,
 *   auditServiceFactory?: (client: import('pg').PoolClient) => ReturnType<typeof createAuditService>,
 * }} deps
 */
export function createAlertsService({
  db,
  metricsRepository,
  channelsRepository,
  attributionService,
  ltvService,
  auditServiceFactory = (client) => createAuditService({ auditRepository: createAuditRepository(client) }),
}) {
  /** Read-side repository bound to the caller's database; writes always create their own client-scoped one. */
  const alertsRepository = createAlertsRepository(db);

  return {
    /**
     * @param {string} anchor Data anchor as `YYYY-MM-DD`.
     * @returns {ReturnType<typeof resolveAlertWindows>}
     */
    resolveWindows(anchor) {
      return resolveAlertWindows(normalizeAnchor(anchor));
    },

    /**
     * Twelve complete weeks of CAC for one channel, or twelve empty weeks when no problem channel exists.
     *
     * The alert screen draws the problem channel's CAC line, and that line has to be the real weekly aggregate rather
     * than a reconstruction from alert values. The range starts from the data anchor, like every other period in the
     * app, and one indexed query serves it. A missing channel skips the query entirely and still returns the same
     * 12-bucket shape, so the chart and its table stay aligned with the requested window.
     *
     * @param {{
     *   anchor: string,
     *   channelId?: string | number | null,
     *   weeks?: number,
     * }} input
     * @returns {Promise<object[]>} `buildWeeklySeries` view-model, one bucket per complete week.
     * @throws {ValidationError} When the anchor or the channel id is invalid.
     */
    async channelCacSeries({ anchor, channelId = null, weeks = METRICS_CONFIG.dashboard.weeks }) {
      const anchorDate = normalizeAnchor(anchor);
      const { firstWeekStart, lastWeekStart } = resolveWeekRange(anchorDate, weeks);
      const weeklyRows = channelId === null || channelId === undefined || channelId === ''
        ? []
        : await metricsRepository.listWeeklySeries({
            from: firstWeekStart,
            to: addDays(lastWeekStart, 6),
            channelIds: [String(channelId)],
          });

      return buildWeeklySeries({ firstWeekStart, weeks, weeklyRows });
    },

    /**
     * Recalculates the current four-week window and maintains the alert lifecycle.
     *
     * Order matters: older active rows are resolved first, the candidates are upserted second, and only then is the
     * surviving active set compared with the rules that fired. A dismissed row is updated in place but stays
     * dismissed, and a resolved row reopens when its rule fires again.
     *
     * @param {{ anchor: string, actor?: { id?: string } | null }} input `actor` is accepted for interface symmetry;
     *   recalculation itself is not an audited event.
     * @returns {Promise<{
     *   periodStart: string,
     *   triggered: number,
     *   inserted: number,
     *   updated: number,
     *   resolved: number,
     *   keptDismissed: number,
     * }>}
     * @throws {ValidationError} When the anchor is invalid.
     */
    async recalculate({ anchor } = {}) {
      const anchorDate = normalizeAnchor(anchor);
      const windows = resolveAlertWindows(anchorDate);

      // Reads are independent and stay on the injected repositories, not on the transaction that starts below.
      const [windowTotals, channels, ltv] = await Promise.all([
        metricsRepository.listChannelWindowTotals({
          nowFrom: windows.now.from,
          nowTo: windows.now.to,
          prevFrom: windows.prev.from,
          prevTo: windows.prev.to,
        }),
        channelsRepository.listChannels(),
        ltvService.getChannelLtv({ anchor: anchorDate, horizonMonths: 12, channelIds: null }),
      ]);

      // Two windows, two reports: the rules read `now` revenue today, but the evaluator contract carries a `prev`
      // revenue too, and passing a fabricated zero would make a future rule silently wrong.
      const nowReport = await attributionService.getAttributionReport({
        from: windows.now.from,
        to: windows.now.to,
        models: [METRICS_CONFIG.attribution.defaultModel],
      });
      const prevReport = await attributionService.getAttributionReport({
        from: windows.prev.from,
        to: windows.prev.to,
        models: [METRICS_CONFIG.attribution.defaultModel],
      });
      const nowRevenue = revenueByChannel(nowReport);
      const prevRevenue = revenueByChannel(prevReport);

      const ltvByChannel = new Map(
        (ltv.rows ?? []).map((row) => [row.channelId, centsFromDb(row.ltvCents)]),
      );

      /** @type {Map<string, { now: object, prev: object }>} */
      const windowsByChannel = new Map();
      for (const row of windowTotals) {
        const entry = windowsByChannel.get(row.channelId) ?? {};
        entry[row.window] = row;
        windowsByChannel.set(row.channelId, entry);
      }

      const zeroWindow = { spendCents: 0n, newCustomers: 0 };
      const candidates = [];
      for (const channel of channels) {
        const entry = windowsByChannel.get(channel.id);
        const now = entry?.now ?? zeroWindow;
        const prev = entry?.prev ?? zeroWindow;
        // The SQL pivot already zero-fills idle channels; this fallback only covers a channel that disappeared from
        // the aggregate between two statements. The evaluator's guard then keeps every rule silent for it.
        const channelCandidates = evaluateChannelAlerts({
          channel,
          now: { ...now, revenueCents: nowRevenue.get(channel.id) ?? 0n },
          prev: { ...prev, revenueCents: prevRevenue.get(channel.id) ?? 0n },
          ltv12Cents: ltvByChannel.get(channel.id) ?? null,
        });

        for (const candidate of channelCandidates) {
          candidates.push({
            channelId: channel.id,
            rule: candidate.rule,
            periodStart: windows.now.periodStart,
            severity: candidate.severity,
            value: candidate.value,
            threshold: candidate.threshold,
          });
        }
      }

      return withTransaction(db, async (client) => {
        const repository = createAlertsRepository(client);

        const resolvedPrevious = await repository.resolveActiveBefore(windows.now.periodStart);
        const upsert = await repository.upsertAlerts(candidates);

        // `triggeredKeys` is the only source of "what is alive": after the upsert, active rows whose key did not fire
        // are stale. Reading the set after the upsert also means a rule that just reopened a resolved row is kept.
        const activeRows = await repository.listCurrentPeriodActive(windows.now.periodStart);
        const triggeredKeys = new Set(candidates.map((row) => `${row.channelId}|${row.rule}`));
        const staleIds = activeRows
          .filter((row) => !triggeredKeys.has(`${row.channelId}|${row.rule}`))
          .map((row) => row.id);
        const resolvedStale = await repository.resolveAlerts(staleIds);

        return {
          periodStart: windows.now.periodStart,
          triggered: candidates.length,
          inserted: upsert.inserted,
          updated: upsert.updated,
          resolved: resolvedPrevious + resolvedStale,
          keptDismissed: upsert.dismissed,
        };
      });
    },

    /**
     * One page of alerts plus the unfiltered summary.
     * @param {{
     *   filters?: { status?: string | null, severity?: string | null, channelId?: string | null },
     *   page?: number,
     * }} [input]
     * @returns {ReturnType<typeof alertsRepository.listAlerts>}
     */
    async list({ filters = {}, page = 1 } = {}) {
      return alertsRepository.listAlerts({
        filters,
        page: nextPage(page),
        limit: DECISIONS_CONFIG.alertsPageSize,
      });
    },

    /**
     * Dismisses one active alert and records `alert.dismiss` in the same transaction.
     *
     * The reason is part of the audit payload only; the alert row keeps no free text. A second dismissal is a
     * validation error, not a silent success, so the UI cannot claim a change that did not happen and the journal
     * never receives a duplicate entry.
     *
     * @param {{
     *   id: string,
     *   reason?: string | null,
     *   actor?: { id?: string, ip?: string } | null,
     * }} input
     * @returns {Promise<{ id: string, status: 'dismissed', channelId: string, rule: string, periodStart: string }>}
     * @throws {NotFoundError} When the alert does not exist.
     * @throws {ValidationError} When the id or reason is invalid or the alert is already closed.
     */
    async dismiss({ id, reason = null, actor = null }) {
      const alertId = parseBigIntId(id);
      if (alertId === null) throw new ValidationError('Некорректный идентификатор алерта');
      const normalizedReason = normalizeReason(reason);

      return withTransaction(db, async (client) => {
        const repository = createAlertsRepository(client);
        const alert = await repository.findAlertById(alertId);
        if (!alert) throw new NotFoundError('Алерт не найден');
        if (alert.status !== 'active') throw new ValidationError('Алерт уже закрыт');

        const dismissed = await repository.dismissAlert(alertId);
        // A concurrent dismissal between the read and the update is still "already closed"; do not fall through to
        // the audit write with a row whose status did not change.
        if (!dismissed) throw new ValidationError('Алерт уже закрыт');

        const auditService = auditServiceFactory(client);
        await auditService.record({
          userId: actor?.id ?? null,
          action: AUDIT_ACTIONS.ALERT_DISMISS,
          entity: 'alert',
          entityId: alertId,
          payload: {
            channelId: alert.channelId,
            rule: alert.rule,
            periodStart: alert.periodStart,
            severity: alert.severity,
            reason: normalizedReason,
          },
          ip: actor?.ip ?? null,
        });

        return dismissed;
      });
    },
  };
}
