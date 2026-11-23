import { buildShellLocals } from './app.controller.js';
import { resolvePeriod } from '../lib/periods.js';
import { parseQuery } from '../lib/validation.js';
import { buildChannelFilterControl, buildPeriodControl } from '../services/metrics/screen-models.js';
import { dashboardQuerySchema } from '../validators/metrics.schema.js';

/**
 * Dashboard page controller.
 *
 * The period is resolved here, once, and the service receives `{ from, to }` instead of `days`. Both the page and
 * the API go through `load`, so the two render paths cannot resolve a different window or build a different model.
 *
 * @param {{
 *   services: { dashboard: { getDashboardSummary: Function } },
 *   screenModels: { dashboard: Function },
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 * }} deps
 */
export function createDashboardController({ services, screenModels, referenceRepository }) {
  /**
   * @param {import('express').Request} req
   * @returns {Promise<{
   *   query: object,
   *   anchor: string,
   *   screen: object,
   * }>}
   * @throws {import('../lib/errors.js').ValidationError} When a query parameter is invalid.
   */
  async function load(req) {
    const query = parseQuery(dashboardQuerySchema, req.query);
    const anchor = await referenceRepository.getDataAnchor();
    const period = resolvePeriod({ anchor, days: query.days, from: query.from, to: query.to });
    const summary = await services.dashboard.getDashboardSummary({
      anchor,
      from: period.from,
      to: period.to,
      channelIds: query.channelIds,
    });

    return {
      query,
      anchor,
      screen: screenModels.dashboard({ summary, channelIds: query.channelIds }),
    };
  }

  return {
    load,

    /**
     * Renders the EJS frame: topbar, title and the single island mount node. No KPI value is rendered here, which
     * is why the screen has exactly one source for its numbers.
     * @type {import('express').RequestHandler}
     */
    async page(req, res) {
      const { query, anchor, screen } = await load(req);

      res.set('Cache-Control', 'no-store');
      res.render('pages/dashboard', {
        ...buildShellLocals(req, { title: 'Дашборд', activeNav: 'dashboard', dataAnchor: anchor }),
        model: screen,
        islandEntries: ['dashboard'],
        periodControl: buildPeriodControl({ query, period: screen.period }),
        filterControl: buildChannelFilterControl({ options: screen.channelOptions, query }),
        currentPath: `${req.baseUrl}${req.path}`,
      });
    },
  };
}
