/**
 * HTTP-facing decisions constants.
 *
 * Page sizes live here rather than as a literal in the repository, the service and the screen model: the list query,
 * `hasMore` and the rendered page count must agree, and a second hard-coded `50` is how one of them silently drifts.
 * `weeksPerYear` is the same number the UI uses for the 12-month budget forecast (`weekly × 52`).
 */
export const DECISIONS_CONFIG = Object.freeze({
  alertsPageSize: 50,
  scenariosPageSize: 50,
  weeksPerYear: 52,
});
