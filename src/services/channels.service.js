import { AUDIT_ACTIONS } from '../config/audit-actions.js';
import { formatDateRu } from '../lib/dates.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { formatCentsToByn, formatPercent } from '../lib/format.js';

/** Russian labels for the schema vocabulary; the codes stay English everywhere else. */
const KIND_LABELS = Object.freeze({ paid: 'Платный', owned: 'Собственный', earned: 'Заработанный' });

const DUPLICATE_CODE = 'Канал с таким кодом уже существует';
const ACTIVE_CAMPAIGNS_GUARD =
  'Нельзя архивировать канал с активными кампаниями: сначала остановите или завершите их';

/**
 * Turns a repository row into the list/passport view model. Formatting lives here rather than in EJS because
 * templates must not compute formulas or money strings (AGENTS.md §4, §6).
 * @param {object} channel Channel row from the repository.
 */
function toView(channel) {
  return {
    ...channel,
    kindLabel: KIND_LABELS[channel.kind] ?? channel.kind,
    statusLabel: channel.isActive ? 'Активен' : 'В архиве',
    targetCacLabel: channel.targetCacCents === null ? null : formatCentsToByn(channel.targetCacCents),
    targetRomiLabel: formatPercent(channel.targetRomiPct),
    createdAtLabel: channel.createdAt ? formatDateRu(channel.createdAt) : '—',
  };
}

/**
 * Prefills the edit form. The CAC is rendered back as BYN so the person sees the same number they entered; the
 * percent is re-comma'd for the same reason.
 * @param {object} channel Repository row.
 * @returns {{ name: string, kind: string, targetCacByn: string, targetRomiPct: string }}
 */
function toFormValues(channel) {
  return {
    name: channel.name,
    kind: channel.kind,
    targetCacByn: channel.targetCacCents === null ? '' : formatCentsToByn(channel.targetCacCents),
    targetRomiPct: channel.targetRomiPct === null ? '' : String(channel.targetRomiPct).replace('.', ','),
  };
}

/**
 * Audit payload. Cents become a decimal string on purpose: JSON.stringify cannot serialize a bigint, and the log
 * keeps the exact kopeck count without a float intermediate.
 * @param {object} channel Repository row or mapped channel.
 * @returns {Record<string, unknown>}
 */
function auditPayload(channel) {
  return {
    code: channel.code,
    name: channel.name,
    kind: channel.kind,
    targetCacCents: channel.targetCacCents === null ? null : channel.targetCacCents.toString(),
    targetRomiPct: channel.targetRomiPct,
  };
}

/**
 * Channel rules: duplicate codes, the archive guard and the audit trail. Express is invisible here; the service
 * receives validated primitives and an `actor` taken from the session by the controller.
 * @param {{
 *   channelsRepository: ReturnType<typeof import('../repositories/channels.repo.js').createChannelsRepository>,
 *   auditService: ReturnType<typeof import('./audit.service.js').createAuditService>,
 * }} deps
 */
export function createChannelsService({ channelsRepository, auditService }) {
  /**
   * @param {{ id?: string, ip?: string } | null | undefined} actor
   * @param {string} action One of `AUDIT_ACTIONS`.
   * @param {object} channel Channel state after the change.
   * @returns {Promise<void>}
   */
  async function recordAudit(actor, action, channel) {
    await auditService.record({
      userId: actor?.id ?? null,
      action,
      entity: 'channel',
      entityId: channel.id,
      payload: auditPayload(channel),
      ip: actor?.ip ?? null,
    });
  }

  return {
    /**
     * @param {{ status?: 'all' | 'active' | 'archived', kind?: 'all' | 'paid' | 'owned' | 'earned' }} [filters]
     * @returns {Promise<{ filters: { status: string, kind: string }, channels: object[] }>}
     */
    async listChannelsForView({ status = 'all', kind = 'all' } = {}) {
      const onlyActive = status === 'all' ? null : status === 'active';
      const rows = await channelsRepository.listChannels({
        onlyActive,
        kind: kind === 'all' ? null : kind,
      });
      return { filters: { status, kind }, channels: rows.map(toView) };
    },

    /**
     * @param {string} id
     * @returns {Promise<{ channel: object, form: object }>}
     * @throws {NotFoundError} When the channel does not exist or was never a digit id.
     */
    async getChannelDetail(id) {
      const channel = await channelsRepository.findChannelById(id);
      if (!channel) throw new NotFoundError('Канал не найден');
      return { channel: toView(channel), form: toFormValues(channel) };
    },

    /**
     * @param {{
     *   code: string, name: string, kind: string,
     *   targetCacCents: bigint | null, targetRomiPct: number | null,
     * }} input
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<object>} Created channel view model.
     * @throws {ValidationError} When the code is already taken.
     */
    async createChannel(input, actor) {
      // The pre-check gives the common case a clean error; the SQLSTATE catch below still covers two parallel submits.
      if (await channelsRepository.findChannelByCode(input.code)) {
        throw new ValidationError(DUPLICATE_CODE);
      }

      let created;
      try {
        created = await channelsRepository.createChannel(input);
      } catch (error) {
        if (error?.code === '23505') throw new ValidationError(DUPLICATE_CODE);
        throw error;
      }

      await recordAudit(actor, AUDIT_ACTIONS.CHANNEL_CREATE, created);
      return toView(created);
    },

    /**
     * @param {string} id
     * @param {{ name: string, kind: string, targetCacCents: bigint | null, targetRomiPct: number | null }} input
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<object>} Updated channel view model.
     * @throws {NotFoundError} When the channel does not exist.
     */
    async updateChannel(id, input, actor) {
      if (!(await channelsRepository.findChannelById(id))) throw new NotFoundError('Канал не найден');

      const updated = await channelsRepository.updateChannel(id, input);
      if (!updated) throw new NotFoundError('Канал не найден');

      await recordAudit(actor, AUDIT_ACTIONS.CHANNEL_UPDATE, updated);
      return toView(updated);
    },

    /**
     * Flips the archive flag. The state is derived from the row, not from a hidden form field: the endpoint is a
     * single toggle, so a stale page or a repeated POST cannot archive twice or restore a channel the user just
     * archived in another tab.
     * @param {string} id
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<object>} Channel view model after the toggle.
     * @throws {NotFoundError} When the channel does not exist.
     * @throws {ValidationError} When archiving a channel that still has active campaigns.
     */
    async toggleChannelArchive(id, actor) {
      const channel = await channelsRepository.findChannelById(id);
      if (!channel) throw new NotFoundError('Канал не найден');

      // The list/detail query already aggregated the campaign counters, so the guard needs no extra round trip.
      if (channel.isActive && channel.activeCampaignCount > 0) {
        throw new ValidationError(ACTIVE_CAMPAIGNS_GUARD);
      }

      const updated = await channelsRepository.setChannelActive(id, !channel.isActive);
      if (!updated) {
        // Channels are never hard-deleted, so during archiving a NULL can only mean the SQL guard saw a campaign
        // that appeared after our read; during restore there is no guard and a missing row is a genuine 404.
        if (channel.isActive) throw new ValidationError(ACTIVE_CAMPAIGNS_GUARD);
        throw new NotFoundError('Канал не найден');
      }

      await recordAudit(
        actor,
        updated.isActive ? AUDIT_ACTIONS.CHANNEL_RESTORE : AUDIT_ACTIONS.CHANNEL_ARCHIVE,
        updated,
      );
      return toView(updated);
    },
  };
}
