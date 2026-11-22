import { describe, expect, it } from 'vitest';
import { METRICS_CONFIG } from '../../src/config/metrics.js';
import { ValidationError } from '../../src/lib/errors.js';
import { normalizeBigInt, normalizeNumber } from '../../src/lib/metrics-math.js';
import { computeRanking, normalizeWeights } from '../../src/services/metrics/ranking.service.js';

/**
 * One health-report row as `getChannelHealthReport` produces it: CAC is a decimal kopeck string, the ratios are
 * numbers with display precision, and `status` is already decided by the health service.
 * @param {object} [overrides]
 * @returns {object}
 */
function channel(overrides = {}) {
  return {
    channelId: '1',
    code: 'alpha',
    name: 'Alpha',
    cacCents: '10000',
    romiPct: 100,
    ltvCacRatio: 2,
    newCustomers: 10,
    status: 'healthy',
    ...overrides,
  };
}

/**
 * @param {object} row A ranked row.
 * @param {'cac' | 'romi' | 'ltvCac' | 'newCustomers'} criterion
 * @returns {object}
 */
function contribution(row, criterion) {
  return row.contributions.find((entry) => entry.criterion === criterion);
}

describe('normalizeWeights', () => {
  it('returns the configured defaults normalised to one', () => {
    const weights = normalizeWeights();

    expect(weights).toEqual({ ...METRICS_CONFIG.ranking.weights });
    expect(weights.cac + weights.romi + weights.ltvCac + weights.newCustomers).toBe(1);
  });

  it('normalises arbitrary non-negative weights to a sum of one', () => {
    const weights = normalizeWeights({ cac: 2, romi: 2, ltvCac: 1, newCustomers: 1 });

    expect(weights.cac).toBeCloseTo(0.333, 3);
    expect(weights.romi).toBeCloseTo(0.333, 3);
    expect(weights.ltvCac).toBeCloseTo(0.167, 3);
    expect(weights.newCustomers).toBeCloseTo(0.167, 3);
    expect(weights.cac + weights.romi + weights.ltvCac + weights.newCustomers).toBe(1);
  });

  it('apportions the rounding residual so the weights sum to exactly one', () => {
    // Independent rounding would give 0.091 + 0.182 + 0.273 + 0.455 = 1.001 and a score of 100.1.
    const weights = normalizeWeights({ cac: 1, romi: 2, ltvCac: 3, newCustomers: 5 });

    expect(weights).toEqual({ cac: 0.091, romi: 0.182, ltvCac: 0.273, newCustomers: 0.454 });
    expect(weights.cac + weights.romi + weights.ltvCac + weights.newCustomers).toBe(1);
  });

  it('keeps a single non-zero weight at one and the others at zero', () => {
    expect(normalizeWeights({ cac: 7, romi: 0, ltvCac: 0, newCustomers: 0 })).toEqual({
      cac: 1,
      romi: 0,
      ltvCac: 0,
      newCustomers: 0,
    });
  });

  it('rejects negative weights', () => {
    expect(() => normalizeWeights({ cac: -0.1, romi: 0.3, ltvCac: 0.25, newCustomers: 0.15 })).toThrow(
      ValidationError,
    );
  });

  it('rejects a zero sum instead of dividing by zero', () => {
    expect(() => normalizeWeights({ cac: 0, romi: 0, ltvCac: 0, newCustomers: 0 })).toThrow(ValidationError);
  });

  it('rejects a weight that is not a finite number', () => {
    expect(() => normalizeWeights({ cac: '0.3', romi: 0.3, ltvCac: 0.25, newCustomers: 0.15 })).toThrow(
      ValidationError,
    );
    expect(() => normalizeWeights({ cac: Number.NaN, romi: 0.3, ltvCac: 0.25, newCustomers: 0.15 })).toThrow(
      ValidationError,
    );
  });

  it('rejects an unknown criterion instead of silently ignoring it', () => {
    expect(() =>
      normalizeWeights({ cac: 0.3, romi: 0.3, ltvCac: 0.25, newCustomers: 0.15, profit: 1 }),
    ).toThrow('Неизвестный критерий веса «profit»');
  });

  it('rejects a total that overflows to Infinity', () => {
    expect(() =>
      normalizeWeights({
        cac: Number.MAX_VALUE,
        romi: Number.MAX_VALUE,
        ltvCac: Number.MAX_VALUE,
        newCustomers: Number.MAX_VALUE,
      }),
    ).toThrow(ValidationError);
  });
});

describe('computeRanking normalisation', () => {
  it('keeps the range normalisation neutral when every channel has the same value', () => {
    // The shared helper is the source of the "max == min → 1" rule; ranking must not reimplement it.
    expect(normalizeBigInt(100n, 100n, 100n)).toBe(1);
    expect(normalizeNumber(2.5, 2.5, 2.5)).toBe(1);

    const ranking = computeRanking({
      channels: [channel(), channel({ channelId: '2', code: 'beta' })],
    });

    for (const row of ranking.ranked) {
      expect(contribution(row, 'cac').normalized).toBe(1);
      // Equal CACs are equally cheap, so the CAC criterion adds nothing to either score.
      expect(contribution(row, 'cac').scored).toBe(0);
      expect(contribution(row, 'romi').normalized).toBe(1);
    }
  });

  it('rewards the cheaper CAC and penalises the expensive one', () => {
    const ranking = computeRanking({
      channels: [
        channel({ channelId: '1', code: 'cheap', cacCents: '10000' }),
        channel({ channelId: '2', code: 'expensive', cacCents: '20000' }),
      ],
    });

    const cheap = ranking.ranked[0];
    const expensive = ranking.ranked[1];

    expect(cheap.code).toBe('cheap');
    expect(expensive.code).toBe('expensive');
    expect(contribution(cheap, 'cac')).toMatchObject({ normalized: 0, scored: 1 });
    expect(contribution(expensive, 'cac')).toMatchObject({ normalized: 1, scored: 0 });
    expect(cheap.score).toBeGreaterThan(expensive.score);
  });

  it('normalises ROMI, LTV:CAC and new customers upward, keeping a zero as a real value', () => {
    const ranking = computeRanking({
      channels: [
        channel({ channelId: '1', code: 'low', romiPct: -50, ltvCacRatio: 1, newCustomers: 0 }),
        channel({ channelId: '2', code: 'high', romiPct: 150, ltvCacRatio: 3, newCustomers: 20 }),
      ],
      weights: { cac: 0, romi: 0.5, ltvCac: 0.25, newCustomers: 0.25 },
    });

    const low = ranking.ranked.find((row) => row.code === 'low');
    const high = ranking.ranked.find((row) => row.code === 'high');

    expect(contribution(low, 'romi')).toMatchObject({ normalized: 0, scored: 0, rawValue: -50 });
    expect(contribution(high, 'romi')).toMatchObject({ normalized: 1, scored: 1, rawValue: 150 });
    expect(contribution(low, 'newCustomers')).toMatchObject({ normalized: 0, rawValue: 0 });
    expect(contribution(high, 'newCustomers')).toMatchObject({ normalized: 1, rawValue: 20 });
    expect(high.rank).toBe(1);
  });
});

describe('computeRanking exclusions', () => {
  it('excludes the blended row by the missing channelId and never lets it move min/max', () => {
    const ranking = computeRanking({
      channels: [
        channel({ channelId: '1', code: 'alpha', cacCents: '10000' }),
        channel({ channelId: '2', code: 'beta', cacCents: '20000' }),
        // An absurd blended CAC: if it reached the range, alpha would no longer be at address 0.
        { ...channel({ code: 'blended', name: 'Все каналы', cacCents: '1' }), channelId: undefined },
      ],
    });

    expect(ranking.ranked.map((row) => row.code)).toEqual(['alpha', 'beta']);
    expect(ranking.excluded).toContainEqual({
      code: 'blended',
      reason: 'blended',
      reasonLabel: 'Сводная строка',
    });
    expect(contribution(ranking.ranked[0], 'cac').scored).toBe(1);
  });

  it('excludes no_data rows and computes the range from the ranked channels only', () => {
    const ranking = computeRanking({
      channels: [
        channel({ channelId: '1', code: 'alpha', cacCents: '10000' }),
        channel({ channelId: '2', code: 'beta', cacCents: '20000' }),
        channel({ channelId: '3', code: 'owned', cacCents: '0', romiPct: null, ltvCacRatio: null, status: 'no_data' }),
      ],
    });

    expect(ranking.ranked.map((row) => row.code)).toEqual(['alpha', 'beta']);
    expect(ranking.excluded).toContainEqual({
      channelId: '3',
      code: 'owned',
      reason: 'no_data',
      reasonLabel: 'Мало данных',
    });
    expect(contribution(ranking.ranked[0], 'cac').normalized).toBe(0);
  });

  it('excludes a channel with a missing criterion instead of scoring it as zero', () => {
    const ranking = computeRanking({
      channels: [
        channel({ channelId: '1', code: 'alpha' }),
        channel({ channelId: '2', code: 'broken', romiPct: null }),
      ],
    });

    expect(ranking.ranked.map((row) => row.code)).toEqual(['alpha']);
    expect(ranking.excluded).toContainEqual({
      channelId: '2',
      code: 'broken',
      reason: 'missing_criterion',
      reasonLabel: 'Не хватает метрики',
    });
  });
});

describe('computeRanking scoring and order', () => {
  it('scores a single channel without dividing by an empty range', () => {
    const ranking = computeRanking({ channels: [channel()] });

    expect(ranking.ranked).toHaveLength(1);
    // CAC scores 0 on an empty range, the other three criteria score 1: 30 + 25 + 15.
    expect(ranking.ranked[0]).toMatchObject({ code: 'alpha', rank: 1, score: 70 });
  });

  it('returns an empty ranking for an empty list', () => {
    expect(computeRanking({ channels: [] })).toMatchObject({ ranked: [], excluded: [] });
    expect(computeRanking()).toMatchObject({ ranked: [], excluded: [] });
  });

  it('makes the displayed contributions add up to the score', () => {
    const ranking = computeRanking({
      channels: [
        channel({ channelId: '1', code: 'alpha', romiPct: 635.46, ltvCacRatio: 3.424, newCustomers: 68 }),
        channel({ channelId: '2', code: 'beta', romiPct: 435.4, ltvCacRatio: 2.812, newCustomers: 59 }),
        channel({ channelId: '3', code: 'gamma', romiPct: 751.97, ltvCacRatio: 2.302, newCustomers: 18 }),
      ],
    });

    for (const row of ranking.ranked) {
      const sum = row.contributions.reduce((total, entry) => total + entry.contribution, 0);
      expect(sum).toBeCloseTo(row.score, 2);
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(100);
    }
  });

  it('breaks a score tie by CAC and then by code', () => {
    const sameScore = {
      romiPct: 100,
      ltvCacRatio: 2,
      newCustomers: 10,
      cacCents: '10000',
    };
    const byCode = computeRanking({
      channels: [
        channel({ ...sameScore, channelId: '1', code: 'zulu' }),
        channel({ ...sameScore, channelId: '2', code: 'alpha' }),
      ],
    });

    expect(byCode.ranked.map((row) => [row.code, row.rank])).toEqual([
      ['alpha', 1],
      ['zulu', 2],
    ]);

    // With only the customer count weighted, both scores are 100; the cheaper CAC wins before the code does.
    const byCac = computeRanking({
      channels: [
        channel({ ...sameScore, channelId: '1', code: 'zulu', cacCents: '10000' }),
        channel({ ...sameScore, channelId: '2', code: 'alpha', cacCents: '20000' }),
      ],
      weights: { cac: 0, romi: 0, ltvCac: 0, newCustomers: 1 },
    });

    expect(byCac.ranked.map((row) => row.code)).toEqual(['zulu', 'alpha']);
  });

  it('never scores a channel best on every criterion above 100', () => {
    const ranking = computeRanking({
      channels: [
        channel({ channelId: '1', code: 'best', cacCents: '10000', romiPct: 300, ltvCacRatio: 4, newCustomers: 20 }),
        channel({ channelId: '2', code: 'worst', cacCents: '20000', romiPct: 100, ltvCacRatio: 2, newCustomers: 5 }),
      ],
      weights: { cac: 1, romi: 2, ltvCac: 3, newCustomers: 5 },
    });

    // 0.091 + 0.182 + 0.273 + 0.454 is exactly 1 after largest-remainder apportionment, so the ceiling holds.
    expect(ranking.ranked[0]).toMatchObject({ code: 'best', rank: 1, score: 100 });
    expect(ranking.ranked[0].score).toBeLessThanOrEqual(100);
    expect(ranking.ranked[1].score).toBeLessThanOrEqual(100);
  });

  it('gives a zero weight no contribution and no influence on the order', () => {
    const ranking = computeRanking({
      channels: [
        channel({ channelId: '1', code: 'alpha', romiPct: 200 }),
        channel({ channelId: '2', code: 'beta', romiPct: 100 }),
      ],
      weights: { cac: 0, romi: 1, ltvCac: 0, newCustomers: 0 },
    });

    const alpha = ranking.ranked.find((row) => row.code === 'alpha');
    expect(ranking.ranked[0].code).toBe('alpha');
    expect(contribution(alpha, 'cac').weight).toBe(0);
    expect(contribution(alpha, 'cac').contribution).toBe(0);
    expect(contribution(alpha, 'romi').contribution).toBe(100);
    expect(alpha.score).toBe(100);
  });

  it('changes the order when custom weights favour another criterion', () => {
    const channels = [
      channel({ channelId: '1', code: 'cheap', cacCents: '10000', romiPct: 100 }),
      channel({ channelId: '2', code: 'romantic', cacCents: '20000', romiPct: 300 }),
    ];

    const byDefault = computeRanking({ channels });
    const byRomi = computeRanking({ channels, weights: { cac: 0, romi: 1, ltvCac: 0, newCustomers: 0 } });

    expect(byDefault.ranked[0].code).toBe('cheap');
    expect(byRomi.ranked[0].code).toBe('romantic');
  });

  it('serialises without NaN, Infinity or bigint and keeps every contribution finite', () => {
    const ranking = computeRanking({
      channels: [
        channel({ channelId: '1', code: 'alpha', romiPct: -100, newCustomers: 0 }),
        channel({ channelId: '2', code: 'beta', romiPct: 0, newCustomers: 0 }),
      ],
    });

    expect(() => JSON.stringify(ranking)).not.toThrow();
    expect(JSON.stringify(ranking)).not.toMatch(/NaN|Infinity/);
    for (const row of ranking.ranked) {
      for (const entry of row.contributions) {
        expect(Number.isFinite(entry.normalized)).toBe(true);
        expect(Number.isFinite(entry.scored)).toBe(true);
        expect(Number.isFinite(entry.contribution)).toBe(true);
      }
    }
  });
});
