import { createAttributionRepository } from '../../repositories/attribution.repo.js';
import { createCampaignsRepository } from '../../repositories/campaigns.repo.js';
import { createChannelsRepository } from '../../repositories/channels.repo.js';
import { createCohortsRepository } from '../../repositories/cohorts.repo.js';
import { createMetricsRepository } from '../../repositories/metrics.repo.js';
import { createMetricsApiController } from '../../controllers/api/metrics.controller.js';
import { createChannelPassportLoader, createChannelsScreenLoader } from '../../controllers/channels.controller.js';
import { createDashboardController } from '../../controllers/dashboard.controller.js';
import { createAttributionService } from './attribution.service.js';
import { createCacService } from './cac.service.js';
import { createChannelListService } from './channel-list.service.js';
import { createChannelPassportService } from './channel-passport.service.js';
import { createDashboardService } from './dashboard.service.js';
import { createLtvService } from './ltv.service.js';
import { createRankingService } from './ranking.service.js';
import { createChannelHealthService } from './romi.service.js';
import { buildChannelsScreen, buildDashboardScreen, buildPassportScreen } from './screen-models.js';
import { channelsQuerySchema } from '../../validators/metrics.schema.js';

/**
 * Composition root for the metrics engine.
 *
 * This is the only place that knows how the repositories fit together. Routers receive ready controllers and
 * services, so adding the passport, cohort or attribution screens later means adding them here, not teaching
 * `src/app.js` and two routers a second wiring recipe.
 *
 * The repositories are stateless wrappers around the shared pool. Building a second `channels` repository that the
 * M2 channel controller also builds is harmless: neither holds state, and a shared instance would only make the
 * dependency graph harder to read.
 *
 * @param {{
 *   db: { query: Function } & Partial<import('pg').Pool>,
 *   referenceRepository: ReturnType<typeof import('../../repositories/reference.repo.js').createReferenceRepository>,
 * }} deps `referenceRepository` supplies the data anchor every metrics request is resolved against.
 * @returns {{
 *   repository: ReturnType<typeof createMetricsRepository>,
 *   repositories: Record<string, object>,
 *   services: Record<string, object>,
 *   controllers: Record<string, object>,
 *   screenModels: Record<string, Function>,
 *   loaders: Record<string, Function>,
 * }}
 * @throws {TypeError} When the database or the data-anchor repository is missing.
 */
export function createMetricsModule({ db, referenceRepository = null } = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('createMetricsModule requires a db object with a query(text, params) method');
  }
  if (!referenceRepository || typeof referenceRepository.getDataAnchor !== 'function') {
    throw new TypeError('createMetricsModule requires a referenceRepository with getDataAnchor()');
  }

  const repository = createMetricsRepository(db);
  const channelsRepository = createChannelsRepository(db);
  const campaignsRepository = createCampaignsRepository(db);
  const cohortsRepository = createCohortsRepository(db);
  const attributionRepository = createAttributionRepository(db);

  const cacService = createCacService({ metricsRepository: repository });
  const ltvService = createLtvService({ cohortsRepository });
  const attributionService = createAttributionService({
    attributionRepository,
    metricsRepository: repository,
    channelsRepository,
  });
  const channelHealthService = createChannelHealthService({
    cacService,
    ltvService,
    attributionService,
    channelsRepository,
  });
  const dashboardService = createDashboardService({
    healthService: channelHealthService,
    metricsRepository: repository,
    attributionService,
  });
  const rankingService = createRankingService({ healthService: channelHealthService });
  const channelListService = createChannelListService({
    healthService: channelHealthService,
    metricsRepository: repository,
    channelsRepository,
  });
  const channelPassportService = createChannelPassportService({
    healthService: channelHealthService,
    metricsRepository: repository,
    attributionService,
    channelsRepository,
    campaignsRepository,
  });

  const services = {
    cac: cacService,
    ltv: ltvService,
    attribution: attributionService,
    channelHealth: channelHealthService,
    ranking: rankingService,
    dashboard: dashboardService,
    channelList: channelListService,
    channelPassport: channelPassportService,
  };
  const screenModels = {
    dashboard: buildDashboardScreen,
    channels: buildChannelsScreen,
    passport: buildPassportScreen,
  };
  const loaders = {
    channels: createChannelsScreenLoader({ services, screenModels, referenceRepository }),
    channelsApi: createChannelsScreenLoader({
      services,
      screenModels,
      referenceRepository,
      schema: channelsQuerySchema,
    }),
    channelPassport: createChannelPassportLoader({ services, screenModels, referenceRepository }),
  };
  const dashboardController = createDashboardController({ services, screenModels, referenceRepository });
  const apiController = createMetricsApiController({
    dashboardController,
    channelsScreenLoader: loaders.channelsApi,
    channelPassportScreenLoader: loaders.channelPassport,
    rankingService,
    referenceRepository,
  });

  return {
    repository,
    repositories: {
      metrics: repository,
      channels: channelsRepository,
      campaigns: campaignsRepository,
      cohorts: cohortsRepository,
      attribution: attributionRepository,
    },
    services,
    controllers: { dashboard: dashboardController, api: apiController },
    screenModels,
    loaders,
  };
}
