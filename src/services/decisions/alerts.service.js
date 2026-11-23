import { METRICS_CONFIG } from '../../config/metrics.js';
import { addDays } from '../../lib/dates.js';
import { centsPercent, centsRatio, roundNumber } from '../../lib/metrics-math.js';
import { resolveWeekRange } from '../metrics/weekly-series.js';

/**
 * Alert windows and exact rule evaluation (metrics spec §7).
 *
 * The module is pure: it receives already-aggregated channel totals and returns candidates that a persistence layer
 * (Task 5) writes into `alerts`. No repository, no Express and no clock is imported here, so every boundary can be
 * unit-tested with hand-built kopecks. All rule comparisons use integer cross-multiplication; the decimal strings
 * in the candidate are a storage trail for `NUMERIC(14,4)`, never the input of a comparison.
 */

/** `alerts.value` and `alerts.threshold` are widened to `NUMERIC(14,4)` by migration 006. */
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
