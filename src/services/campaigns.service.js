import { AUDIT_ACTIONS } from '../config/audit-actions.js';
import { formatDateRu } from '../lib/dates.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { formatCentsToByn, formatInteger } from '../lib/format.js';
import { CAMPAIGN_LIST_LIMIT } from '../repositories/campaigns.repo.js';

/** Russian labels for the status codes; the codes themselves stay English in SQL, forms and audit. */
const STATUS_LABELS = Object.freeze({ active: 'Активна', paused: 'На паузе', finished: 'Завершена' });
/** Badge tones reuse the shared status vocabulary: running = healthy, paused = watch, finished = neutral. */
const STATUS_TONES = Object.freeze({ active: 'healthy', paused: 'watch', finished: 'neutral' });

const DUPLICATE_CODE = 'Кампания с таким кодом уже существует';
const CHANNEL_NOT_FOUND = 'Канал не найден';
const ARCHIVED_CHANNEL_GUARD =
  'Нельзя создать кампанию для архивного канала: выберите активный канал или верните канал из архива';
const DELETE_GUARD =
  'Нельзя удалить кампанию со статистикой или заказами — переведите её в статус «Завершена»';
const CAMPAIGN_NOT_FOUND = 'Кампания не найдена';
const ARCHIVED_CHANNEL_ACTIVATION =
  'Нельзя активировать кампанию архивного канала: верните канал из архива';

/**
 * Repository row → list/passport view model. Formatting lives here rather than in EJS because templates must not
 * compute formulas or money strings (AGENTS.md §4, §6).
 * @param {object} campaign Campaign row from the repository.
 * @returns {Record<string, any>}
 */
function toView(campaign) {
  return {
    ...campaign,
    statusLabel: STATUS_LABELS[campaign.status] ?? campaign.status,
    statusTone: STATUS_TONES[campaign.status] ?? 'neutral',
    startedOnLabel: formatDateRu(campaign.startedOn),
    endedOnLabel: campaign.endedOn ? formatDateRu(campaign.endedOn) : null,
    budgetLabel: campaign.budgetCents === null ? null : formatCentsToByn(campaign.budgetCents),
    spendLabel: campaign.spendCents === null ? null : formatCentsToByn(campaign.spendCents),
    statsCountLabel: formatInteger(campaign.statsCount ?? 0),
  };
}

/**
 * Prefills the edit form with the same spellings the create form accepts: BYN with a comma, ISO dates.
 * @param {object} campaign Repository row.
 * @returns {{ code: string, name: string, status: string, startedOn: string, endedOn: string, budgetByn: string, channelName: string | null }}
 */
function toFormValues(campaign) {
  return {
    code: campaign.code,
    name: campaign.name,
    status: campaign.status,
    startedOn: campaign.startedOn,
    endedOn: campaign.endedOn ?? '',
    budgetByn: campaign.budgetCents === null ? '' : formatCentsToByn(campaign.budgetCents),
    channelName: campaign.channelName,
    channelIsActive: campaign.channelIsActive,
  };
}

/**
 * Audit payload. Cents become decimal strings on purpose: JSON.stringify cannot serialize a bigint, and the log keeps
 * the exact kopeck count without a float intermediate. No session data or e-mail lands here.
 * @param {object} campaign Repository row.
 * @returns {Record<string, unknown>}
 */
function auditPayload(campaign) {
  return {
    code: campaign.code,
    name: campaign.name,
    channelId: campaign.channelId,
    status: campaign.status,
    startedOn: campaign.startedOn,
    endedOn: campaign.endedOn,
    budgetCents: campaign.budgetCents === null ? null : campaign.budgetCents.toString(),
  };
}

/**
 * Campaign rules: the archived-channel guard, duplicate codes, the delete guard and the audit trail. Express is
 * invisible here; the service receives validated primitives and an `actor` taken from the session by the controller.
 * @param {{
 *   campaignsRepository: ReturnType<typeof import('../repositories/campaigns.repo.js').createCampaignsRepository>,
 *   channelsRepository: ReturnType<typeof import('../repositories/channels.repo.js').createChannelsRepository>,
 *   auditService: ReturnType<typeof import('./audit.service.js').createAuditService>,
 * }} deps
 */
export function createCampaignsService({ campaignsRepository, channelsRepository, auditService }) {
  /**
   * @param {{ id?: string, ip?: string } | null | undefined} actor
   * @param {string} action One of `AUDIT_ACTIONS`.
   * @param {object} campaign Campaign state after the change.
   * @returns {Promise<void>}
   */
  async function recordAudit(actor, action, campaign) {
    await auditService.record({
      userId: actor?.id ?? null,
      action,
      entity: 'campaign',
      entityId: campaign.id,
      payload: auditPayload(campaign),
      ip: actor?.ip ?? null,
    });
  }

  return {
    /**
     * @param {{ channelId?: string, status?: string, q?: string }} [filters] `all` or an empty query disables a
     *   condition; the controller passes the Zod-normalized values straight through.
     * @returns {Promise<{
     *   filters: { channelId: string, status: string, q: string },
     *   campaigns: object[],
     *   totals: { countLabel: string, budgetLabel: string, spendLabel: string },
     *   limit: number,
     *   limitReached: boolean,
     * }>}
     */
    async listCampaignsForView({ channelId = 'all', status = 'all', q = '' } = {}) {
      const search = q.trim();
      const rows = await campaignsRepository.listCampaigns({
        channelId: channelId === 'all' ? null : channelId,
        status: status === 'all' ? null : status,
        search: search === '' ? null : search,
      });

      // The repository fetches LIMIT + 1, so "more than the cap" is distinguishable from "exactly the cap": at 200
      // rows the page must not claim it hid anything.
      const limitReached = rows.length > CAMPAIGN_LIST_LIMIT;
      const visibleRows = limitReached ? rows.slice(0, CAMPAIGN_LIST_LIMIT) : rows;

      // Totals are summed from the already-loaded rows: a second aggregate query would count a different snapshot if
      // a campaign changed between the two statements, and the list is capped at 200 rows anyway.
      let budgetSum = 0n;
      let spendSum = 0n;
      for (const row of visibleRows) {
        if (row.budgetCents !== null) budgetSum += row.budgetCents;
        if (row.spendCents !== null) spendSum += row.spendCents;
      }

      return {
        filters: { channelId, status, q: search },
        campaigns: visibleRows.map(toView),
        totals: {
          countLabel: formatInteger(visibleRows.length),
          budgetLabel: formatCentsToByn(budgetSum),
          spendLabel: formatCentsToByn(spendSum),
        },
        limit: CAMPAIGN_LIST_LIMIT,
        limitReached,
      };
    },

    /**
     * Campaigns of one channel for the passport section. Reuses the list query so the two tables cannot disagree
     * about ordering or aggregates.
     * @param {string} channelId
     * @returns {Promise<object[]>}
     */
    async listCampaignsForChannel(channelId) {
      const rows = await campaignsRepository.listCampaignsByChannel(channelId);
      return rows.map(toView);
    },

    /**
     * @param {string} id
     * @returns {Promise<{ id: string, values: object } | null>} Null when the id is gone, so a stale edit link can
     *   fall back to the ordinary list instead of a 404 for a page that still exists.
     */
    async getCampaignForm(id) {
      const campaign = await campaignsRepository.findCampaignById(id);
      return campaign ? { id: campaign.id, values: toFormValues(campaign) } : null;
    },

    /**
     * @param {{
     *   channelId: string, code: string, name: string, status: string,
     *   startedOn: string, endedOn: string | null, budgetCents: bigint | null,
     * }} input
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<object>} Created campaign view model.
     * @throws {ValidationError} When the channel is missing/archived or the code is already taken.
     */
    async createCampaign(input, actor) {
      const channel = await channelsRepository.findChannelById(input.channelId);
      if (!channel) throw new ValidationError(CHANNEL_NOT_FOUND);
      if (!channel.isActive) throw new ValidationError(ARCHIVED_CHANNEL_GUARD);

      // The pre-check gives the common case a clean error; the SQLSTATE catch below still covers two parallel submits.
      if (await campaignsRepository.findCampaignByCode(input.code)) {
        throw new ValidationError(DUPLICATE_CODE);
      }

      let id;
      try {
        id = await campaignsRepository.createCampaign(input);
      } catch (error) {
        if (error?.code === '23505') throw new ValidationError(DUPLICATE_CODE);
        throw error;
      }

      const created = await campaignsRepository.findCampaignById(id);
      if (!created) throw new NotFoundError(CAMPAIGN_NOT_FOUND);
      await recordAudit(actor, AUDIT_ACTIONS.CAMPAIGN_CREATE, created);
      return toView(created);
    },

    /**
     * @param {string} id
     * @param {{ name: string, status: string, startedOn: string, endedOn: string | null, budgetCents: bigint | null }} input
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<object>} Updated campaign view model.
     * @throws {NotFoundError} When the campaign does not exist.
     * @throws {ValidationError} When the campaign is switched back to `active` while its channel is archived.
     */
    async updateCampaign(id, input, actor) {
      const before = await campaignsRepository.findCampaignById(id);
      if (!before) throw new NotFoundError(CAMPAIGN_NOT_FOUND);

      // Task 1 refuses to archive a channel that still has active campaigns. Without this reverse check, editing a
      // paused campaign back to `active` would recreate that forbidden state and the channel could never be archived.
      if (input.status === 'active' && before.channelIsActive === false) {
        throw new ValidationError(ARCHIVED_CHANNEL_ACTIVATION);
      }

      const updated = await campaignsRepository.updateCampaign(id, input);
      if (!updated) throw new NotFoundError(CAMPAIGN_NOT_FOUND);

      const after = { ...before, ...input };
      await recordAudit(actor, AUDIT_ACTIONS.CAMPAIGN_UPDATE, after);
      return toView(after);
    },

    /**
     * Physical deletion is allowed only for an empty mis-created campaign. Statistics, orders, touchpoints or a
     * customer's first campaign make the row history, and history is paused/finished instead of deleted.
     * @param {string} id
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<void>}
     * @throws {NotFoundError} When the campaign does not exist.
     * @throws {ValidationError} When anything still references the campaign.
     */
    async deleteCampaign(id, actor) {
      const campaign = await campaignsRepository.findCampaignById(id);
      if (!campaign) throw new NotFoundError(CAMPAIGN_NOT_FOUND);

      const usage = await campaignsRepository.getCampaignUsageCounts(id);
      const hasHistory =
        usage.statsCount + usage.ordersCount + usage.touchpointsCount + usage.customersCount > 0;
      if (hasHistory) throw new ValidationError(DELETE_GUARD);

      let removed;
      try {
        removed = await campaignsRepository.deleteCampaignById(id);
      } catch (error) {
        // A RESTRICT foreign key can still fire if another request links data between our count and the DELETE.
        if (error?.code === '23503') throw new ValidationError(DELETE_GUARD);
        throw error;
      }
      if (!removed) throw new ValidationError(DELETE_GUARD);

      await recordAudit(actor, AUDIT_ACTIONS.CAMPAIGN_DELETE, campaign);
    },
  };
}
