import { describe, expect, it } from 'vitest';
import { METRICS_CONFIG } from '../../src/config/metrics.js';
import { ValidationError } from '../../src/lib/errors.js';
import { allocateBudget, marginalReturn } from '../../src/services/decisions/budget-optimizer.service.js';

/**
 * Saturation curve as produced by `fitSaturationCurve`: only the three fields the optimiser may read.
 * @param {string} channelId
 * @param {number} K
 * @param {number} S
 */
function curve(channelId, K, S) {
  return { channelId, model: 'saturation', K, S };
}

/** The two curves from the brief: both reach their knee at the same marginal return (K/S = 0.1). */
const PAIR = [curve('a', 100, 1000), curve('b', 50, 500)];

/**
 * Four channels with different sizes and knees. Four is the minimum state count at which the largest-remainder
 * method can show the Alabama paradox, so the sweep below is able to catch a rounding regression.
 */
const SWEEP_CURVES = [
  curve('a', 37, 900),
  curve('b', 120, 1400),
  curve('c', 9, 300),
  curve('d', 200, 5000),
];

/** Weekly budget the demo company actually spends, in kopecks; 3× is a legal scenario budget. */
const CURRENT_WEEKLY_CENTS = 200000n;
/** Upper end of the product budget range: the scenario slider maximum is `maxBudgetMultiplier × current`. */
const MAX_SCENARIO_CENTS = CURRENT_WEEKLY_CENTS * BigInt(METRICS_CONFIG.scenarios.maxBudgetMultiplier);

/**
 * Deterministic pseudo-random budget generator (LCG with fixed seed). Tests must be reproducible: no `Math.random`.
 * The range is `[1×, 5×]` the current weekly budget, not the scenario slider range: these budgets exercise exact sums
 * and the one-kopeck floor beyond the slider, while the monotone sweep owns the slider range itself.
 * @param {number} index
 * @returns {bigint} Budget in kopecks inside `[CURRENT_WEEKLY_CENTS, 5× CURRENT_WEEKLY_CENTS]`.
 */
function deterministicBudget(index) {
  const state = (index * 1664525 + 1013904223) >>> 0;
  return BigInt(state % 800001) + CURRENT_WEEKLY_CENTS;
}

/** @param {Array<{ channelId: string, spendCents: bigint }>} allocations */
function spendByChannel(allocations) {
  return new Map(allocations.map((allocation) => [allocation.channelId, allocation.spendCents]));
}

/**
 * Total predicted weekly conversions for a list of allocations, computed independently of the service.
 * @param {Array<{ K: number, S: number, spendByn: number }>} entries
 * @returns {number}
 */
function objective(entries) {
  return entries.reduce((sum, entry) => sum + entry.K * (1 - Math.exp(-entry.spendByn / entry.S)), 0);
}

describe('marginalReturn', () => {
  it('returns K/S at zero spend and decays exponentially', () => {
    const fit = curve('a', 100, 1000);

    expect(marginalReturn(fit, 0)).toBeCloseTo(0.1, 12);
    expect(marginalReturn(fit, 1000)).toBeCloseTo(0.1 * Math.exp(-1), 12);
  });
});

describe('allocateBudget', () => {
  it('reaches the closed-form split for two curves with equal K/S', () => {
    const budgetCents = 200000n;
    const result = allocateBudget({ curves: PAIR, budgetCents });
    const allocations = spendByChannel(result.allocations);

    // Equal marginal return at the same K/S makes `b1/b2 = S1/S2 = 2`, so b1 = 2B/3 and b2 = B/3.
    const abs = (value) => (value < 0n ? -value : value);
    expect(abs(3n * allocations.get('a') - 2n * budgetCents)).toBeLessThanOrEqual(3n);
    expect(abs(3n * allocations.get('b') - budgetCents)).toBeLessThanOrEqual(3n);
    expect(allocations.get('a') + allocations.get('b')).toBe(budgetCents);

    const firstReturn = marginalReturn(PAIR[0], result.allocations[0].spendByn);
    const secondReturn = marginalReturn(PAIR[1], result.allocations[1].spendByn);
    expect(Math.abs(firstReturn - secondReturn)).toBeLessThan(1e-6);
  });

  it('cannot improve the objective by moving one kopeck between channels', () => {
    // The continuous optimum sits between kopecks, so a discrete transfer may change the objective by a second-order
    // term; epsilon is the largest gain a single kopeck can buy and still be considered numerical noise.
    const epsilon = 1e-9;
    for (const budgetCents of [200000n, 319187n, 600000n]) {
      const result = allocateBudget({ curves: PAIR, budgetCents });
      const base = result.allocations.map((allocation, index) => ({
        K: PAIR[index].K,
        S: PAIR[index].S,
        spendByn: allocation.spendByn,
      }));
      const baseObjective = objective(base);

      for (let from = 0; from < PAIR.length; from += 1) {
        if (result.allocations[from].spendCents <= 1n) continue;
        for (let to = 0; to < PAIR.length; to += 1) {
          if (from === to) continue;
          const moved = base.map((entry, index) => ({
            ...entry,
            spendByn:
              index === from
                ? Number(result.allocations[index].spendCents - 1n) / 100
                : index === to
                  ? Number(result.allocations[index].spendCents + 1n) / 100
                  : entry.spendByn,
          }));
          expect(objective(moved) - baseObjective).toBeLessThanOrEqual(epsilon);
        }
      }
    }
  });

  it('rejects a zero, negative or malformed budget', () => {
    expect(() => allocateBudget({ curves: PAIR, budgetCents: 0n })).toThrow(ValidationError);
    expect(() => allocateBudget({ curves: PAIR, budgetCents: -1n })).toThrow(ValidationError);
    expect(() => allocateBudget({ curves: PAIR, budgetCents: 12.5 })).toThrow(ValidationError);
    expect(() => allocateBudget({ curves: PAIR, budgetCents: 'много' })).toThrow(ValidationError);
  });

  it('rejects a budget smaller than one kopeck per optimised channel', () => {
    expect(() => allocateBudget({ curves: PAIR, budgetCents: 1n })).toThrow(ValidationError);
    // Two curves: exactly two kopecks is the feasible floor and must pass.
    const minimal = allocateBudget({ curves: PAIR, budgetCents: 2n });
    expect(minimal.allocations.map((allocation) => allocation.spendCents)).toEqual([1n, 1n]);
  });

  it('rejects an empty curve list', () => {
    expect(() => allocateBudget({ curves: [], budgetCents: 200000n })).toThrow(
      new ValidationError('Нет каналов с валидной кривой'),
    );
  });

  it('never drops an allocation by more than one kopeck when the budget grows by one kopeck', () => {
    // Step-1 sweep over the whole product slider range. Largest-remainder rounding is not house-monotone in theory
    // (Alabama paradox), so the guarantee is a one-kopeck tolerance: the continuous KKT shares are monotone, and
    // integer rounding can move at most one kopeck. A naive `Math.round` plus sum fix on the first channel breaks
    // this: channel `a` would drop from 28 360 to 28 358 kopecks between B = 319 186 and B = 319 187 (and smaller
    // budgets already lose the one-kopeck floor). The sweep rejects that rounding.
    let previous = allocateBudget({ curves: SWEEP_CURVES, budgetCents: BigInt(SWEEP_CURVES.length) }).allocations.map(
      (allocation) => allocation.spendCents,
    );
    let dips = 0;
    let maxDrop = 0n;
    let exactSums = true;
    let flooredChannels = 0;

    for (let budgetCents = BigInt(SWEEP_CURVES.length) + 1n; budgetCents <= MAX_SCENARIO_CENTS; budgetCents += 1n) {
      const result = allocateBudget({ curves: SWEEP_CURVES, budgetCents });
      const current = result.allocations.map((allocation) => allocation.spendCents);

      // Assertions are collected and checked after the loop: 600 000 `expect` calls would dominate the runtime
      // without adding a better failure message than the recorded budget.
      let sum = 0n;
      for (const spendCents of current) {
        sum += spendCents;
        if (spendCents < 1n) flooredChannels += 1;
      }
      if (sum !== budgetCents) exactSums = false;

      for (let index = 0; index < current.length; index += 1) {
        const drop = previous[index] - current[index];
        if (drop > 0n) {
          dips += 1;
          if (drop > maxDrop) maxDrop = drop;
        }
      }
      previous = current;
    }

    expect(exactSums).toBe(true);
    expect(flooredChannels).toBe(0);
    expect(maxDrop).toBeLessThanOrEqual(1n);
    // A vacuous sweep would prove nothing: this data set really does lose one kopeck on rebalancing (first at
    // B = 319 208, channel `c`), so the tolerance is exercised rather than assumed.
    expect(dips).toBeGreaterThan(0);
  }, 120_000);

  it('keeps the continuous shares monotone in the budget', () => {
    // `allocateBudget` does not expose λ or raw shares, so monotonicity is observed through the decreasing marginal
    // return: as B grows, each channel's rounded spend grows and `K/S·exp(−b/S)` must not increase.
    const budgets = [100000n, 200000n, 300000n, 400000n, 500000n, 600000n];
    let previous = null;

    for (const budgetCents of budgets) {
      const result = allocateBudget({ curves: SWEEP_CURVES, budgetCents });
      const returns = result.allocations.map((allocation, index) =>
        marginalReturn(SWEEP_CURVES[index], allocation.spendByn),
      );
      if (previous !== null) {
        for (let index = 0; index < returns.length; index += 1) {
          expect(returns[index]).toBeLessThanOrEqual(previous[index] + 1e-12);
        }
      }
      previous = returns;
    }
  });

  it('rejects a budget the float shares cannot represent instead of returning a non-equalised plan', () => {
    // `S = 1e300` makes every representable λ produce a share far above a realistic budget: the bisection cannot
    // shrink the sum to 200 000 kopecks within its 80 halvings. The rounding step must not try to distribute that
    // remainder one kopeck at a time; the guard fails loudly with a validation error.
    const extreme = [curve('x', 1, 1e300)];
    expect(() => allocateBudget({ curves: extreme, budgetCents: 200000n })).toThrow(
      new ValidationError('Бюджет вне диапазона точности оптимизатора'),
    );
  });

  it('sums exactly to 100 deterministic budgets and keeps every kopeck non-negative', () => {
    for (let index = 0; index < 100; index += 1) {
      const budgetCents = deterministicBudget(index);
      const result = allocateBudget({ curves: PAIR, budgetCents });

      expect(result.totalCents).toBe(budgetCents);
      expect(Number.isFinite(result.lambda)).toBe(true);
      expect(Number.isFinite(result.objective)).toBe(true);
      expect(result.iterations).toBe(80);

      let sum = 0n;
      for (const allocation of result.allocations) {
        expect(allocation.spendCents).toBeGreaterThanOrEqual(1n);
        sum += allocation.spendCents;
      }
      expect(sum).toBe(budgetCents);
    }
  });

  it('accepts a legitimate 3× budget instead of applying the scenario cap', () => {
    const result = allocateBudget({ curves: PAIR, budgetCents: CURRENT_WEEKLY_CENTS * 3n });

    expect(result.totalCents).toBe(CURRENT_WEEKLY_CENTS * 3n);
    expect(result.allocations).toHaveLength(PAIR.length);
    // The multiplier is above the extrapolation warning threshold; that is a scenario-service concern and must not
    // turn a legal budget into a rejection here.
    expect(CURRENT_WEEKLY_CENTS * 3n).toBeGreaterThan(
      CURRENT_WEEKLY_CENTS * BigInt(METRICS_CONFIG.scenarios.warnBudgetMultiplier),
    );
  });
});
