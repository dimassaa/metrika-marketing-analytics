import { buildShellLocals } from './app.controller.js';
import { parseQuery } from '../lib/validation.js';
import { buildCumulativeLtvCurve } from '../services/metrics/chart-series.js';
import { buildCohortsHorizonControl } from '../services/metrics/screen-models.js';
import { cohortsQuerySchema } from '../validators/metrics.schema.js';

/**
 * Loads the cohorts screen once for both the page and the JSON API.
 *
 * Sharing the loader is what keeps `data-props` and `/api/v1/cohorts` identical. The matrix is read from M3 with the
 * requested horizon; the curve is a pure aggregation of those same rows, so the heatmap and the line cannot describe
 * different cohorts. There is deliberately no daily period: a cohort lives on a monthly horizon.
 *
 * @param {{
 *   services: { ltv: { getCohortMatrix: Function } },
 *   screenModels: { cohorts: Function },
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 *   schema?: import('zod').ZodType<object>,
 * }} deps
 * @returns {(req: import('express').Request) => Promise<{
 *   query: object, anchor: string, screen: object,
 * }>}
 * @throws {import('../lib/errors.js').ValidationError} When the horizon or a cohort filter is invalid.
 */
export function createCohortsScreenLoader({
  services,
  screenModels,
  referenceRepository,
  schema = cohortsQuerySchema,
}) {
  return async function load(req) {
    const query = parseQuery(schema, req.query);
    const anchor = await referenceRepository.getDataAnchor();
    const matrix = await services.ltv.getCohortMatrix({
      anchor,
      horizonMonths: query.horizon,
      channelId: query.channelId,
      fromCohortMonth: query.fromCohortMonth,
      toCohortMonth: query.toCohortMonth,
    });
    const curve = buildCumulativeLtvCurve({
      cohorts: matrix.cohorts,
      horizonMonths: matrix.horizonMonths,
    });

    return { query, anchor, screen: screenModels.cohorts({ matrix, curve }) };
  };
}

/**
 * Cohorts page controller. The handler translates HTTP only: one loader call and one render. The horizon switch is
 * page-only navigation; its links replay `channelId` and even a manually supplied `days`, which this screen ignores.
 *
 * @param {{
 *   services: { ltv: { getCohortMatrix: Function } },
 *   screenModels: { cohorts: Function },
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 * }} deps
 * @returns {{
 *   load: (req: import('express').Request) => Promise<object>,
 *   page: import('express').RequestHandler,
 * }}
 */
export function createCohortsController({ services, screenModels, referenceRepository }) {
  const load = createCohortsScreenLoader({ services, screenModels, referenceRepository });

  return {
    load,

    /**
     * Renders the EJS frame: title, horizon switch and the single island mount node. No matrix cell is rendered on the
     * server, so `data-props` stays the only source of the numbers.
     * @type {import('express').RequestHandler}
     */
    async page(req, res) {
      const { query, anchor, screen } = await load(req);
      // `days` is not part of the cohort query, but plan decision 10 keeps a hand-typed `days` in horizon links.
      const replayedDays =
        typeof req.query.days === 'string' && req.query.days !== '' ? { days: req.query.days } : {};

      res.status(200).render('pages/cohorts', {
        ...buildShellLocals(req, { title: 'Когорты', activeNav: 'cohorts', dataAnchor: anchor }),
        model: screen,
        islandEntries: ['cohorts'],
        horizonControl: buildCohortsHorizonControl({
          query: { ...query, ...replayedDays },
          horizon: screen.horizonMonths,
        }),
      });
    },
  };
}
