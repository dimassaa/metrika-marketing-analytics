import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/lib/dates.js';
import { ValidationError } from '../../src/lib/errors.js';
import {
  fitSaturationCurve,
  predictConversions,
  predictLinear,
  toWeeklyBuckets,
} from '../../src/services/decisions/saturation.service.js';

/** Monday: the first bucket of every synthetic 26-week window. */
const FIRST_WEEK = '2026-05-25';

/**
 * Builds the 26-week sample the brief fixes for the curve test: spend 100..2600 BYN in 100 BYN steps and the
 * exact points of `q = K·(1 − e^(−b/S))` with `K = 500`, `S = 1200`. Fractional customers are deliberate here:
 * the fixture is a smooth mathematical curve, not database counts, and rounding it would blur the tolerance.
 * @returns {Array<{ spendCents: bigint, newCustomers: number }>}
 */
function syntheticPoints() {
  return Array.from({ length: 26 }, (_, index) => {
    const spendByn = 100 * (index + 1);
    return {
      spendCents: BigInt(spendByn * 100),
      newCustomers: 500 * (1 - Math.exp(-spendByn / 1200)),
    };
  });
}

/**
 * @param {number} weekIndex Zero-based week offset from `FIRST_WEEK`.
 * @param {number} spendByn
 * @param {number} newCustomers
 */
function bucket(weekIndex, spendByn, newCustomers) {
  return {
    weekStart: addDays(FIRST_WEEK, weekIndex * 7),
    spendCents: BigInt(spendByn * 100),
    newCustomers,
  };
}

describe('toWeeklyBuckets', () => {
  it('returns exactly 26 weeks per channel and fills an absent week with zeros', () => {
    const rowsByChannel = new Map([
      [
        '1',
        [
          // Two rows in the same week are one week: the bucket is the sum, never a silent last-wins.
          { weekStart: FIRST_WEEK, spendCents: 10000n, newCustomers: 3 },
          { weekStart: FIRST_WEEK, spendCents: 5000n, newCustomers: 2 },
          { weekStart: addDays(FIRST_WEEK, 14), spendCents: 20000n, newCustomers: 5 },
          // Outside the requested window: ignored, because the axis stays exactly 26 weeks long.
          { weekStart: addDays(FIRST_WEEK, -7), spendCents: 999n, newCustomers: 9 },
        ],
      ],
    ]);

    const buckets = toWeeklyBuckets({ firstWeekStart: FIRST_WEEK, weeks: 26, rowsByChannel }).get('1');

    expect(buckets).toHaveLength(26);
    expect(buckets[0]).toEqual({ weekStart: FIRST_WEEK, spendCents: 15000n, newCustomers: 5 });
    expect(buckets[1]).toEqual({ weekStart: addDays(FIRST_WEEK, 7), spendCents: 0n, newCustomers: 0 });
    expect(buckets[2]).toEqual({ weekStart: addDays(FIRST_WEEK, 14), spendCents: 20000n, newCustomers: 5 });
    expect(buckets.at(-1).weekStart).toBe(addDays(FIRST_WEEK, 25 * 7));
  });

  it('keeps one entry per channel and rejects an unbounded week count', () => {
    const result = toWeeklyBuckets({ firstWeekStart: FIRST_WEEK, weeks: 2, rowsByChannel: { '7': [] } });

    expect([...result.keys()]).toEqual(['7']);
    expect(result.get('7')).toEqual([
      { weekStart: FIRST_WEEK, spendCents: 0n, newCustomers: 0 },
      { weekStart: addDays(FIRST_WEEK, 7), spendCents: 0n, newCustomers: 0 },
    ]);
    expect(() => toWeeklyBuckets({ firstWeekStart: FIRST_WEEK, weeks: 53, rowsByChannel: new Map() })).toThrow(
      ValidationError,
    );
    expect(() =>
      toWeeklyBuckets({
        firstWeekStart: FIRST_WEEK,
        weeks: 2,
        rowsByChannel: new Map([['1', [{ weekStart: '25.05.2026', spendCents: 100n, newCustomers: 1 }]]]),
      }),
    ).toThrow(TypeError);
  });
});

describe('fitSaturationCurve — synthetic curve', () => {
  const points = syntheticPoints();
  const fit = fitSaturationCurve({ points });

  it('recovers K and S within one grid step and reports the fit quality', () => {
    // The tolerance is "one grid step or the brief's percentage", because a coarse grid cannot land on the exact
    // parameter even when the data is generated from that parameter.
    const maxObserved = Math.max(...points.map((point) => point.newCustomers));
    const meanSpendByn =
      points.reduce((sum, point) => sum + Number(point.spendCents) / 100, 0) / points.length;
    const maxSpendByn = Math.max(...points.map((point) => Number(point.spendCents) / 100));

    const kStep = (4 * maxObserved - 1.05 * maxObserved) / 59;
    const logStepRatio = ((3 * maxSpendByn) / (0.33 * meanSpendByn)) ** (1 / 59);

    expect(fit.model).toBe('saturation');
    expect(Math.abs(fit.K - 500)).toBeLessThanOrEqual(Math.max(kStep, 0.05 * 500));

    const sLow = Math.min(1200 / logStepRatio, 1200 * 0.85);
    const sHigh = Math.max(1200 * logStepRatio, 1200 * 1.15);
    expect(fit.S).toBeGreaterThanOrEqual(sLow);
    expect(fit.S).toBeLessThanOrEqual(sHigh);

    expect(fit.r2).toBeGreaterThan(0.99);
    expect(fit.unreliable).toBe(false);
    expect(fit.warning).toBeNull();
    expect(fit.cpaCents).toBeNull();
    expect(fit.positiveWeeks).toBe(26);
    expect(fit.maxObservedCustomers).toBeCloseTo(maxObserved, 10);
    expect(fit.meanSpendCents).toBe('135000');
    expect(fit.maxSpendCents).toBe('260000');
    for (const value of [fit.K, fit.S, fit.sse, fit.sst, fit.r2]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('searches inside the spec ranges and starts at zero spend', () => {
    const maxObserved = Math.max(...points.map((point) => point.newCustomers));
    const maxSpendByn = Math.max(...points.map((point) => Number(point.spendCents) / 100));
    const meanSpendByn =
      points.reduce((sum, point) => sum + Number(point.spendCents) / 100, 0) / points.length;

    expect(fit.K).toBeGreaterThanOrEqual(1.05 * maxObserved);
    expect(fit.K).toBeLessThanOrEqual(4 * maxObserved);
    expect(fit.S).toBeGreaterThanOrEqual(0.33 * meanSpendByn);
    expect(fit.S).toBeLessThanOrEqual(3 * maxSpendByn);

    expect(predictConversions(fit, 0)).toBe(0);
  });

  it('is monotone and never exceeds the saturation ceiling', () => {
    let previous = 0;
    for (const spendByn of [0, 1, 100, 500, 1000, 2000, 2600, 5000, 20_000]) {
      const predicted = predictConversions(fit, spendByn);
      expect(Number.isFinite(predicted)).toBe(true);
      expect(predicted).toBeGreaterThanOrEqual(previous);
      expect(predicted).toBeLessThanOrEqual(fit.K);
      previous = predicted;
    }
  });
});

describe('fitSaturationCurve — boundaries', () => {
  it('falls back to linear with the aggregate CPA below eight positive weeks', () => {
    // Seven weeks: total spend 280 000 kopecks, total 28 customers → exactly 10 000 kopecks per customer.
    const points = Array.from({ length: 7 }, (_, index) => bucket(index, (index + 1) * 100, index + 1));
    const fit = fitSaturationCurve({ points });

    expect(fit.model).toBe('linear');
    expect(fit.cpaCents).toBe('10000');
    expect(fit.K).toBeNull();
    expect(fit.S).toBeNull();
    expect(fit.r2).toBeNull();
    expect(fit.unreliable).toBe(true);
    expect(fit.positiveWeeks).toBe(7);
    expect(fit.meanSpendCents).toBe('40000');
    expect(fit.warning).toMatch(/[А-Яа-я]/);

    expect(predictLinear(fit, 0)).toBe(0);
    expect(predictLinear(fit, 100)).toBe(1);
    expect(predictConversions(fit, 100)).toBe(1);
  });

  it('returns no_data without spend and keeps the mean null instead of zero', () => {
    const empty = fitSaturationCurve({ points: [] });

    expect(empty.model).toBe('no_data');
    expect(empty.positiveWeeks).toBe(0);
    expect(empty.meanSpendCents).toBeNull();
    expect(empty.maxSpendCents).toBe('0');
    expect(empty.r2).toBeNull();
    expect(empty.unreliable).toBe(true);
    expect(empty.warning).toMatch(/[А-Яа-я]/);
    expect(Number.isFinite(empty.sse)).toBe(true);
    expect(Number.isFinite(empty.sst)).toBe(true);
    expect(predictConversions(empty, 1000)).toBe(0);
    expect(predictLinear(empty, 1000)).toBe(0);
  });

  it('returns no_data when spend exists but nobody was acquired', () => {
    const points = Array.from({ length: 26 }, (_, index) => bucket(index, (index + 1) * 100, 0));
    const fit = fitSaturationCurve({ points });

    expect(fit.model).toBe('no_data');
    // Spend is real, so the positive-week mean is defined even though the curve is not.
    expect(fit.positiveWeeks).toBe(26);
    expect(fit.meanSpendCents).toBe('135000');
    expect(fit.maxObservedCustomers).toBe(0);
    expect(fit.warning).toMatch(/[А-Яа-я]/);
  });

  it('marks flat data unreliable without producing NaN', () => {
    // Identical conversions at very different spend: SST is zero, so the specification forbids a numeric R².
    const points = Array.from({ length: 26 }, (_, index) => bucket(index, (index + 1) * 100, 10));
    const fit = fitSaturationCurve({ points });

    expect(fit.model).toBe('saturation');
    expect(fit.unreliable).toBe(true);
    expect(fit.r2 === null || fit.r2 < 0.3).toBe(true);
    for (const value of [fit.K, fit.S, fit.sse, fit.sst]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(fit.r2 === null || Number.isFinite(fit.r2)).toBe(true);
    expect(fit.warning).toMatch(/[А-Яа-я]/);
  });

  it('counts zero-spend weeks in the 26 points but not in positiveWeeks or the mean', () => {
    const rowsByChannel = new Map([
      [
        '1',
        // Only the first eight weeks have spend; the remaining eighteen are the measured zeros of the axis.
        Array.from({ length: 8 }, (_, index) => bucket(index, (index + 1) * 100, index + 1)),
      ],
    ]);

    const buckets = toWeeklyBuckets({ firstWeekStart: FIRST_WEEK, weeks: 26, rowsByChannel }).get('1');
    expect(buckets).toHaveLength(26);

    const fit = fitSaturationCurve({ points: buckets });

    expect(fit.positiveWeeks).toBe(8);
    expect(fit.model).toBe('saturation');
    // (100 + … + 800) / 8 = 450 BYN; the eighteen zero weeks do not pull the mean down.
    expect(fit.meanSpendCents).toBe('45000');
    expect(fit.maxSpendCents).toBe('80000');
  });

  it('rejects negative or non-finite inputs instead of hiding them', () => {
    expect(() => fitSaturationCurve({ points: [{ spendCents: -1n, newCustomers: 1 }] })).toThrow(TypeError);
    expect(() => fitSaturationCurve({ points: [{ spendCents: 100n, newCustomers: Number.NaN }] })).toThrow(
      TypeError,
    );
  });
});
