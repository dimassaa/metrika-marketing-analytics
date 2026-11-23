import { describe, expect, it } from 'vitest';
import { METRICS_CONFIG } from '../../src/config/metrics.js';

describe('saturation config', () => {
  it('fits a curve over 26 weeks on the deterministic 60-step grid', () => {
    expect(METRICS_CONFIG.saturation.historyWeeks).toBe(26);
    expect(METRICS_CONFIG.saturation.gridSteps).toBe(60);
    // Seven positive weeks are not enough for a curve, the spec requires eight; below that the fit is linear.
    expect(METRICS_CONFIG.saturation.minPositiveWeeks).toBe(8);
  });

  it('marks a curve unreliable below the spec R² and keeps the search ranges', () => {
    expect(METRICS_CONFIG.saturation.r2WarnBelow).toBe(0.3);
    // K ∈ [1.05 × max(q), 4 × max(q)], S ∈ [0.33 × mean(b), 3 × max(b)] — metrics spec §6.1.
    expect(METRICS_CONFIG.saturation.kMinFactor).toBe(1.05);
    expect(METRICS_CONFIG.saturation.kMaxFactor).toBe(4);
    expect(METRICS_CONFIG.saturation.sMinFactor).toBe(0.33);
    expect(METRICS_CONFIG.saturation.sMaxFactor).toBe(3);
  });
});

describe('alerts config', () => {
  it('compares four-week windows and throttles automatic recalculation to an hour', () => {
    expect(METRICS_CONFIG.alerts.windowWeeks).toBe(4);
    expect(METRICS_CONFIG.alerts.autoRecalcMs).toBe(3_600_000);
  });

  it('stores CAC spike ratios as exact integer fractions', () => {
    // 6/5 and 3/2 are compared by integer cross-multiplication, so a threshold can never drift through a float.
    expect(METRICS_CONFIG.alerts.cacSpikeWarnRatio).toEqual({ num: 6, den: 5 });
    expect(METRICS_CONFIG.alerts.cacSpikeCriticalRatio).toEqual({ num: 3, den: 2 });
  });
});

describe('scenarios config', () => {
  it('caps the weekly budget with one shared multiplier and warns above twice the actual spend', () => {
    expect(METRICS_CONFIG.scenarios.maxBudgetMultiplier).toBe(3);
    // The extrapolation warning has exactly one threshold; a second 2× key would be a second source of truth.
    expect(METRICS_CONFIG.scenarios.warnBudgetMultiplier).toBe(2);
    expect(METRICS_CONFIG.scenarios).not.toHaveProperty('extrapolationFactor');
  });
});

describe('decision config immutability', () => {
  it('freezes the whole tree and every M5 subtree, including the ratio objects', () => {
    expect(Object.isFrozen(METRICS_CONFIG)).toBe(true);
    expect(Object.isFrozen(METRICS_CONFIG.saturation)).toBe(true);
    expect(Object.isFrozen(METRICS_CONFIG.alerts)).toBe(true);
    expect(Object.isFrozen(METRICS_CONFIG.scenarios)).toBe(true);
    expect(Object.isFrozen(METRICS_CONFIG.alerts.cacSpikeWarnRatio)).toBe(true);
    expect(Object.isFrozen(METRICS_CONFIG.alerts.cacSpikeCriticalRatio)).toBe(true);
  });

  it('rejects a threshold mutation instead of silently moving the goalposts', () => {
    expect(() => {
      METRICS_CONFIG.alerts.windowWeeks = 8;
    }).toThrow(TypeError);
    expect(() => {
      METRICS_CONFIG.scenarios.maxBudgetMultiplier = 5;
    }).toThrow(TypeError);
    expect(METRICS_CONFIG.alerts.windowWeeks).toBe(4);
    expect(METRICS_CONFIG.scenarios.maxBudgetMultiplier).toBe(3);
  });
});
