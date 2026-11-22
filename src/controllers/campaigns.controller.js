import { buildShellLocals } from './app.controller.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { buildSeo } from '../lib/seo.js';
import {
  campaignCreateSchema,
  campaignFiltersSchema,
  campaignFormValues,
  campaignUpdateSchema,
} from '../validators/campaigns.schema.js';

const CAMPAIGN_ID = /^\d+$/;
/** Largest value a PostgreSQL BIGINT primary key can hold (2^63 - 1). */
const MAX_BIGINT_ID = 9223372036854775807n;

const NOT_FOUND_SEO = buildSeo({
  title: 'Кампания не найдена — Метрика',
  description: 'Кампания не найдена: возможно, ссылка устарела. Вернитесь к списку кампаний.',
  path: '/app/campaigns',
  noindex: true,
});

/**
 * Validates the `:id` route param before it reaches SQL. A digit string above 2^63 - 1 is still digits, but
 * `$1::bigint` would reject it with SQLSTATE 22003 and turn a hand-typed URL into a 500; such ids cannot exist.
 * @param {unknown} value Raw `:id` route param.
 * @returns {string | null} Digit string inside the BIGINT range, or null for non-digits, zero and oversized values.
 */
function parseCampaignId(value) {
  const id = String(value ?? '');
  if (!CAMPAIGN_ID.test(id)) return null;
  const numeric = BigInt(id);
  return numeric >= 1n && numeric <= MAX_BIGINT_ID ? id : null;
}

/**
 * @param {import('express').Request} req
 * @returns {{ id: string, ip: string }} Actor for the audit trail; never carries secrets.
 */
function actorOf(req) {
  return { id: req.session.user.id, ip: req.ip };
}

/**
 * Campaign screens. Handlers translate HTTP only: parse with Zod, call one service method, render or redirect.
 * @param {{
 *   campaignsService: ReturnType<typeof import('../services/campaigns.service.js').createCampaignsService>,
 *   channelsService: ReturnType<typeof import('../services/channels.service.js').createChannelsService>,
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 * }} deps
 */
export function createCampaignsController({ campaignsService, channelsService, referenceRepository }) {
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
   * Renders the list, optionally with a rejected form. A validation failure is a 400 page, not a redirect: the person
   * stays with their values and the reason next to them.
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {{
   *   status?: number,
   *   filters?: object,
   *   createError?: string | null,
   *   createValues?: object,
   *   edit?: { id: string, values: object } | null,
   *   editError?: string | null,
   *   deleteError?: string | null,
   * }} [options]
   */
  async function renderList(
    req,
    res,
    {
      status = 200,
      filters = {},
      createError = null,
      createValues,
      edit = null,
      editError = null,
      deleteError = null,
    } = {},
  ) {
    const dataAnchor = await referenceRepository.getDataAnchor();
    const [list, channelList] = await Promise.all([
      campaignsService.listCampaignsForView(filters),
      channelsService.listChannelsForView(),
    ]);
    const activeChannels = channelList.channels.filter((channel) => channel.isActive);

    res.status(status).render('pages/campaigns', {
      ...buildShellLocals(req, { title: 'Кампании', activeNav: 'campaigns', dataAnchor }),
      filters: list.filters,
      campaigns: list.campaigns,
      totals: list.totals,
      limit: list.limit,
      limitReached: list.limitReached,
      channels: channelList.channels,
      activeChannels,
      createError,
      // A new campaign starts today (the data anchor) on the channel the list is filtered by: the two facts the
      // person would otherwise pick by hand.
      createValues: createValues ?? {
        channelId: list.filters.channelId === 'all' ? '' : list.filters.channelId,
        code: '',
        name: '',
        status: 'active',
        startedOn: dataAnchor,
        endedOn: '',
        budgetByn: '',
      },
      edit,
      editError,
      deleteError,
    });
  }

  return {
    /**
     * @type {import('express').RequestHandler}
     */
    async list(req, res) {
      const filters = campaignFiltersSchema.parse(req.query);
      const edit = filters.edit ? await campaignsService.getCampaignForm(filters.edit) : null;
      await renderList(req, res, { filters, edit });
    },

    /**
     * @type {import('express').RequestHandler}
     */
    async create(req, res) {
      const parsed = campaignCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        await renderList(req, res, {
          status: 400,
          createError: parsed.error.issues[0]?.message,
          createValues: campaignFormValues(req.body),
        });
        return;
      }

      let created;
      try {
        created = await campaignsService.createCampaign(parsed.data, actorOf(req));
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        await renderList(req, res, {
          status: 400,
          createError: error.message,
          createValues: campaignFormValues(req.body),
        });
        return;
      }

      // The quick-add form on the channel passport returns to that passport; the campaign page stays for everything
      // else. `from` is a fixed enum, so no user-controlled path can become a redirect target.
      res.redirect(parsed.data.from === 'channel' ? `/app/channels/${created.channelId}` : '/app/campaigns');
    },

    /**
     * @type {import('express').RequestHandler}
     */
    async update(req, res) {
      const id = parseCampaignId(req.params.id);
      if (id === null) {
        renderNotFound(res);
        return;
      }

      const parsed = campaignUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        await renderList(req, res, {
          status: 400,
          edit: { id, values: campaignFormValues(req.body) },
          editError: parsed.error.issues[0]?.message,
        });
        return;
      }

      try {
        await campaignsService.updateCampaign(id, parsed.data, actorOf(req));
      } catch (error) {
        if (error instanceof NotFoundError) {
          renderNotFound(res);
          return;
        }
        if (error instanceof ValidationError) {
          await renderList(req, res, {
            status: 400,
            edit: { id, values: campaignFormValues(req.body) },
            editError: error.message,
          });
          return;
        }
        throw error;
      }
      res.redirect('/app/campaigns');
    },

    /**
     * Deletes an empty campaign. The guard message is rendered on the list with the campaign still visible, so the
     * person can see what blocks the deletion and choose to finish the campaign instead.
     * @type {import('express').RequestHandler}
     */
    async delete(req, res) {
      const id = parseCampaignId(req.params.id);
      if (id === null) {
        renderNotFound(res);
        return;
      }

      try {
        await campaignsService.deleteCampaign(id, actorOf(req));
      } catch (error) {
        if (error instanceof NotFoundError) {
          renderNotFound(res);
          return;
        }
        if (error instanceof ValidationError) {
          await renderList(req, res, { status: 400, deleteError: error.message });
          return;
        }
        throw error;
      }
      res.redirect('/app/campaigns');
    },
  };
}
