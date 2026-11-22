/**
 * JSON API for the metrics screens. Every handler delegates the whole request pipeline to the page controller
 * method that produced the equivalent screen model, so `/api/v1/dashboard` and the dashboard page cannot drift.
 *
 * @param {{
 *   dashboardController: ReturnType<typeof import('../dashboard.controller.js').createDashboardController>,
 * }} deps
 */
export function createMetricsApiController({ dashboardController }) {
  return {
    /**
     * Same object as the dashboard page's `data-props`.
     * @type {import('express').RequestHandler}
     */
    async dashboard(req, res) {
      const { screen } = await dashboardController.load(req);
      res.set('Cache-Control', 'no-store');
      res.json(screen);
    },
  };
}
