import { describe, expect, it } from 'vitest';
import { toStackSegments } from '../../src/lib/contributions.js';
import { computeRanking } from '../../src/services/metrics/ranking.service.js';

/**
 * @param {object} [overrides]
 * @returns {object} Health row accepted by `computeRanking`.
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

describe('score stack segments', () => {
  it('gives the cheaper channel the larger CAC segment and keeps CAC inverted', () => {
    const ranking = computeRanking({
      channels: [
        channel({ channelId: '1', code: 'cheap', cacCents: '10000' }),
        channel({ channelId: '2', code: 'expensive', cacCents: '20000' }),
      ],
    });

    const cheap = toStackSegments(ranking.ranked.find((row) => row.code === 'cheap'));
    const expensive = toStackSegments(ranking.ranked.find((row) => row.code === 'expensive'));

    expect(cheap.find((segment) => segment.criterion === 'cac')).toMatchObject({ value: 30, scored: 1 });
    expect(expensive.find((segment) => segment.criterion === 'cac')).toMatchObject({ value: 0, scored: 0 });
    expect(cheap.find((segment) => segment.criterion === 'cac').value).toBeGreaterThan(
      expensive.find((segment) => segment.criterion === 'cac').value,
    );
  });

  it('always returns four segments in the fixed criterion order', () => {
    const ranking = computeRanking({ channels: [channel()] });
    const segments = toStackSegments(ranking.ranked[0]);

    expect(segments).toHaveLength(4);
    expect(segments.map((segment) => segment.criterion)).toEqual(['cac', 'romi', 'ltvCac', 'newCustomers']);
    expect(segments.map((segment) => segment.label)).toEqual(['CAC', 'ROMI', 'LTV:CAC', 'Новые клиенты']);
  });

  it('sums to the row score within display rounding', () => {
    const ranking = computeRanking({
      channels: [
        channel({ channelId: '1', code: 'alpha', romiPct: 635.46, ltvCacRatio: 3.424, newCustomers: 68 }),
        channel({ channelId: '2', code: 'beta', romiPct: 435.4, ltvCacRatio: 2.812, newCustomers: 59 }),
        channel({ channelId: '3', code: 'gamma', romiPct: 751.97, ltvCacRatio: 2.302, newCustomers: 18 }),
      ],
    });

    for (const ranked of ranking.ranked) {
      const segments = toStackSegments(ranked);
      const total = segments.reduce((sum, segment) => sum + segment.value, 0);
      expect(Math.abs(total - ranked.score)).toBeLessThanOrEqual(0.05);
    }
  });

  it('returns no segments for an excluded row', () => {
    expect(toStackSegments({ rank: null, score: null, contributions: [] })).toEqual([]);
    expect(toStackSegments({})).toEqual([]);
  });
});
