import { buildShellLocals } from './app.controller.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { buildSeo } from '../lib/seo.js';
import {
  channelCreateSchema,
  channelFiltersSchema,
  channelFormValues,
  channelUpdateSchema,
} from '../validators/channels.schema.js';

const CHANNEL_ID = /^\d+$/;
/** Largest value a PostgreSQL BIGINT primary key can hold (2^63 - 1). */
const MAX_BIGINT_ID = 9223372036854775807n;

const NOT_FOUND_SEO = buildSeo({
  title: 'Канал не найден — Метрика',
  description: 'Канал не найден: возможно, ссылка устарела. Вернитесь к списку каналов.',
  path: '/app/channels',
  noindex: true,
});

/** Empty create form, so the template always reads string values instead of undefined. */
const EMPTY_CREATE_FORM = Object.freeze({
  code: '',
  name: '',
  kind: 'paid',
  targetCacByn: '',
  targetRomiPct: '',
});

/**
 * Validates the `:id` route param before it reaches SQL.
 *
 * A digit string above 2^63 - 1 is still digits, but `$1::bigint` would reject it with SQLSTATE 22003 and turn a
 * hand-typed URL into a 500. Such ids cannot exist, so they get the same designed 404 as a missing channel.
 *
 * @param {unknown} value Raw `:id` route param.
 * @returns {string | null} Digit string inside the BIGINT range, or null for non-digits, zero and oversized values.
 */
function parseChannelId(value) {
  const id = String(value ?? '');
  if (!CHANNEL_ID.test(id)) return null;
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
 * Channel screens. Handlers translate HTTP only: parse with Zod, call one service method, render or redirect.
 * @param {{
 *   channelsService: ReturnType<typeof import('../services/channels.service.js').createChannelsService>,
 *   campaignsService: ReturnType<typeof import('../services/campaigns.service.js').createCampaignsService>,
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 * }} deps
 */
export function createChannelsController({ channelsService, campaignsService, referenceRepository }) {
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
   * Renders the list, optionally with a rejected create form. A validation failure is a 400 page, not a redirect:
   * the person stays on the form with their values and the reason next to it.
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {{ status?: number, filters?: object, error?: string | null, values?: object }} [options]
   */
  async function renderList(req, res, { status = 200, filters = {}, error = null, values } = {}) {
    const dataAnchor = await referenceRepository.getDataAnchor();
    const { filters: applied, channels } = await channelsService.listChannelsForView(filters);
    res.status(status).render('pages/channels', {
      ...buildShellLocals(req, { title: 'Каналы', activeNav: 'channels', dataAnchor }),
      filters: applied,
      channels,
      createError: error,
      createValues: values ?? EMPTY_CREATE_FORM,
    });
  }

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {string} id
   * @param {{ status?: number, error?: string | null, values?: object }} [options]
   */
  async function renderDetail(req, res, id, { status = 200, error = null, values } = {}) {
    const dataAnchor = await referenceRepository.getDataAnchor();
    const detail = await channelsService.getChannelDetail(id);
    // The passport shows this channel's campaigns and the quick-add form posts back into the campaigns controller.
    const channelCampaigns = await campaignsService.listCampaignsForChannel(id);
    res.status(status).render('pages/channel-detail', {
      ...buildShellLocals(req, { title: detail.channel.name, activeNav: 'channels', dataAnchor }),
      channel: detail.channel,
      formValues: values ?? detail.form,
      formError: error,
      channelCampaigns,
      campaignDefaults: { startedOn: dataAnchor },
      campaignCreateError: null,
      campaignCreateValues: { code: '', name: '', startedOn: dataAnchor, budgetByn: '' },
    });
  }

  return {
    /**
     * @type {import('express').RequestHandler}
     */
    async list(req, res) {
      await renderList(req, res, { filters: channelFiltersSchema.parse(req.query) });
    },

    /**
     * @type {import('express').RequestHandler}
     */
    async detail(req, res) {
      const id = parseChannelId(req.params.id);
      if (id === null) {
        renderNotFound(res);
        return;
      }
      try {
        await renderDetail(req, res, id);
      } catch (error) {
        if (error instanceof NotFoundError) {
          renderNotFound(res);
          return;
        }
        throw error;
      }
    },

    /**
     * @type {import('express').RequestHandler}
     */
    async create(req, res) {
      const parsed = channelCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        await renderList(req, res, {
          status: 400,
          error: parsed.error.issues[0]?.message,
          values: channelFormValues(req.body),
        });
        return;
      }

      try {
        await channelsService.createChannel(parsed.data, actorOf(req));
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        await renderList(req, res, {
          status: 400,
          error: error.message,
          values: channelFormValues(req.body),
        });
        return;
      }
      res.redirect('/app/channels');
    },

    /**
     * @type {import('express').RequestHandler}
     */
    async update(req, res) {
      const id = parseChannelId(req.params.id);
      if (id === null) {
        renderNotFound(res);
        return;
      }

      const parsed = channelUpdateSchema.safeParse(req.body);

      try {
        if (!parsed.success) {
          // Rendering the rejected form reads the channel too; a stale link must show the 404 page, not text/plain.
          await renderDetail(req, res, id, {
            status: 400,
            error: parsed.error.issues[0]?.message,
            values: channelFormValues(req.body),
          });
          return;
        }
        await channelsService.updateChannel(id, parsed.data, actorOf(req));
      } catch (error) {
        if (error instanceof NotFoundError) {
          renderNotFound(res);
          return;
        }
        throw error;
      }
      res.redirect(`/app/channels/${id}`);
    },

    /**
     * Toggles the archive flag. The guard message is rendered on the passport page with the channel still visible,
     * so the person can see the campaigns that block the change instead of a bare error.
     * @type {import('express').RequestHandler}
     */
    async archive(req, res) {
      const id = parseChannelId(req.params.id);
      if (id === null) {
        renderNotFound(res);
        return;
      }

      try {
        await channelsService.toggleChannelArchive(id, actorOf(req));
      } catch (error) {
        if (error instanceof NotFoundError) {
          renderNotFound(res);
          return;
        }
        if (error instanceof ValidationError) {
          await renderDetail(req, res, id, { status: 400, error: error.message });
          return;
        }
        throw error;
      }
      res.redirect(`/app/channels/${id}`);
    },
  };
}
