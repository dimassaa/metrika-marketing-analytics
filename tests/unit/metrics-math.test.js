import { describe, expect, it } from 'vitest';
import { METRICS_CONFIG } from '../../src/config/metrics.js';
import {
  assertFinite,
  assertFiniteOrNull,
  centsPercent,
  centsRatio,
  centsToApi,
  centsToBynDecimal,
  normalizeBigInt,
  normalizeNumber,
  percentChange,
  roundHalfUp,
  roundNumber,
} from '../../src/lib/metrics-math.js';

describe('METRICS_CONFIG', () => {
  it('exposes the thresholds from the metrics spec and is deeply frozen', () => {
    expect(METRICS_CONFIG.ltv.horizons).toEqual([3, 6, 12]);
    expect(METRICS_CONFIG.ltv.defaultHorizon).toBe(12);
    expect(METRICS_CONFIG.attribution).toMatchObject({ windowDays: 30, defaultModel: 'last_touch' });
    expect(METRICS_CONFIG.health).toMatchObject({
      healthyRatio: 3,
      watchRatio: 1,
      healthyPaybackMax: 12,
      watchPaybackMax: 18,
      romiRiskBelow: 0,
    });
    expect(METRICS_CONFIG.ranking.weights).toEqual({ cac: 0.3, romi: 0.3, ltvCac: 0.25, newCustomers: 0.15 });
    expect(METRICS_CONFIG.periods).toEqual({ defaultDays: 30, options: [30, 90, 180] });
    expect(Object.isFrozen(METRICS_CONFIG)).toBe(true);
    expect(Object.isFrozen(METRICS_CONFIG.ltv.horizons)).toBe(true);
    expect(Object.isFrozen(METRICS_CONFIG.ranking.weights)).toBe(true);
  });
});

describe('centsRatio', () => {
  it('divides kopecks without a float round trip and rounds half up away from zero', () => {
    expect(centsRatio(500000n, 10000n, 2)).toBe(50);
    expect(centsRatio(1n, 3n, 2)).toBe(0.33);
    expect(centsRatio(-1n, 3n, 2)).toBe(-0.33);
    expect(centsRatio(2n, 3n, 2)).toBe(0.67);
    expect(centsRatio(1n, 3n, 4)).toBe(0.3333);
  });

  it('returns null instead of Infinity for a zero denominator', () => {
    expect(centsRatio(1n, 0n, 2)).toBe(null);
    expect(centsRatio(0n, 0n, 2)).toBe(null);
  });

  it('keeps the sign when the denominator is negative', () => {
    expect(centsRatio(1n, -3n, 2)).toBe(-0.33);
    expect(centsRatio(-1n, -3n, 2)).toBe(0.33);
  });
});

describe('centsPercent', () => {
  it('renders a share of a whole as a percentage', () => {
    expect(centsPercent(50000n, 100000n)).toBe(50);
    expect(centsPercent(1n, 3n, 2)).toBe(33.33);
    expect(centsPercent(-1n, 3n, 2)).toBe(-33.33);
    expect(centsPercent(1n, 0n)).toBe(null);
  });
});

describe('centsToApi / centsToBynDecimal', () => {
  it('returns the decimal string of kopecks and keeps NULL honest', () => {
    expect(centsToApi(5000n)).toBe('5000');
    expect(centsToApi(0n)).toBe('0');
    expect(centsToApi(-1n)).toBe('-1');
    expect(centsToApi(null)).toBe(null);
  });

  it('renders a NUMERIC-ready BYN amount with a dot', () => {
    expect(centsToBynDecimal(5000n)).toBe('50.00');
    expect(centsToBynDecimal(1n)).toBe('0.01');
    expect(centsToBynDecimal(-123456n)).toBe('-1234.56');
    expect(centsToBynDecimal(null)).toBe(null);
  });

  it('rejects a non-bigint instead of silently converting money through a float', () => {
    expect(() => centsToApi(12.5)).toThrow(TypeError);
    expect(() => centsToBynDecimal('5000')).toThrow(TypeError);
  });
});

describe('normalizeBigInt / normalizeNumber', () => {
  it('scales into [0, 1] and treats a zero-width range as fully normalised', () => {
    expect(normalizeBigInt(5n, 5n, 5n)).toBe(1);
    expect(normalizeBigInt(5n, 5n, 15n)).toBe(0);
    expect(normalizeBigInt(10n, 5n, 15n)).toBe(0.5);
    expect(normalizeBigInt(15n, 5n, 15n)).toBe(1);
    expect(normalizeNumber(7, 5, 15)).toBe(0.2);
    expect(normalizeNumber(5, 5, 5)).toBe(1);
  });
});

describe('percentChange', () => {
  it('uses the absolute previous value and returns null when there was no baseline', () => {
    expect(percentChange(120, 0)).toBe(null);
    expect(percentChange(80, 100)).toBe(-20);
    expect(percentChange(120, 100)).toBe(20);
    expect(percentChange(80, -100)).toBe(180);
  });

  it('rejects non-finite operands', () => {
    expect(() => percentChange(Infinity, 100)).toThrow(TypeError);
    expect(() => percentChange(10, NaN)).toThrow(TypeError);
  });
});

describe('rounding helpers', () => {
  it('rounds half up, including halves and negatives', () => {
    expect(roundHalfUp(2.5)).toBe(3n);
    expect(roundHalfUp(2.4)).toBe(2n);
    expect(roundHalfUp(-2.5)).toBe(-3n);
    expect(roundHalfUp(0)).toBe(0n);
  });

  it('rounds for the view model only', () => {
    expect(roundNumber(2.9996, 3)).toBe(3);
    expect(roundNumber(1.2345, 2)).toBe(1.23);
    expect(roundNumber(1.2355, 2)).toBe(1.24);
    expect(roundNumber(-1.235, 2)).toBe(-1.24);
  });
});

describe('finite assertions', () => {
  it('throws TypeError for NaN and Infinity and passes finite values through', () => {
    expect(() => assertFinite(NaN, 'cac')).toThrow(TypeError);
    expect(() => assertFinite(Infinity, 'cac')).toThrow(TypeError);
    expect(assertFinite(12.5, 'cac')).toBe(12.5);
  });

  it('allows null where the domain has no value', () => {
    expect(assertFiniteOrNull(null, 'cac')).toBe(null);
    expect(assertFiniteOrNull(undefined, 'cac')).toBe(null);
    expect(assertFiniteOrNull(7, 'cac')).toBe(7);
    expect(() => assertFiniteOrNull(NaN, 'cac')).toThrow(TypeError);
  });
});
