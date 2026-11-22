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
});
