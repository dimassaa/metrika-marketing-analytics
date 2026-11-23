import { parseQuery } from '../../lib/validation.js';
import { scenarioSaveSchema } from '../../validators/scenarios.schema.js';

/**
 * JSON API for alerts and scenarios.
 *
 * The read handlers delegate to the exact loader the page uses. The alert mutations reuse the API-mode alerts
 * controller, which already answers JSON and reads the CSRF header through the global middleware. Saving a scenario
 * is the only handler that composes two calls (write, then detail) because the 201 body must be the same detail the
 * GET returns.
 *
 * @param {{
 *   alertsController: ReturnType<typeof import('../alerts.controller.js').createAlertsController>,
 *   scenariosController: ReturnType<typeof import('../scenarios.controller.js').createScenariosController>,
 *   services: { scenarios: object },
 *   referenceRepository: ReturnType<typeof import('../../repositories/reference.repo.js').createReferenceRepository>,
 * }} deps
 */
export function createDecisionsApiController({
  alertsController,
  scenariosController,
  services,
  referenceRepository,
}) {
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
      const parsed = parseQuery(scenarioSaveSchema, req.body);
      const anchor = parsed.anchor ?? (await referenceRepository.getDataAnchor());
      const { id } = await services.scenarios.saveScenario(
        {
          name: parsed.name,
          budgetByn: parsed.budgetByn ?? null,
          channelIds: parsed.channelIds ?? null,
          anchor,
        },
        { id: req.session.user.id, ip: req.ip ?? null },
      );
      const { screen } = await scenariosController.loadDetailById(id);

      res.set('Cache-Control', 'no-store');
      res.status(201).json(screen);
    },
  };
}
