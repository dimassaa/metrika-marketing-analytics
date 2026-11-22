import { toDateOnly } from '../../lib/dates.js';
import { ValidationError } from '../../lib/errors.js';
import {
  formatCentsToByn,
  formatInteger,
  formatMonths,
  formatRatio,
  formatRomi,
} from '../../lib/format.js';
import { centsPercent, percentChange, roundNumber } from '../../lib/metrics-math.js';
import { centsFromDb, parseBynToCents } from '../../lib/money.js';
import { resolvePeriod } from '../../lib/periods.js';
import { computeLtvCac, computePayback, computeRomi } from './romi.service.js';

/**
 * Metric contract for a goal: Russian name, storage unit, and whether a smaller or a larger number is better.
 *
 * Mirrors the CHECK constraint of `goals.metric` and the `METRIC_LABELS` of the M2 goal list. The labels are repeated
 * instead of imported because `goals.service.js` keeps them private; they must stay byte-identical to avoid two
 * screens naming the same metric differently.
 */
const GOAL_METRICS = Object.freeze({
  cac: { label: 'CAC', unit: 'cents', direction: 'lower_is_better' },
  romi: { label: 'ROMI', unit: 'percent', direction: 'higher_is_better' },
  ltv_cac: { label: 'LTV:CAC', unit: 'ratio', direction: 'higher_is_better' },
  payback: { label: 'Payback', unit: 'months', direction: 'lower_is_better' },
  new_customers: { label: 'Новые клиенты', unit: 'count', direction: 'higher_is_better' },
});

/** Display for an absent value; the templates append the unit themselves, so this is a real em dash, not `0`. */
const EM_DASH = '—';

/**
 * @param {unknown} value NUMERIC text of `goals.target_value`.
 * @param {string} metric
 * @returns {number}
 * @throws {TypeError} When the stored value is not a finite number.
 */
function toFiniteNumber(value, metric) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new TypeError(`goal target_value for ${metric} must be numeric, got ${JSON.stringify(value)}`);
  }
  return numeric;
}

/**
 * Converts `goals.target_value` into the view-model value and the internal comparison value.
 *
 * CAC is the only money unit: it goes through `parseBynToCents` so the plan is an exact kopeck count and leaves as a
 * decimal string, never through `Number('50,00')`. The other units are already numbers in the column.
 *
 * @param {string} metric
 * @param {string} targetValue Exact decimal string from the repository.
 * @returns {{ value: string | number, unit: string, label: string, compare: bigint | number }}
 * @throws {TypeError} When the metric or its stored value breaks the contract.
 */
function buildTarget(metric, targetValue) {
  switch (metric) {
    case 'cac': {
      const cents = parseBynToCents(targetValue);
      return { value: cents.toString(), unit: 'cents', label: formatCentsToByn(cents), compare: cents };
    }
    case 'romi': {
      const value = toFiniteNumber(targetValue, metric);
      // The plan follows the same signed one-decimal ROMI contract as the fact, so a column of plans and facts
      // reads consistently.
      return { value, unit: 'percent', label: formatRomi(value), compare: value };
    }
    case 'ltv_cac': {
      const value = toFiniteNumber(targetValue, metric);
      // Two decimals, matching the M2 goal list: the same plan must not read `3,000` on one screen and `3,00` on
      // the other.
      return { value, unit: 'ratio', label: formatRatio(value, { decimals: 2 }), compare: value };
    }
    case 'payback': {
      const value = toFiniteNumber(targetValue, metric);
      return { value, unit: 'months', label: `${formatMonths(value)} мес.`, compare: value };
    }
    case 'new_customers': {
      const value = toFiniteNumber(targetValue, metric);
      if (!Number.isInteger(value)) {
        throw new TypeError(`new_customers goal target must be an integer, got ${JSON.stringify(targetValue)}`);
      }
      return { value, unit: 'count', label: formatInteger(value), compare: value };
    }
    default:
      throw new TypeError(`unknown goal metric: ${String(metric)}`);
  }
}

/**
 * Reads the fact of one metric from a health row. `null` means the metric is not measurable for this scope, which is
 * different from a measured zero (`new_customers`).
 *
 * The displayed value/label stay at the health report's display precision, but `compare` is recomputed from the
 * kopeck fields with the same guard-digit helpers the health status uses. A ratio of `2.9996` displays as `3,000`
 * and a ROMI of `-0.004%` as `0,0%`; deciding a goal on those rounded numbers would mark the goal `on_track` while
 * the channel is `watch`/`risk`.
 *
 * @param {string} metric
 * @param {object} row Health row produced by `getChannelHealthReport`.
 * @returns {{ value: string | number | null, unit: string, label: string, compare: bigint | number | null }}
 * @throws {TypeError} When a measured value breaks the health-row contract.
 */
function buildFact(metric, row) {
  switch (metric) {
    case 'cac': {
      // `centsFromDb` validates the kopeck string instead of letting `BigInt` throw a bare SyntaxError.
      const cents = centsFromDb(row.cacCents);
      if (cents === null) {
        return { value: null, unit: 'cents', label: EM_DASH, compare: null };
      }
      return { value: row.cacCents, unit: 'cents', label: row.cacLabel ?? formatCentsToByn(cents), compare: cents };
    }
    case 'romi': {
      const value = measuredNumber(row.romiPct, 'percent');
      if (value === null) return { value: null, unit: 'percent', label: EM_DASH, compare: null };
      const exact = computeRomi({
        revenueCents: requireCents(row, 'revenueCents', metric),
        spendCents: requireCents(row, 'spendCents', metric),
      });
      if (exact === null) {
        throw new TypeError(`health row reports a ROMI value with undefined revenue/spend for ${metric}`);
      }
      return { value, unit: 'percent', label: row.romiLabel ?? formatRomi(value), compare: exact };
    }
    case 'ltv_cac': {
      const value = measuredNumber(row.ltvCacRatio, 'ratio');
      if (value === null) return { value: null, unit: 'ratio', label: EM_DASH, compare: null };
      const exact = computeLtvCac({
        ltv12Cents: requireCents(row, 'ltv12Cents', metric),
        cacCents: requireCents(row, 'cacCents', metric),
      });
      if (exact === null) {
        throw new TypeError(`health row reports an LTV:CAC value with an undefined ratio for ${metric}`);
      }
      return { value, unit: 'ratio', label: row.ratioLabel ?? formatRatio(value), compare: exact };
    }
    case 'payback': {
      const value = measuredNumber(row.paybackMonths, 'months');
      if (value === null) return { value: null, unit: 'months', label: EM_DASH, compare: null };
      const exact = computePayback({
        cacCents: requireCents(row, 'cacCents', metric),
        ltv12Cents: requireCents(row, 'ltv12Cents', metric),
      });
      if (exact === null) {
        throw new TypeError(`health row reports a payback value with an undefined CAC/LTV for ${metric}`);
      }
      return { value, unit: 'months', label: row.paybackLabel ?? `${formatMonths(value)} мес.`, compare: exact };
    }
    case 'new_customers': {
      if (!Number.isInteger(row.newCustomers) || row.newCustomers < 0) {
        throw new TypeError(`health row newCustomers must be a non-negative integer, got ${String(row.newCustomers)}`);
      }
      return {
        value: row.newCustomers,
        unit: 'count',
        label: formatInteger(row.newCustomers),
        compare: row.newCustomers,
      };
    }
    default:
      throw new TypeError(`unknown goal metric: ${String(metric)}`);
  }
}

/**
 * @param {number | null | undefined} value Measured value of a percentage, ratio or month metric.
 * @param {string} unit
 * @returns {number | null}
 * @throws {TypeError} When a present value is not a finite number.
 */
function measuredNumber(value, unit) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`health row value for ${unit} must be a finite number, got ${String(value)}`);
  }
  return value;
}

/**
 * Reads a kopeck field that the exact comparison needs. A health row always carries spend/revenue/CAC/LTV as
 * kopeck strings; a partial row without them cannot decide a goal exactly, so it fails loudly instead of silently
 * falling back to the display-rounded value.
 *
 * @param {object} row
 * @param {string} field
 * @param {string} metric
 * @returns {bigint}
 * @throws {TypeError} When the field is missing or not an integer kopeck string.
 */
function requireCents(row, field, metric) {
  const cents = centsFromDb(row[field]);
  if (cents === null) {
    throw new TypeError(`health row for ${metric} must carry ${field} to decide the goal exactly`);
  }
  return cents;
}

/**
 * Exactness of the machine-readable `deviation.abs`. It keeps the same guard digits as the value it was derived
 * from, so a ratio gap of `0.0004` stays positive instead of being rounded to `0` by the display precision.
 */
const DEVIATION_DECIMALS = Object.freeze({
  romi: 4,
  ltv_cac: 6,
  payback: 6,
  new_customers: 0,
});

/**
 * @param {string} metric
 * @param {bigint | number | null} gap Directional gap: positive means "behind the plan".
 * @returns {string} Display string in the metric unit.
 */
function formatGap(metric, gap) {
  switch (metric) {
    case 'cac':
      return formatCentsToByn(gap);
    case 'romi':
      return formatRomi(gap);
    case 'ltv_cac':
      return formatRatio(gap);
    case 'payback':
      return `${formatMonths(gap)} мес.`;
    case 'new_customers':
      return formatInteger(gap);
    default:
      throw new TypeError(`unknown goal metric: ${String(metric)}`);
  }
}

/**
 * Signed percent change of the fact against the plan. CAC is a bigint kopeck pair, so it goes through
 * `centsPercent`; the other metrics are already numbers and cannot be converted kopeck-by-kopeck.
 *
 * @param {{ compare: bigint | number }} fact
 * @param {{ compare: bigint | number }} target
 * @returns {number | null}
 */
function deviationPercent(fact, target) {
  if (typeof fact.compare === 'bigint' && typeof target.compare === 'bigint') {
    return centsPercent(fact.compare - target.compare, target.compare);
  }
  return percentChange(fact.compare, target.compare);
}

/**
 * Deviation of the fact from the plan.
 *
 * `abs` is directional and always reads "how far behind": `fact - target` for a lower-is-better metric and
 * `target - fact` for a higher-is-better one, so a positive number is a problem on every screen. It keeps guard
 * precision so a tiny gap does not collapse to zero; `label` is the rounded display version. `pct` is
 * `percentChange(fact, target)`, the signed change of the fact against the plan; the UI combines it with `direction`
 * to pick the tone. Money stays a kopeck string, everything else is a number.
 *
 * @param {string} metric
 * @param {'lower_is_better' | 'higher_is_better'} direction
 * @param {{ compare: bigint | number }} target
 * @param {{ compare: bigint | number } | null} fact
 * @returns {{ abs: string | number | null, pct: number | null, label: string }}
 */
function buildDeviation(metric, direction, target, fact) {
  if (fact === null || fact.compare === null) {
    return { abs: null, pct: null, label: EM_DASH };
  }

  const gap =
    direction === 'lower_is_better' ? fact.compare - target.compare : target.compare - fact.compare;
  // Round once at guard precision: `12.004 - 12` is `0.004000000000000227` in a float, and passing that raw value
  // to a text formatter would print the artefact as if it were a measured month count.
  const exactGap = metric === 'cac' ? gap : roundNumber(gap, DEVIATION_DECIMALS[metric]);

  return {
    abs: metric === 'cac' ? exactGap.toString() : exactGap,
    pct: deviationPercent(fact, target),
    label: formatGap(metric, exactGap),
  };
}

/**
 * @param {'lower_is_better' | 'higher_is_better'} direction
 * @param {{ compare: bigint | number }} target
 * @param {{ compare: bigint | number } | null} fact
 * @returns {'on_track' | 'off_track' | 'no_data'} Equality counts as on track: the plan is met.
 */
function buildStatus(direction, target, fact) {
  if (fact === null || fact.compare === null) return 'no_data';
  if (direction === 'lower_is_better') {
    return fact.compare <= target.compare ? 'on_track' : 'off_track';
  }
  return fact.compare >= target.compare ? 'on_track' : 'off_track';
}

/**
 * Goal progress (BO-10; design §8): plan, fact and deviation for every goal of the reporting period.
 *
 * Only goals whose `[period_start, period_end]` is exactly the requested `[from, to]` are compared. A goal for a
 * different window would put a plan for twelve months next to a fact for thirty days; the resulting "deviation"
 * would be arithmetically correct and analytically meaningless, so such a goal is left out instead of guessed at.
 *
 * The fact comes from the single health report of the period: a channel goal reads its own row and a company-wide
 * goal reads `blended`, so the fact on the goals screen is the same number the dashboard and the channel table show.
 *
 * @param {{
 *   goalsRepository: ReturnType<typeof import('../../repositories/goals.repo.js').createGoalsRepository>,
 *   healthService: { getChannelHealthReport: Function },
 * }} deps
 */
export function createGoalsProgressService({ goalsRepository, healthService }) {
  return {
    /**
     * @param {{ anchor: string, from?: string | null, to?: string | null, metric?: string | null }} request
     * @returns {Promise<{
     *   period: { from: string, to: string, days: number, anchor: string },
     *   rows: Array<{
     *     goalId: string, metric: string, metricLabel: string,
     *     channelId: string | null, channelLabel: string,
     *     goalPeriod: { from: string, to: string }, factPeriod: { from: string, to: string },
     *     target: { value: string | number, unit: string, label: string },
     *     fact: { value: string | number | null, unit: string, label: string },
     *     deviation: { abs: string | number | null, pct: number | null, label: string },
     *     direction: 'lower_is_better' | 'higher_is_better',
     *     favorable: boolean | null,
     *     status: 'on_track' | 'off_track' | 'no_data',
     *   }>,
     * }>} JSON-safe view-model; money as kopeck strings.
     * @throws {ValidationError} When the anchor, period or metric is invalid.
     * @throws {TypeError} When a goal row breaks the metric contract.
     */
    async getGoalsProgress({ anchor, from = null, to = null, metric = null } = {}) {
      if (metric !== null && metric !== undefined && !Object.hasOwn(GOAL_METRICS, metric)) {
        throw new ValidationError('Неизвестная метрика цели');
      }

      const period = resolvePeriod({ anchor, from, to });
      const anchorDate = toDateOnly(anchor);

      // Both reads are period-scoped: one goal list and one health report for the whole screen.
      const goals = await goalsRepository.listGoals({ metric: metric ?? null });
      const healthReport = await healthService.getChannelHealthReport({
        anchor,
        from: period.from,
        to: period.to,
      });

      const rows = goals
        .filter((goal) => goal.periodStart === period.from && goal.periodEnd === period.to)
        .map((goal) => {
          const metricView = Object.hasOwn(GOAL_METRICS, goal.metric)
            ? GOAL_METRICS[goal.metric]
            : undefined;
          if (metricView === undefined) {
            throw new TypeError(`goal ${goal.id} has an unknown metric: ${String(goal.metric)}`);
          }

          const healthRow =
            goal.channelId === null
              ? healthReport.blended
              : healthReport.rows.find((row) => row.channelId === goal.channelId);

          const target = buildTarget(goal.metric, goal.targetValue);
          const fact = healthRow ? buildFact(goal.metric, healthRow) : null;
          const status = buildStatus(metricView.direction, target, fact);

          return {
            goalId: goal.id,
            metric: goal.metric,
            metricLabel: metricView.label,
            channelId: goal.channelId,
            channelLabel: goal.channelId === null ? 'Вся компания' : goal.channelName ?? EM_DASH,
            goalPeriod: { from: goal.periodStart, to: goal.periodEnd },
            factPeriod: { from: period.from, to: period.to },
            target: { value: target.value, unit: target.unit, label: target.label },
            fact: fact
              ? { value: fact.value, unit: fact.unit, label: fact.label }
              : { value: null, unit: metricView.unit, label: EM_DASH },
            deviation: buildDeviation(goal.metric, metricView.direction, target, fact),
            direction: metricView.direction,
            // A single boolean for the tone: the signed `deviation.label` must not be read as good/bad on its own.
            favorable: status === 'no_data' ? null : status === 'on_track',
            status,
          };
        });

      return {
        period: { from: period.from, to: period.to, days: period.days, anchor: anchorDate },
        rows,
      };
    },
  };
}
