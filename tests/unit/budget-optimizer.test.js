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

/** Weekly budget the demo company actually spends, in kopecks; 3× is a legal scenario budget. */
const CURRENT_WEEKLY_CENTS = 200000n;

/**
 * Deterministic pseudo-random budget generator (LCG with fixed seed). Tests must be reproducible: no `Math.random`.
 * @param {number} index
 * @returns {bigint} Budget in kopecks inside `[0, 4× current]`.
 */
function deterministicBudget(index) {
  const state = (index * 1664525 + 1013904223) >>> 0;
  return BigInt(state % 800001) + CURRENT_WEEKLY_CENTS;
}

/** @param {Array<{ channelId: string, spendCents: bigint }>} allocations */
function spendByChannel(allocations) {
  return new Map(allocations.map((allocation) => [allocation.channelId, allocation.spendCents]));
}

describe('marginalReturn', () => {
  it('returns K/S at zero spend and decays exponentially', () => {
    const fit = curve('a', 100, 1000);

    expect(marginalReturn(fit, 0)).toBeCloseTo(0.1, 12);
    expect(marginalReturn(fit, 1000)).toBeCloseTo(0.1 * Math.exp(-1), 12);
  });
});

describe('allocateBudget', () => {
  it('splits a budget by equal marginal return', () => {
    const budgetCents = 200000n;
    const result = allocateBudget({ curves: PAIR, budgetCents });

    expect(result.totalCents).toBe(budgetCents);
    let sum = 0n;
    for (const allocation of result.allocations) {
      expect(typeof allocation.spendCents).toBe('bigint');
      expect(allocation.spendCents).toBeGreaterThan(0n);
      expect(Number.isNaN(allocation.spendByn)).toBe(false);
      sum += allocation.spendCents;
    }
    expect(sum).toBe(budgetCents);

    const [first, second] = result.allocations;
    const firstReturn = marginalReturn(PAIR[0], first.spendByn);
    const secondReturn = marginalReturn(PAIR[1], second.spendByn);
    expect(Math.abs(firstReturn - secondReturn)).toBeLessThan(1e-6);
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

  it('never decreases an allocation when the budget grows', () => {
    const budgets = Array.from({ length: 100 }, (_, index) => deterministicBudget(index)).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );

    let previous = null;
    for (const budgetCents of budgets) {
      const current = spendByChannel(allocateBudget({ curves: PAIR, budgetCents }).allocations);
      if (previous !== null) {
        for (const channelId of ['a', 'b']) {
          expect(current.get(channelId) >= previous.get(channelId)).toBe(true);
        }
      }
      previous = current;
    }
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
    expect(CURRENT_WEEKLY_CENTS * 3n).toBeGreaterThan(CURRENT_WEEKLY_CENTS * BigInt(METRICS_CONFIG.scenarios.warnBudgetMultiplier));
  });
});
