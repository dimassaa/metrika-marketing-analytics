import { ValidationError } from '../../lib/errors.js';
import { assertFinite } from '../../lib/metrics-math.js';
import { centsFromDb } from '../../lib/money.js';

/**
 * KKT budget split over saturation curves (metrics spec §6.2).
 *
 * For a channel with `q(b) = K·(1 − e^(−b/S))` weekly BYN spend, the marginal return is
 * `q'(b) = (K/S)·e^(−b/S)`. The unconstrained optimum of `Σ q_i(b_i)` under `Σ b_i = B` equalises the marginal
 * returns at a common `λ`, which inverts to `b_i(λ) = S_i·ln(K_i/(S_i·λ))` while `λ < K_i/S_i`, and `0`
 * otherwise. The sum is strictly decreasing in `λ` and tends to infinity as `λ → 0`, so a plain bisection on
 * `(0, max(K_i/S_i)]` always reaches any finite budget. There is deliberately no `λ_min` cut-off: such a floor
 * would fabricate infeasibility for perfectly legal budgets and reject a 3× scenario the product allows.
 *
 * Only `saturation` fits belong here. A `linear` or `no_data` channel has no marginal-return curve, and the caller
 * (scenario service) filters it out; this pure function rejects it instead of inventing a fallback.
 *
 * Money crosses the boundary as bigint kopecks: the KKT shares are BYN floats because `K` and `S` are model
 * parameters, then each share is floored to kopecks and the remaining kopecks go to the largest fractional parts.
 * The continuous shares are strictly increasing in the budget, but largest-remainder rounding can move a kopeck
 * between channels when the budget grows (Alabama paradox). The plan is therefore monotone within one kopeck, which
 * is the tightest guarantee integer kopecks allow; metrics spec §6.2 states the same tolerance.
 */

/** Fixed iteration count, not a tolerance: the result must be byte-identical between runs and processes. */
const BISECTION_ITERATIONS = 80;

/**
 * Validates one optimiser input curve.
 *
 * @param {unknown} curve
 * @returns {{ channelId: string, K: number, S: number }}
 * @throws {TypeError} When the object is not a saturation fit with positive finite `K` and `S`.
 */
function assertCurve(curve) {
  const channelId = curve?.channelId;
  if (typeof channelId !== 'string' || channelId === '') {
    throw new TypeError('budget optimiser curve.channelId must be a non-empty string');
  }
  if (curve?.model !== 'saturation') {
    throw new TypeError(`budget optimiser accepts saturation curves only, got ${String(curve?.model)}`);
  }
  const { K, S } = curve;
  if (typeof K !== 'number' || typeof S !== 'number' || !(K > 0) || !(S > 0)) {
    throw new TypeError(`budget optimiser curve ${channelId} needs positive finite K and S`);
  }
  assertFinite(K, `budget optimiser curve ${channelId} K`);
  assertFinite(S, `budget optimiser curve ${channelId} S`);
  return { channelId, K, S };
}

/**
 * Parses the budget. Integer kopecks only: a fractional or formatted value is a caller bug, not a business case.
 *
 * @param {unknown} budgetCents
 * @returns {bigint} Positive integer kopecks.
 * @throws {ValidationError} When the value is missing, non-integer, non-positive or above the exact-float range.
 */
function parseBudgetCents(budgetCents) {
  let cents;
  try {
    cents = centsFromDb(budgetCents);
  } catch {
    throw new ValidationError('Бюджет должен быть целым числом копеек');
  }
  if (cents === null || cents <= 0n) {
    throw new ValidationError('Бюджет должен быть больше нуля');
  }
  // Shares are computed in floating point, so the budget must survive `Number(...)` exactly. Real weekly campaign
  // budgets are many orders of magnitude below this; the guard keeps a corrupt value from losing kopecks silently.
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ValidationError('Бюджет слишком велик');
  }
  return cents;
}

/**
 * KKT share of one channel at a given marginal return.
 * @param {{ K: number, S: number }} curve
 * @param {number} lambda Positive marginal return in conversions per BYN.
 * @returns {number} Unrounded weekly spend in BYN; 0 when the channel is priced out by `λ`.
 */
function kktShare(curve, lambda) {
  const ratio = curve.K / curve.S;
  if (!(lambda < ratio)) return 0;
  return curve.S * Math.log(curve.K / (curve.S * lambda));
}

/**
 * Marginal return `K/S·e^(−b/S)` of a saturation curve at a weekly spend.
 *
 * Exported for the KKT check: at the optimum every allocated channel returns the same λ within rounding.
 *
 * @param {{ K: number, S: number }} curve Saturation fit.
 * @param {number} spendByn Weekly spend in BYN.
 * @returns {number} Conversions per BYN.
 * @throws {TypeError} When the curve or the spend is invalid.
 */
export function marginalReturn(curve, spendByn) {
  const { K, S } = curve ?? {};
  if (typeof K !== 'number' || typeof S !== 'number' || !(K > 0) || !(S > 0)) {
    throw new TypeError('marginalReturn needs a curve with positive finite K and S');
  }
  assertFinite(K, 'marginalReturn K');
  assertFinite(S, 'marginalReturn S');
  assertFinite(spendByn, 'marginalReturn spendByn');
  if (spendByn < 0) throw new TypeError(`marginalReturn spendByn must be non-negative, got ${spendByn}`);
  return (K / S) * Math.exp(-spendByn / S);
}

/**
 * Converts unrounded BYN shares into integer kopecks summing exactly to the budget.
 *
 * `Math.floor` alone can leave up to `n − 1` kopecks unassigned, so the remainder goes one kopeck at a time to the
 * channels with the largest fractional part (largest-remainder method). Ties break on input order, never on object
 * iteration, so the allocation is deterministic. A channel that still holds 0 kopecks receives one from the largest
 * allocation: the caller has already certified `B ≥ n`, and no channel may disappear from the plan.
 *
 * @param {number[]} sharesByn Unrounded shares in input order.
 * @param {bigint} budgetCents Budget that the shares were solved for.
 * @returns {bigint[]} Kopecks per channel in input order; sum exactly `budgetCents`.
 */
function toKopeckAllocation(sharesByn, budgetCents) {
  const centsFloat = sharesByn.map((share) => share * 100);
  const allocation = centsFloat.map((value) => BigInt(Math.floor(value)));
  const fractions = centsFloat.map((value, index) => ({ index, fraction: value - Math.floor(value) }));

  let assigned = allocation.reduce((sum, cents) => sum + cents, 0n);

  // Floating-point noise can overshoot the budget by a kopeck when a share sits exactly on an integer. Take the
  // excess from the largest allocation: every channel keeps at least 1 kopeck because the budget covers that.
  while (assigned > budgetCents) {
    let largest = 0;
    for (let index = 1; index < allocation.length; index += 1) {
      if (allocation[index] > allocation[largest]) largest = index;
    }
    if (allocation[largest] <= 1n) throw new Error('budget allocation overflowed below the one-kopeck floor');
    allocation[largest] -= 1n;
    assigned -= 1n;
  }

  fractions.sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  let cursor = 0;
  while (assigned < budgetCents) {
    const target = fractions[cursor % fractions.length].index;
    allocation[target] += 1n;
    assigned += 1n;
    cursor += 1;
  }

  for (let index = 0; index < allocation.length; index += 1) {
    if (allocation[index] > 0n) continue;
    let donor = 0;
    for (let candidate = 1; candidate < allocation.length; candidate += 1) {
      if (allocation[candidate] > allocation[donor]) donor = candidate;
    }
    if (allocation[donor] <= 1n) throw new Error('budget allocation cannot fund the one-kopeck floor');
    allocation[donor] -= 1n;
    allocation[index] += 1n;
  }

  return allocation;
}

/**
 * Splits a weekly budget across saturation curves at equal marginal return.
 *
 * @param {{
 *   curves?: Array<{ channelId: string, model: string, K: number, S: number }>,
 *   budgetCents?: bigint | string | number,
 * }} [input]
 * @returns {{
 *   allocations: Array<{ channelId: string, spendCents: bigint, spendByn: number }>,
 *   lambda: number,
 *   iterations: number,
 *   totalCents: bigint,
 *   objective: number,
 * }}
 *   `objective` is the total predicted weekly conversions at the rounded allocation; `lambda` is the common
 *   marginal return in conversions per BYN.
 * @throws {ValidationError} When the curve list is empty or the budget is not positive integer kopecks covering
 *   at least one kopeck per curve.
 * @throws {TypeError} When a curve is not a saturation fit with positive `K` and `S`.
 */
export function allocateBudget({ curves = [], budgetCents } = {}) {
  if (!Array.isArray(curves)) throw new TypeError('budget optimiser curves must be an array');

  const validated = curves.map(assertCurve);
  if (validated.length === 0) throw new ValidationError('Нет каналов с валидной кривой');

  const ids = new Set(validated.map((curve) => curve.channelId));
  if (ids.size !== validated.length) throw new TypeError('budget optimiser curves contain duplicate channelId');

  const cents = parseBudgetCents(budgetCents);
  if (cents < BigInt(validated.length)) {
    throw new ValidationError('Бюджета не хватает даже на 1 копейку каждому каналу');
  }

  const maxRatio = Math.max(...validated.map((curve) => curve.K / curve.S));
  const budgetByn = Number(cents) / 100;

  // Bisection on λ. At `high` every channel is priced out and the sum is 0; at `low → 0` the sum diverges, so the
  // bracket always contains the answer. The sum is strictly decreasing, hence a fixed iteration count is enough.
  let low = 0;
  let high = maxRatio;
  for (let iteration = 0; iteration < BISECTION_ITERATIONS; iteration += 1) {
    const mid = (low + high) / 2;
    const total = validated.reduce((sum, curve) => sum + kktShare(curve, mid), 0);
    if (total > budgetByn) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const lambda = (low + high) / 2;
  const shares = validated.map((curve) => kktShare(curve, lambda));
  for (const share of shares) assertFinite(share, 'budget optimiser share');

  // Bisection narrows λ by 2^-80, so the represented shares land within a few kopecks of a safe-integer budget. If
  // they do not, the numbers left the exact range and the rounding step would have to assign an arbitrary remainder
  // one kopeck at a time (looping for the whole budget) and return a plan that is not equalised. Fail loudly instead:
  // this is a numerical limit, not a business rule, so the caller gets a validation error rather than a silent plan.
  const shareCents = shares.reduce((sum, share) => sum + share * 100, 0);
  if (!Number.isFinite(shareCents) || Math.abs(shareCents - Number(cents)) > validated.length + 1) {
    throw new ValidationError('Бюджет вне диапазона точности оптимизатора');
  }

  const kopeckAllocation = toKopeckAllocation(shares, cents);
  const allocations = validated.map((curve, index) => ({
    channelId: curve.channelId,
    spendCents: kopeckAllocation[index],
    spendByn: Number(kopeckAllocation[index]) / 100,
  }));

  const totalCents = allocations.reduce((sum, allocation) => sum + allocation.spendCents, 0n);
  if (totalCents !== cents) throw new Error(`budget allocation lost kopecks: ${totalCents} != ${cents}`);

  const objective = allocations.reduce((sum, allocation, index) => {
    const { K, S } = validated[index];
    return sum + K * (1 - Math.exp(-allocation.spendByn / S));
  }, 0);
  assertFinite(objective, 'budget optimiser objective');

  return {
    allocations,
    lambda,
    iterations: BISECTION_ITERATIONS,
    totalCents,
    objective,
  };
}
