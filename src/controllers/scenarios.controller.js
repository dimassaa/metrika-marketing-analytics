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
 * Reads the builder inputs without trusting the schema. Used only when `scenarioQuerySchema` already rejected the
 * query: the styled error page still has to show the person what they entered instead of a bare 400.
 *
 * @param {import('express').Request} req
 * @returns {{ budgetByn: unknown, channelIds: string[] | null, curveChannelId: unknown, page: number }}
 */
function rawBuilderQuery(req) {
  const rawChannels = req.query.channelIds;
  let channelIds = null;
  if (rawChannels !== null && rawChannels !== undefined) {
    const list = (Array.isArray(rawChannels) ? rawChannels : [rawChannels])
      .flatMap((value) => String(value).split(','))
      .map((value) => value.trim())
      .filter((value) => value !== '');
    channelIds = list.length > 0 ? list : null;
  }
  return {
    budgetByn: req.query.budgetByn ?? null,
    channelIds,
    curveChannelId: req.query.curveChannelId ?? null,
    page: 1,
  };
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
 *   screenModels: { scenarios: Function, scenarioDetail: Function, scenariosUnavailable: Function,
 *     scenariosError: Function },
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
   * @param {{ query?: object, anchor?: string, strictCurve?: boolean }} [prepared] Already parsed query, anchor and
   *   the curve policy. `strictCurve` keeps the service's rejection for the JSON API; the page tolerates a stale
   *   selector because a presentation choice must not turn a valid channel set into a 400.
   * @returns {Promise<{ query: object, anchor: string, screen: object }>}
   */
  async function loadBuilder(
    req,
    { query: preparedQuery, anchor: preparedAnchor, strictCurve = false } = {},
  ) {
    const query = preparedQuery ?? parseQuery(scenarioQuerySchema, req.query);
    const anchor = preparedAnchor ?? (await referenceRepository.getDataAnchor());

    // The curve channel is a presentation choice. A stale select value must not turn a valid channel set into a 400:
    // when the requested curve is not part of the selected channels (or no longer exists), drop it and let the model
    // fall back to the first fitted channel. The API keeps the service's strict rejection on purpose.
    const channels = channelsRepository ? await channelsRepository.listChannels() : [];
    const requestedCurve = query.curveChannelId === null || query.curveChannelId === undefined
      ? null
      : String(query.curveChannelId);
    const selectableIds = (query.channelIds ?? channels.map((channel) => channel.id)).map(String);
    const canValidateCurve =
      (query.channelIds !== null && query.channelIds !== undefined) || channels.length > 0;
    const curveFallback = !strictCurve &&
      requestedCurve !== null &&
      canValidateCurve &&
      !selectableIds.includes(requestedCurve);
    const curveChannelId = curveFallback ? null : requestedCurve;

    const [scenario, list] = await Promise.all([
      services.scenarios.buildScenario({
        anchor,
        budgetByn: query.budgetByn ?? null,
        channelIds: query.channelIds ?? null,
        curveChannelId,
      }),
      services.scenarios.listScenarios({ page: query.page }),
    ]);

    return {
      query,
      anchor,
      screen: screenModels.scenarios({ scenario, list, query, anchor, channels, curveFallback }),
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

  /**
   * Saves the server-recomputed snapshot from one request and returns its id.
   *
   * The data anchor is always read from the database; the request body cannot override it. Both the HTML form and the
   * JSON API call this one function, so the anchor rule and the audit shape cannot drift between the two paths.
   *
   * @param {import('express').Request} req
   * @returns {Promise<string>} New scenario id.
   */
  async function persistScenario(req) {
    const parsed = parseQuery(scenarioSaveSchema, req.body);
    const anchor = await referenceRepository.getDataAnchor();
    const { id } = await services.scenarios.saveScenario(
      {
        name: parsed.name,
        budgetByn: parsed.budgetByn ?? null,
        channelIds: parsed.channelIds ?? null,
        anchor,
      },
      actorOf(req),
    );
    return id;
  }

  return {
    loadBuilder,
    loadDetail,
    loadDetailById,
    persistScenario,

    /**
     * Renders the builder frame. The GET form recalculates from the URL; the island receives the resulting model.
     *
     * A builder failure is a page state, not a bare-text 400: a malformed or infeasible budget renders the parameter
     * form with a styled error card and the entered values. The JSON API keeps the strict validation response. The one
     * exception is "no curve can be fitted": that is an empty stand, not a malformed request, and gets the designed
     * empty builder with a 200.
     * @type {import('express').RequestHandler}
     */
    async page(req, res) {
      const anchor = await referenceRepository.getDataAnchor();
      let query;
      let failure = null;
      try {
        query = parseQuery(scenarioQuerySchema, req.query);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        failure = error;
        query = rawBuilderQuery(req);
      }

      let screen;
      if (failure === null) {
        try {
          ({ screen } = await loadBuilder(req, { query, anchor }));
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          failure = error;
        }
      }

      if (failure !== null) {
        const [list, channels] = await Promise.all([
          services.scenarios.listScenarios({ page: 1 }),
          channelsRepository ? channelsRepository.listChannels() : Promise.resolve([]),
        ]);
        if (failure.message === NO_CURVE_CHANNELS_MESSAGE) {
          screen = screenModels.scenariosUnavailable({
            anchor,
            list,
            channels,
            error:
              'Кривая насыщения не построена: ни один выбранный канал не набрал восьми недель одновременно с ' +
              'расходом и новыми клиентами.',
          });
        } else {
          // A rejected budget or channel set still needs the feasible slider bounds. A successful default-budget
          // build gives the optimizable baseline and channel count without trusting the rejected value; when it also
          // fails (zero baseline, unknown channel), the model falls back to the one-kopeck floor.
          let baselineScenario = null;
          try {
            baselineScenario = await services.scenarios.buildScenario({
              anchor,
              channelIds: query.channelIds ?? null,
            });
          } catch (baselineError) {
            if (!(baselineError instanceof ValidationError)) throw baselineError;
          }
          screen = screenModels.scenariosError({
            anchor,
            list,
            channels,
            query,
            baselineScenario,
            error: failure.message,
          });
        }
      }

      res.set('Cache-Control', 'no-store');
      res.status(screen.builderError ? 400 : 200).render('pages/scenarios', {
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
      const id = await persistScenario(req);
      res.redirect(302, `/app/scenarios/${id}`);
    },
  };
}
