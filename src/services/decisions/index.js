import { createAttributionRepository } from '../../repositories/attribution.repo.js';
import { createChannelsRepository } from '../../repositories/channels.repo.js';
import { createCohortsRepository } from '../../repositories/cohorts.repo.js';
import { createMetricsRepository } from '../../repositories/metrics.repo.js';
import { createAlertsRepository } from '../../repositories/alerts.repo.js';
import { createScenariosRepository } from '../../repositories/scenarios.repo.js';
import { createAlertsController } from '../../controllers/alerts.controller.js';
import { createScenariosController } from '../../controllers/scenarios.controller.js';
import { createDecisionsApiController } from '../../controllers/api/decisions.controller.js';
import { createAttributionService } from '../metrics/attribution.service.js';
import { createLtvService } from '../metrics/ltv.service.js';
import { createAlertsService } from './alerts.service.js';
import { createScenariosService } from './scenarios.service.js';
import {
  buildAlertsScreen,
  buildScenarioDetailScreen,
  buildScenariosScreen,
  buildScenariosUnavailableScreen,
} from './screen-models.js';

/**
 * Composition root for the decisions module (alerts and scenarios).
 *
 * The module is built after `createMetricsModule` and reuses its repositories and the two metric services the
 * decisions services need. That is deliberate: a second attribution or LTV composition would read the same tables
 * with different wiring and could drift in a refactor. When `metrics` is omitted the module builds those pieces from
 * `db`, so a focused unit/integration test can construct the decisions services without the whole app.
 *
 * Transaction-scoped audit writers are not injected from here. Both services default to a factory that receives the
 * transaction client, which is the only way "status and audit row commit together" can be true. A test may pass
 * `auditServiceFactory` to prove the rollback.
 *
 * @param {{
 *   db: { query: Function, connect: Function } & Partial<import('pg').Pool>,
 *   referenceRepository: ReturnType<typeof import('../../repositories/reference.repo.js').createReferenceRepository>,
 *   auditServiceFactory?: (client: import('pg').PoolClient) => object,
 *   metrics?: ReturnType<typeof import('../metrics/index.js').createMetricsModule>,
 * }} deps
 * @returns {{
 *   repositories: Record<string, object>,
 *   services: Record<string, object>,
 *   controllers: Record<string, object>,
 *   screenModels: Record<string, Function>,
 *   loaders: Record<string, Function>,
 * }}
 * @throws {TypeError} When the database or the data-anchor repository is missing.
 */
export function createDecisionsModule({ db, referenceRepository, auditServiceFactory, metrics } = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('createDecisionsModule requires a db object with query(text, params)');
  }
  if (!referenceRepository || typeof referenceRepository.getDataAnchor !== 'function') {
    throw new TypeError('createDecisionsModule requires a referenceRepository with getDataAnchor()');
  }

  const metricsRepository = metrics?.repositories?.metrics ?? createMetricsRepository(db);
  const channelsRepository = metrics?.repositories?.channels ?? createChannelsRepository(db);
  const attributionService = metrics?.services?.attribution ?? createAttributionService({
    attributionRepository: createAttributionRepository(db),
    metricsRepository,
    channelsRepository,
  });
  const ltvService = metrics?.services?.ltv ?? createLtvService({
    cohortsRepository: createCohortsRepository(db),
  });

  const alertsRepository = createAlertsRepository(db);
  const scenariosRepository = createScenariosRepository(db);
  const auditDeps = auditServiceFactory ? { auditServiceFactory } : {};

  const alertsService = createAlertsService({
    db,
    metricsRepository,
    channelsRepository,
    attributionService,
    ltvService,
    ...auditDeps,
  });
  const scenariosService = createScenariosService({
    db,
    metricsRepository,
    channelsRepository,
    ltvService,
    ...auditDeps,
  });

  const services = { alerts: alertsService, scenarios: scenariosService };
  const screenModels = {
    alerts: buildAlertsScreen,
    scenarios: buildScenariosScreen,
    scenariosUnavailable: buildScenariosUnavailableScreen,
    scenarioDetail: buildScenarioDetailScreen,
  };
  const alertsController = createAlertsController({
    services,
    screenModels,
    referenceRepository,
    channelsRepository,
  });
  const alertsApiController = createAlertsController({
    services,
    screenModels,
    referenceRepository,
    channelsRepository,
    alertsApi: true,
  });
  const scenariosController = createScenariosController({
    services,
    screenModels,
    referenceRepository,
    channelsRepository,
  });
  const apiController = createDecisionsApiController({
    alertsController: alertsApiController,
    scenariosController,
  });

  return {
    repositories: { alerts: alertsRepository, scenarios: scenariosRepository },
    services,
    controllers: {
      alerts: alertsController,
      scenarios: scenariosController,
      api: apiController,
    },
    screenModels,
    loaders: {
      alerts: alertsController.load,
      scenarios: scenariosController.loadBuilder,
      scenarioDetail: scenariosController.loadDetail,
    },
  };
}
