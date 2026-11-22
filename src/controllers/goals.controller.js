import { buildShellLocals } from './app.controller.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { parseBigIntId } from '../lib/ids.js';
import { buildSeo } from '../lib/seo.js';
import {
  goalCreateSchema,
  goalFiltersSchema,
  goalFormValues,
  parseGoalUpdate,
} from '../validators/goals.schema.js';

const NOT_FOUND_SEO = buildSeo({
  title: 'Цель не найдена — Метрика',
  description: 'Цель не найдена: возможно, ссылка устарела. Вернитесь к списку целей.',
  path: '/app/goals',
  noindex: true,
});

/**
 * @param {import('express').Request} req
 * @returns {{ id: string, ip: string }} Actor for the audit trail; never carries secrets.
 */
function actorOf(req) {
  return { id: req.session.user.id, ip: req.ip };
}

/**
 * Goal screens. Handlers translate HTTP only: parse with Zod, call one service method, render or redirect.
 * @param {{
 *   goalsService: ReturnType<typeof import('../services/goals.service.js').createGoalsService>,
 *   channelsService: ReturnType<typeof import('../services/channels.service.js').createChannelsService>,
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 * }} deps
 */
export function createGoalsController({ goalsService, channelsService, referenceRepository }) {
  /**
   * @param {import('express').Response} res
   */
  function renderNotFound(res) {
    res.status(404).render('errors/404', {
      layout: 'layouts/public',
      seo: NOT_FOUND_SEO,
      year: new Date().getFullYear(),
    });
  }

  /**
   * Renders the list, optionally with a rejected create or edit form. A validation failure is a 400 page, not a
   * redirect: the person stays with their values and the reason next to them.
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {{
   *   status?: number,
   *   filters?: object,
   *   createError?: string | null,
   *   createValues?: object,
   *   edit?: object | null,
   *   editError?: string | null,
   * }} [options]
   */
  async function renderList(
    req,
    res,
    { status = 200, filters = {}, createError = null, createValues, edit = null, editError = null } = {},
  ) {
    const dataAnchor = await referenceRepository.getDataAnchor();
    const [list, channelList] = await Promise.all([
      goalsService.listGoalsForView(filters, dataAnchor),
      channelsService.listChannelsForView(),
    ]);

    res.status(status).render('pages/goals', {
      ...buildShellLocals(req, { title: 'Цели', activeNav: 'goals', dataAnchor }),
      filters: list.filters,
      goals: list.goals,
      metricOptions: list.metricOptions,
      channels: channelList.channels,
      createError,
      // The period is intentionally empty: the seeded global goals end on the data anchor, so prefilling
      // `anchor..anchor` for the default global CAC goal would overlap them and fail on the first submit. The date
      // inputs are required, so the person has to choose a real range instead of inheriting a hidden one.
      createValues: createValues ?? {
        metric: 'cac',
        channelId: '',
        targetValue: '',
        periodStart: '',
        periodEnd: '',
      },
      edit,
      editError,
    });
  }

  /**
   * Merges a rejected edit body over the stored goal. Metric and channel are immutable, so they always come from
   * the database; only the value and period reflect what the person submitted.
   * @param {string} id
   * @param {Record<string, unknown> | undefined} body
   * @returns {Promise<object | null>}
   */
  async function editFormValues(id, body) {
    const current = await goalsService.getGoalForm(id);
    if (!current) return null;
    const values = goalFormValues(body);
    return {
      id,
      values: {
        ...values,
        metric: current.values.metric,
        channelId: current.values.channelId,
      },
      metricLabel: current.metricLabel,
      metricUnit: current.metricUnit,
      channelLabel: current.channelLabel,
    };
  }

  return {
    /**
     * @type {import('express').RequestHandler}
     */
    async list(req, res) {
      const filters = goalFiltersSchema.parse(req.query);
      const edit = filters.edit ? await goalsService.getGoalForm(filters.edit) : null;
      await renderList(req, res, { filters, edit });
    },

    /**
     * @type {import('express').RequestHandler}
     */
    async create(req, res) {
      const values = goalFormValues(req.body);
      const parsed = goalCreateSchema.safeParse(req.body);

      if (!parsed.success) {
        await renderList(req, res, {
          status: 400,
          createError: parsed.error.issues[0]?.message,
          createValues: values,
        });
        return;
      }

      try {
        await goalsService.createGoal(parsed.data, actorOf(req));
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        await renderList(req, res, {
          status: 400,
          createError: error.message,
          createValues: values,
        });
        return;
      }
      res.redirect('/app/goals');
    },

    /**
     * @type {import('express').RequestHandler}
     */
    async update(req, res) {
      const id = parseBigIntId(req.params.id);
      if (id === null) {
        renderNotFound(res);
        return;
      }

      // The metric decides the unit of `target_value`, so the stored row has to supply it before the body is parsed.
      const current = await goalsService.getGoalForm(id);
      if (!current) {
        renderNotFound(res);
        return;
      }

      const parsed = parseGoalUpdate(current.values.metric, req.body);
      if (!parsed.success) {
        await renderList(req, res, {
          status: 400,
          edit: await editFormValues(id, req.body),
          editError: parsed.error.issues[0]?.message,
        });
        return;
      }

      try {
        await goalsService.updateGoal(id, parsed.data, actorOf(req));
      } catch (error) {
        if (error instanceof NotFoundError) {
          renderNotFound(res);
          return;
        }
        if (error instanceof ValidationError) {
          await renderList(req, res, {
            status: 400,
            edit: await editFormValues(id, req.body),
            editError: error.message,
          });
          return;
        }
        throw error;
      }
      res.redirect('/app/goals');
    },

    /**
     * @type {import('express').RequestHandler}
     */
    async delete(req, res) {
      const id = parseBigIntId(req.params.id);
      if (id === null) {
        renderNotFound(res);
        return;
      }

      try {
        await goalsService.deleteGoal(id, actorOf(req));
      } catch (error) {
        if (error instanceof NotFoundError) {
          renderNotFound(res);
          return;
        }
        throw error;
      }
      res.redirect('/app/goals');
    },
  };
}
