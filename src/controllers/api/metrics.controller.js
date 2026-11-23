import { resolvePeriod } from '../../lib/periods.js';
import { parseQuery } from '../../lib/validation.js';
import { rankingQuerySchema } from '../../validators/metrics.schema.js';

/**
 * JSON API for the metrics screens. Every handler delegates the whole request pipeline to the page controller or
 * the same screen loader that produced the page's `data-props`, so `/api/v1/*` and the page cannot drift.
 *
 * `/api/v1/ranking` is the one deliberate exception: it returns the raw M3 report (`ranked`/`excluded`/`weights`)
 * because M5 and the weight tests consume it, while the channels page returns its own table model.
 *
 * @param {{
 *   dashboardController: ReturnType<typeof import('../dashboard.controller.js').createDashboardController>,
 *   cohortsController: ReturnType<typeof import('../cohorts.controller.js').createCohortsController>,
 *   channelsScreenLoader: (req: import('express').Request) => Promise<{ screen: object }>,
 *   channelPassportScreenLoader: (req: import('express').Request) => Promise<{ screen: object }>,
 *   rankingService: ReturnType<typeof import('../../services/metrics/ranking.service.js').createRankingService>,
 *   referenceRepository: ReturnType<typeof import('../../repositories/reference.repo.js').createReferenceRepository>,
 * }} deps
 */
export function createMetricsApiController({
  dashboardController,
  cohortsController,
  channelsScreenLoader,
  channelPassportScreenLoader,
  rankingService,
  referenceRepository,
}) {
  return {
    /**
     * Same object as the dashboard page's `data-props`.
     * @type {import('express').RequestHandler}
     */
    async dashboard(req, res) {
      const { screen } = await dashboardController.load(req);
      res.json(screen);
    },

    /**
     * Same object as the channels page's `data-props`.
     * @type {import('express').RequestHandler}
     */
    async channels(req, res) {
      const { screen } = await channelsScreenLoader(req);
      res.json(screen);
    },

    /**
     * Same object as the channel passport page's `data-props`.
     * @type {import('express').RequestHandler}
     */
    async channel(req, res) {
      const { screen } = await channelPassportScreenLoader(req);
      res.json(screen);
    },

    /**
     * Same object as the cohorts page's `data-props`.
     * @type {import('express').RequestHandler}
     */
    async cohorts(req, res) {
      const { screen } = await cohortsController.load(req);
      res.json(screen);
    },

    /**
     * Raw ranking report with weights, contributions and exclusions.
     * @type {import('express').RequestHandler}
     */
    async ranking(req, res) {
      const query = parseQuery(rankingQuerySchema, req.query);
      const anchor = await referenceRepository.getDataAnchor();
      const period = resolvePeriod({ anchor, days: query.days, from: query.from, to: query.to });
      const report = await rankingService.getRankingReport({
        anchor,
        from: period.from,
        to: period.to,
        weights: query.weights,
      });
      res.json(report);
    },
  };
}
