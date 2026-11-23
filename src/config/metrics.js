/**
 * Thresholds and planning constants for the metrics engine (metrics spec §1–§5).
 *
 * They live in one frozen object because the UI, the health status and the ranking weights must agree: a threshold
 * changed here changes every report, and a frozen tree makes an accidental `METRICS_CONFIG.health.healthyRatio = 1`
 * fail loudly instead of silently moving the goalposts.
 */
export const METRICS_CONFIG = Object.freeze({
  ltv: Object.freeze({
    horizons: Object.freeze([3, 6, 12]),
    defaultHorizon: 12,
    monthsPerYear: 12,
  }),
  attribution: Object.freeze({
    windowDays: 30,
    models: Object.freeze(['last_touch', 'first_touch', 'linear']),
    defaultModel: 'last_touch',
  }),
  health: Object.freeze({
    healthyRatio: 3,
    watchRatio: 1,
    healthyPaybackMax: 12,
    watchPaybackMax: 18,
    romiRiskBelow: 0,
  }),
  ranking: Object.freeze({
    weights: Object.freeze({ cac: 0.3, romi: 0.3, ltvCac: 0.25, newCustomers: 0.15 }),
  }),
  periods: Object.freeze({
    defaultDays: 30,
    options: Object.freeze([30, 90, 180]),
  }),
  dashboard: Object.freeze({
    weeks: 12,
  }),
  saturation: Object.freeze({
    historyWeeks: 26,
    gridSteps: 60,
    // Seven weeks cannot separate a curve from noise; below eight positive-spend weeks the fit degrades to linear
    // with a visible note (metrics spec §6.1).
    minPositiveWeeks: 8,
    r2WarnBelow: 0.3,
    // Search bounds from metrics spec §6.1: K ∈ [1.05·max(q), 4·max(q)], S ∈ [0.33·mean(b), 3·max(b)].
    kMinFactor: 1.05,
    kMaxFactor: 4,
    sMinFactor: 0.33,
    sMaxFactor: 3,
  }),
  alerts: Object.freeze({
    windowWeeks: 4,
    // The page recalculation on GET is throttled to one hour per session (decision 2).
    autoRecalcMs: 3_600_000,
    // Exact fractions, not 1.2/1.5: the rule cross-multiplies integers, so a threshold can never drift by a float
    // rounding error at the boundary (6/5 = 1.2, 3/2 = 1.5).
    cacSpikeWarnRatio: Object.freeze({ num: 6, den: 5 }),
    cacSpikeCriticalRatio: Object.freeze({ num: 3, den: 2 }),
  }),
  scenarios: Object.freeze({
    // One multiplier drives both the slider maximum and the server-side cap (decision 4). A second literal 3 in the
    // UI or the service would let the two disagree, so every caller must read this value.
    maxBudgetMultiplier: 3,
    // Above twice the current weekly spend the forecast leaves the observed range and the UI warns about it.
    warnBudgetMultiplier: 2,
    // Metrics spec §6.3 uses the same 2× honesty limit for a single channel's predicted spend; the separate key lets
    // the extrapolation badge read the number without a second literal.
    extrapolationFactor: 2,
  }),
});
