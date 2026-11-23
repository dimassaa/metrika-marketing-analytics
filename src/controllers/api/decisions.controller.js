/**
 * JSON API for alerts and scenarios.
 *
 * The read handlers delegate to the exact loader the page uses. The alert mutations reuse the API-mode alerts
 * controller, which already answers JSON and reads the CSRF header through the global middleware. Scenario save uses
 * the controller's shared `persistScenario` pipeline, then reads the detail the same way the page does.
 *
 * @param {{
 *   alertsController: ReturnType<typeof import('../alerts.controller.js').createAlertsController>,
 *   scenariosController: ReturnType<typeof import('../scenarios.controller.js').createScenariosController>,
 * }} deps
 */
export function createDecisionsApiController({ alertsController, scenariosController }) {
  return {
    /**
     * Same object as the alerts page's `data-props`.
     * @type {import('express').RequestHandler}
     */
    async alerts(req, res) {
      const { screen } = await alertsController.load(req);
      res.json(screen);
    },

    /** Manual recalculation, JSON. */
    recalculate: (req, res) => alertsController.recalculate(req, res),

    /** Dismissal, JSON. */
    dismiss: (req, res) => alertsController.dismiss(req, res),

    /**
     * Same object as the scenarios builder page's `data-props`.
     * @type {import('express').RequestHandler}
     */
    async scenarios(req, res) {
      const { screen } = await scenariosController.loadBuilder(req);
      res.json(screen);
    },

    /**
     * Same object as the scenario detail page's `data-props`.
     * @type {import('express').RequestHandler}
     */
    async scenario(req, res) {
      const { screen } = await scenariosController.loadDetail(req);
      res.json(screen);
    },

    /**
     * Saves a server-recomputed snapshot and answers 201 with the detail model.
     * @type {import('express').RequestHandler}
     */
    async save(req, res) {
      const id = await scenariosController.persistScenario(req);
      const { screen } = await scenariosController.loadDetailById(id);

      res.set('Cache-Control', 'no-store');
      res.status(201).json(screen);
    },
  };
}
