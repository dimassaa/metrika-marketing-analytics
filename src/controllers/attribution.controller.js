import { buildShellLocals } from './app.controller.js';
import { resolvePeriod } from '../lib/periods.js';
import { parseQuery } from '../lib/validation.js';
import { buildPeriodControl } from '../services/metrics/screen-models.js';
import { attributionQuerySchema } from '../validators/metrics.schema.js';

/**
 * Loads the attribution screen once for both the page and the JSON API.
 *
 * All three models are requested from M3 even though only one is selected: the service allocates them anyway for the
 * comparison, so the extra models cost no query but let the selector show every model's total and ROMI. Sharing the
 * loader is what keeps `data-props` and `/api/v1/attribution` identical.
 *
 * @param {{
 *   services: { attribution: { getAttributionReport: Function } },
 *   screenModels: { attribution: Function },
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 *   schema?: import('zod').ZodType<object>,
 * }} deps
 * @returns {(req: import('express').Request) => Promise<{
 *   query: object, anchor: string, period: object, screen: object,
 * }>}
 * @throws {import('../lib/errors.js').ValidationError} When the period or the model is invalid.
 */
export function createAttributionScreenLoader({
  services,
  screenModels,
  referenceRepository,
  schema = attributionQuerySchema,
}) {
  return async function load(req) {
    const query = parseQuery(schema, req.query);
    const anchor = await referenceRepository.getDataAnchor();
    const period = resolvePeriod({ anchor, days: query.days, from: query.from, to: query.to });
    const report = await services.attribution.getAttributionReport({
      from: period.from,
      to: period.to,
    });

    return {
      query,
      anchor,
      period,
      screen: screenModels.attribution({ report, model: query.model, period, query }),
    };
  };
}

/**
 * Attribution page controller. The handler translates HTTP only: one loader call and one render. The model switch is
 * a GET control inside the island, so the page needs no extra form markup of its own.
 *
 * @param {{
 *   services: { attribution: { getAttributionReport: Function } },
 *   screenModels: { attribution: Function },
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 * }} deps
 * @returns {{
 *   load: (req: import('express').Request) => Promise<object>,
 *   page: import('express').RequestHandler,
 * }}
 */
export function createAttributionController({ services, screenModels, referenceRepository }) {
  const load = createAttributionScreenLoader({ services, screenModels, referenceRepository });

  return {
    load,

    /**
     * Renders the EJS frame: title, period control and the single island mount node. No bar or table cell is rendered
     * on the server, so `data-props` stays the only source of the numbers.
     * @type {import('express').RequestHandler}
     */
    async page(req, res) {
      const { query, anchor, screen } = await load(req);

      res.set('Cache-Control', 'no-store');
      res.status(200).render('pages/attribution', {
        ...buildShellLocals(req, { title: 'Атрибуция', activeNav: 'attribution', dataAnchor: anchor }),
        model: screen,
        islandEntries: ['attribution'],
        periodControl: buildPeriodControl({ query, period: screen.period }),
        currentPath: `${req.baseUrl}${req.path}`,
      });
    },
  };
}
