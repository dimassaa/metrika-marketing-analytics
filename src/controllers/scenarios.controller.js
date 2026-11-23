import { NotFoundError, ValidationError } from '../lib/errors.js';
import { parseBigIntId } from '../lib/ids.js';
import { parseQuery } from '../lib/validation.js';
import { NO_CURVE_CHANNELS_MESSAGE } from '../services/decisions/scenarios.service.js';
import { scenarioQuerySchema, scenarioSaveSchema } from '../validators/scenarios.schema.js';
import { buildShellLocals } from './app.controller.js';
import { notFoundPage } from './public.controller.js';

/**
 * @param {import('express').Request} req
 * @returns {{ id: string, ip: string | null }}
 */
function actorOf(req) {
  return { id: req.session.user.id, ip: req.ip ?? null };
}

/**
 * Scenarios builder, detail and save controller.
 *
 * The builder page and `/api/v1/scenarios` share `loadBuilder`; the detail page and `/api/v1/scenarios/:id` share
 * `loadDetail`. The detail path reads the stored JSONB snapshot only — it never refits a curve or re-reads raw
 * metrics — so a saved scenario keeps its numbers after the data changes.
 *
 * @param {{
 *   services: { scenarios: object },
 *   screenModels: { scenarios: Function, scenarioDetail: Function },
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 *   channelsRepository?: ReturnType<typeof import('../repositories/channels.repo.js').createChannelsRepository> | null,
 * }} deps
 */
export function createScenariosController({
  services,
  screenModels,
  referenceRepository,
  channelsRepository = null,
}) {
  /**
   * @param {import('express').Request} req
   * @param {{ query?: object, anchor?: string }} [prepared]
   * @returns {Promise<{ query: object, anchor: string, screen: object }>}
   */
  async function loadBuilder(req, { query: preparedQuery, anchor: preparedAnchor } = {}) {
    const query = preparedQuery ?? parseQuery(scenarioQuerySchema, req.query);
    const anchor = preparedAnchor ?? (await referenceRepository.getDataAnchor());

    const [scenario, list, channels] = await Promise.all([
      services.scenarios.buildScenario({
        anchor,
        budgetByn: query.budgetByn ?? null,
        channelIds: query.channelIds ?? null,
        curveChannelId: query.curveChannelId ?? null,
      }),
      services.scenarios.listScenarios({ page: query.page }),
      channelsRepository ? channelsRepository.listChannels() : Promise.resolve([]),
    ]);

    return {
      query,
      anchor,
      screen: screenModels.scenarios({ scenario, list, query, anchor, channels }),
    };
  }

  /**
   * @param {string} id Raw route id.
   * @returns {Promise<{ screen: object }>}
   * @throws {NotFoundError} When the id is malformed or no scenario exists.
   */
  async function loadDetailById(id) {
    const scenarioId = parseBigIntId(id);
    if (scenarioId === null) throw new NotFoundError('Сценарий не найден');

    const scenario = await services.scenarios.getScenarioDetail(scenarioId);
    return { screen: screenModels.scenarioDetail({ scenario }) };
  }

  /**
   * @param {import('express').Request} req
   * @returns {Promise<{ screen: object }>}
   */
  async function loadDetail(req) {
    return loadDetailById(req.params.id);
  }

  return {
    loadBuilder,
    loadDetail,
    loadDetailById,

    /**
     * Renders the builder frame. The GET form recalculates from the URL; the island receives the resulting model.
     * @type {import('express').RequestHandler}
     */
    async page(req, res) {
      let anchor;
      let screen;
      try {
        ({ anchor, screen } = await loadBuilder(req));
      } catch (error) {
        // A fresh stand has channels but no 26 weeks of spend/customers. That is not a malformed request, so the
        // page shows the designed empty builder instead of a bare 400; the API keeps the validation error.
        if (!(error instanceof ValidationError) || error.message !== NO_CURVE_CHANNELS_MESSAGE) throw error;

        anchor = await referenceRepository.getDataAnchor();
        const [list, channels] = await Promise.all([
          services.scenarios.listScenarios({ page: 1 }),
          channelsRepository ? channelsRepository.listChannels() : Promise.resolve([]),
        ]);
        screen = screenModels.scenariosUnavailable({
          anchor,
          list,
          channels,
          error: 'Нет недель с расходом и новыми клиентами — распределять пока нечего.',
        });
      }

      res.set('Cache-Control', 'no-store');
      res.status(200).render('pages/scenarios', {
        ...buildShellLocals(req, { title: 'Сценарии', activeNav: 'scenarios', dataAnchor: anchor }),
        model: screen,
        islandEntries: screen.charts === null ? [] : ['scenarios'],
        currentPath: '/app/scenarios',
      });
    },

    /**
     * Renders a saved snapshot. A missing or malformed id gets the designed 404 page instead of a bare text 404.
     * @type {import('express').RequestHandler}
     */
    async detail(req, res) {
      let screen;
      try {
        ({ screen } = await loadDetail(req));
      } catch (error) {
        if (error instanceof NotFoundError) {
          notFoundPage(req, res);
          return;
        }
        throw error;
      }

      const dataAnchor = screen.savedAnchor ?? (await referenceRepository.getDataAnchor());
      res.set('Cache-Control', 'no-store');
      res.status(200).render('pages/scenario-detail', {
        ...buildShellLocals(req, { title: screen.name, activeNav: 'scenarios', dataAnchor }),
        model: screen,
        islandEntries: ['scenarios'],
        currentPath: '/app/scenarios',
      });
    },

    /**
     * Saves the server-recomputed snapshot and redirects to it. The client never sends a result: accepting one would
     * let a tampered page store numbers this server never produced.
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
        actorOf(req),
      );

      res.redirect(302, `/app/scenarios/${id}`);
    },
  };
}
