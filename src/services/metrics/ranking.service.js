import { METRICS_CONFIG } from '../../config/metrics.js';
import { ValidationError } from '../../lib/errors.js';
import { RANKING_REASON_LABELS } from '../../lib/metrics-labels.js';
import { normalizeBigInt, normalizeNumber, roundNumber } from '../../lib/metrics-math.js';
import { centsFromDb } from '../../lib/money.js';

/**
 * The four ranking criteria, in the order the UI draws the stack bar. The order is part of the contract: the view
 * renders `contributions` as-is, so a reordering here is a UI change.
 */
const CRITERIA = Object.freeze(['cac', 'romi', 'ltvCac', 'newCustomers']);

/** Three decimals are 0.1 percentage points of a weight: enough for a slider, coarse enough to keep sums readable. */
const WEIGHT_DECIMALS = 3;
/** Weights are distributed in integer thousandths, so the largest-remainder step can sum them exactly. */
const WEIGHT_SCALE = 10 ** WEIGHT_DECIMALS;
/** Contributions are money-like display values: two decimals are what the stack bar and its legend show. */
const CONTRIBUTION_DECIMALS = 2;
/** Guard digits for normalised and scored values before the final display rounding. */
const SCORE_DECIMALS = 6;

/**
 * @param {Record<string, number>} weights
 * @returns {Record<string, number>} Raw weights merged with the configured defaults.
 * @throws {ValidationError} On an unknown criterion, a negative/non-finite weight or a non-positive total.
 */
function validateWeights(weights = METRICS_CONFIG.ranking.weights) {
  if (weights === null || typeof weights !== 'object' || Array.isArray(weights)) {
    throw new ValidationError('Веса критериев должны быть объектом');
  }

  for (const key of Object.keys(weights)) {
    if (!CRITERIA.includes(key)) {
      throw new ValidationError(`Неизвестный критерий веса «${key}»`);
    }
  }

  const merged = {};
  for (const criterion of CRITERIA) {
    const value = weights[criterion] === undefined ? METRICS_CONFIG.ranking.weights[criterion] : weights[criterion];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ValidationError(`Вес критерия «${criterion}» должен быть числом`);
    }
    if (value < 0) {
      throw new ValidationError(`Вес критерия «${criterion}» не может быть отрицательным`);
    }
    merged[criterion] = value;
  }

  const total = CRITERIA.reduce((sum, criterion) => sum + merged[criterion], 0);
  if (!Number.isFinite(total)) {
    // Finite operands can still overflow to Infinity; that must not turn every normalised weight into 0.
    throw new ValidationError('Сумма весов критериев слишком велика');
  }
  if (total <= 0) {
    throw new ValidationError('Сумма весов критериев должна быть больше нуля');
  }

  return merged;
}

/**
 * Renormalises criterion weights to a sum of 1 (metrics spec §4).
 *
 * Independent rounding is not enough: values like 1/2/3/5 round to 0.091, 0.182, 0.273 and 0.455, a sum of 1.001
 * that would let a channel best on every criterion score above 100. The largest-remainder method therefore rounds
 * the scaled weights to integer thousandths and hands the residual (+1 or −1 per unit) to the largest or smallest
 * fractional parts. The returned weights sum to exactly 1, and the same values are the ones used for scoring.
 *
 * Missing keys fall back to `METRICS_CONFIG.ranking.weights`, so a caller may override one criterion without
 * restating the rest. Negative, non-finite and unknown weights are rejected instead of being silently clamped or
 * ignored: a negative weight would invert a criterion, and a typo must not disappear.
 *
 * @param {Record<string, number>} [weights] Weights with `cac`, `romi`, `ltvCac`, `newCustomers`.
 * @returns {{ cac: number, romi: number, ltvCac: number, newCustomers: number }} Weights summing to exactly 1.
 * @throws {ValidationError} When the weights are invalid.
 */
export function normalizeWeights(weights = METRICS_CONFIG.ranking.weights) {
  const merged = validateWeights(weights);
  const total = CRITERIA.reduce((sum, criterion) => sum + merged[criterion], 0);

  const entries = CRITERIA.map((criterion, index) => {
    const exact = (merged[criterion] / total) * WEIGHT_SCALE;
    const whole = Math.floor(exact);
    return { criterion, index, whole, fraction: exact - whole };
  });
  let residual = WEIGHT_SCALE - entries.reduce((sum, entry) => sum + entry.whole, 0);

  // A positive residual goes to the largest fractional parts, a negative one is taken from the smallest, which is
  // largest-remainder apportionment. Ties resolve by criterion order to keep repeated calls identical.
  if (residual !== 0) {
    const step = residual > 0 ? 1 : -1;
    const order = [...entries].sort((left, right) =>
      step > 0
        ? right.fraction - left.fraction || left.index - right.index
        : left.fraction - right.fraction || left.index - right.index,
    );
    for (let index = 0; residual !== 0; index += 1) {
      order[index % order.length].whole += step;
      residual -= step;
    }
  }

  const normalized = Object.fromEntries(
    entries.map((entry) => [entry.criterion, entry.whole / WEIGHT_SCALE]),
  );

  // Adding four thousandths in floating point can land one ULP away from 1; move that ULP to the largest weight so
  // the returned weights sum exactly, not approximately.
  const sum = CRITERIA.reduce((acc, criterion) => acc + normalized[criterion], 0);
  if (sum !== 1) {
    const largest = CRITERIA.reduce(
      (best, criterion) => (normalized[criterion] > normalized[best] ? criterion : best),
      CRITERIA[0],
    );
    normalized[largest] += 1 - sum;
  }

  return normalized;
}


/**
 * @param {Record<string, number>} values Criterion values keyed by criterion code.
 * @param {string} name Field name for the error.
 * @returns {Record<string, number>} The same values.
 * @throws {TypeError} When a value is not finite.
 */
function assertFiniteCriteria(values, name) {
  for (const criterion of CRITERIA) {
    if (!Number.isFinite(values[criterion])) {
      throw new TypeError(`${name}.${criterion} must be a finite number, got ${String(values[criterion])}`);
    }
  }
  return values;
}

/**
 * Splits report rows into rankable channels and explained exclusions.
 *
 * A channel is rankable only when it has a `channelId` (the blended row never does), is not `no_data`, and carries
 * all four criteria. A missing criterion is an exclusion, not a zero: substituting zero would move the min/max of
 * the whole ranking and quietly punish the channel.
 *
 * @param {object[]} channels Health-report rows, including the blended row.
 * @returns {{
 *   candidates: Array<{ row: object, cacCents: bigint, values: Record<string, number> }>,
 *   excluded: object[],
 * }}
 */
function partitionChannels(channels) {
  const candidates = [];
  const excluded = [];

  for (const row of channels) {
    if (row.channelId === null || row.channelId === undefined) {
      excluded.push({ code: row.code, reason: 'blended', reasonLabel: RANKING_REASON_LABELS.blended });
      continue;
    }

    if (row.status === 'no_data') {
      excluded.push({
        channelId: row.channelId,
        code: row.code,
        reason: 'no_data',
        reasonLabel: RANKING_REASON_LABELS.no_data,
      });
      continue;
    }

    // CAC arrives as a decimal kopeck string from the health report, the rest already as view-model numbers.
    const cacCents = centsFromDb(row.cacCents);
    const values = {
      romi: row.romiPct,
      ltvCac: row.ltvCacRatio,
      newCustomers: row.newCustomers,
    };

    if (
      cacCents === null ||
      !Number.isFinite(values.romi) ||
      !Number.isFinite(values.ltvCac) ||
      !Number.isInteger(values.newCustomers) ||
      values.newCustomers < 0
    ) {
      excluded.push({
        channelId: row.channelId,
        code: row.code,
        reason: 'missing_criterion',
        reasonLabel: RANKING_REASON_LABELS.missing_criterion,
      });
      continue;
    }

    candidates.push({ row, cacCents, values });
  }

  return { candidates, excluded };
}

/**
 * @param {Array<{ cacCents: bigint }>} candidates
 * @returns {{ min: bigint, max: bigint }} Range of CAC across the rankable channels.
 */
function cacRange(candidates) {
  let min = candidates[0].cacCents;
  let max = candidates[0].cacCents;
  for (const candidate of candidates) {
    if (candidate.cacCents < min) min = candidate.cacCents;
    if (candidate.cacCents > max) max = candidate.cacCents;
  }
  return { min, max };
}

/**
 * @param {Array<{ values: Record<string, number> }>} candidates
 * @param {string} criterion
 * @returns {{ min: number, max: number }}
 */
function numberRange(candidates, criterion) {
  let min = candidates[0].values[criterion];
  let max = candidates[0].values[criterion];
  for (const candidate of candidates) {
    const value = candidate.values[criterion];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

/**
 * Builds the ranking view model from health-report rows (metrics spec §4; BO-04).
 *
 * The score is 0–100 and explainable: each criterion contributes `100 * weight * scored`, and the rounded
 * contributions add up to the rounded score, so the stack bar in the UI is arithmetic rather than decoration.
 * For CAC the raw `normalize` value is inverted into the scored value (`1 - norm`): cheap channels must earn the
 * points, raw normalization would reward the expensive one.
 *
 * Tie-breaking is deterministic — score descending, then CAC ascending, then code ascending — so equal scores do
 * not reshuffle between requests.
 *
 * @param {{ channels?: object[], weights?: Record<string, number> }} [input] Health rows (with the blended row)
 *   and optional criterion weights.
 * @returns {{
 *   weights: Record<string, number>,
 *   ranked: Array<{
 *     channelId: string,
 *     code: string,
 *     name: string,
 *     score: number,
 *     rank: number,
 *     contributions: Array<{
 *       criterion: 'cac' | 'romi' | 'ltvCac' | 'newCustomers',
 *       weight: number,
 *       rawValue: string | number,
 *       normalized: number,
 *       scored: number,
 *       contribution: number,
 *     }>,
 *   }>,
 *   excluded: Array<{ channelId?: string, code: string, reason: 'no_data' | 'missing_criterion' | 'blended', reasonLabel: string }>,
 * }} `ranked` is ordered by rank; `excluded` keeps the input order.
 * @throws {ValidationError} When the weights are invalid.
 * @throws {TypeError} When a report row breaks the health-report contract.
 */
export function computeRanking({ channels = [], weights } = {}) {
  const normalizedWeights = normalizeWeights(weights);

  if (channels.length === 0) {
    return { weights: normalizedWeights, ranked: [], excluded: [] };
  }

  const { candidates, excluded } = partitionChannels(channels);

  if (candidates.length === 0) {
    return { weights: normalizedWeights, ranked: [], excluded };
  }

  const ranges = {
    cac: cacRange(candidates),
    romi: numberRange(candidates, 'romi'),
    ltvCac: numberRange(candidates, 'ltvCac'),
    newCustomers: numberRange(candidates, 'newCustomers'),
  };

  const scored = candidates.map(({ row, cacCents, values }) => {
    // CAC is the only criterion where less is better, so its scored value is the complement of the normalisation.
    const normalizedCac = normalizeBigInt(cacCents, ranges.cac.min, ranges.cac.max);
    const normalized = assertFiniteCriteria(
      {
        cac: normalizedCac,
        romi: normalizeNumber(values.romi, ranges.romi.min, ranges.romi.max),
        ltvCac: normalizeNumber(values.ltvCac, ranges.ltvCac.min, ranges.ltvCac.max),
        newCustomers: normalizeNumber(values.newCustomers, ranges.newCustomers.min, ranges.newCustomers.max),
      },
      'normalized',
    );
    const scoredValues = assertFiniteCriteria(
      { ...normalized, cac: roundNumber(1 - normalizedCac, SCORE_DECIMALS) },
      'scored',
    );

    const rawValues = {
      cac: row.cacCents,
      romi: values.romi,
      ltvCac: values.ltvCac,
      newCustomers: values.newCustomers,
    };

    const contributions = CRITERIA.map((criterion) => ({
      criterion,
      weight: normalizedWeights[criterion],
      // Keep a zero as a real value; only an absent amount is null, and absent amounts were excluded above.
      rawValue: rawValues[criterion],
      normalized: normalized[criterion],
      scored: scoredValues[criterion],
      contribution: roundNumber(
        100 * normalizedWeights[criterion] * scoredValues[criterion],
        CONTRIBUTION_DECIMALS,
      ),
    }));

    const score = roundNumber(
      contributions.reduce((total, entry) => total + entry.contribution, 0),
      CONTRIBUTION_DECIMALS,
    );

    return {
      cacCents,
      view: { channelId: row.channelId, code: row.code, name: row.name, score, rank: 0, contributions },
    };
  });

  scored.sort(
    (left, right) =>
      right.view.score - left.view.score ||
      (left.cacCents < right.cacCents ? -1 : left.cacCents > right.cacCents ? 1 : 0) ||
      left.view.code.localeCompare(right.view.code),
  );

  return {
    weights: normalizedWeights,
    ranked: scored.map(({ view }, index) => ({ ...view, rank: index + 1 })),
    excluded,
  };
}

/**
 * Ranking service (BO-04).
 *
 * A pure `computeRanking` over the already-computed health report: CAC, LTV, ROMI and attribution stay single-source
 * in T1–T4, and ranking never queries the database itself.
 *
 * @param {{ healthService: { getChannelHealthReport: Function } }} deps
 */
export function createRankingService({ healthService }) {
  return {
    /**
     * @param {{ from?: string | null, to?: string | null, anchor?: string | null, weights?: Record<string, number> }} [request]
     * @returns {Promise<{
     *   period: { from: string, to: string, days: number },
     *   weights: Record<string, number>,
     *   ranked: object[],
     *   excluded: object[],
     * }>}
     * @throws {ValidationError} When the period or the weights are invalid.
     */
    async getRankingReport({ from = null, to = null, anchor = null, weights } = {}) {
      // Validate before touching the database: a bad slider value is a 400, not a reason to run three reports.
      // The weights are normalised exactly once, inside `computeRanking`, so the reported values are the scored ones.
      validateWeights(weights);

      const health = await healthService.getChannelHealthReport({ from, to, anchor });
      const ranking = computeRanking({ channels: [...health.rows, health.blended], weights });

      return { period: health.period, ...ranking };
    },
  };
}
