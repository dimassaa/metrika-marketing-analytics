import { AUDIT_ACTIONS } from '../config/audit-actions.js';
import { withTransaction } from '../lib/db.js';
import { formatDateRu } from '../lib/dates.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { formatCentsToByn, formatInteger, formatMonths, formatPercent, formatRatio } from '../lib/format.js';
import { parseBynToCents } from '../lib/money.js';
import { createGoalsRepository } from '../repositories/goals.repo.js';
import { GOAL_METRICS } from '../validators/goals.schema.js';

/**
 * Russian names and the unit of `target_value` for every metric. The unit is part of the domain contract, not a
 * template detail: CAC is money (BYN), ROMI a percentage, LTV:CAC a ratio, payback a month count and new customers
 * an integer. M3 compares each goal with the fact using this same mapping.
 */
const METRIC_LABELS = Object.freeze({
  cac: 'CAC',
  romi: 'ROMI',
  ltv_cac: 'LTV:CAC',
  payback: 'Payback',
  new_customers: 'Новые клиенты',
});

const METRIC_UNITS = Object.freeze({
  cac: 'BYN',
  romi: 'проценты',
  ltv_cac: 'коэффициент',
  payback: 'месяцы',
  new_customers: 'чел.',
});

const OVERLAP_MESSAGE = 'Для этой метрики и канала уже задана цель на пересекающийся период';
const GOAL_NOT_FOUND = 'Цель не найдена';
const CHANNEL_NOT_FOUND = 'Канал не найден';

const STATUS_LABELS = Object.freeze({
  active: 'Активна',
  planned: 'Запланирована',
  finished: 'Завершена',
});

const STATUS_TONES = Object.freeze({ active: 'healthy', planned: 'watch', finished: 'neutral' });

/**
 * @param {string} metric
 * @param {string} value NUMERIC text from the repository.
 * @returns {{ targetLabel: string, targetIsByn: boolean }}
 */
function formatTarget(metric, value) {
  switch (metric) {
    case 'cac':
      return {
        targetLabel: formatCentsToByn(parseBynToCents(value)),
        targetIsByn: true,
      };
    case 'romi':
      return { targetLabel: formatPercent(value), targetIsByn: false };
    case 'ltv_cac':
      return { targetLabel: formatRatio(value, { decimals: 2 }), targetIsByn: false };
    case 'payback':
      return {
        targetLabel: `${formatMonths(value)} мес.`,
        targetIsByn: false,
      };
    case 'new_customers':
      return {
        targetLabel: formatInteger(BigInt(String(value).split('.')[0])),
        targetIsByn: false,
      };
    default:
      return { targetLabel: String(value), targetIsByn: false };
  }
}

/**
 * @param {string} metric
 * @param {string} targetValue Exact stored decimal string.
 * @returns {string} Value the edit form accepts back: comma decimal, no currency glyph.
 */
function toFormTarget(metric, targetValue) {
  switch (metric) {
    case 'cac':
      return formatCentsToByn(parseBynToCents(targetValue));
    case 'romi':
    case 'ltv_cac':
      return String(targetValue).replace('.', ',');
    case 'payback':
      return formatMonths(targetValue);
    case 'new_customers':
      return String(BigInt(String(targetValue).split('.')[0]));
    default:
      return String(targetValue);
  }
}

/**
 * Compares the goal interval with the data anchor, not with the system clock: the demo stand can be opened after
 * the last statistical day, and the status must still describe that reporting date.
 * @param {{ periodStart: string, periodEnd: string }} goal
 * @param {string} dataAnchor `YYYY-MM-DD`.
 * @returns {'active' | 'planned' | 'finished'}
 */
function statusAt(goal, dataAnchor) {
  if (dataAnchor < goal.periodStart) return 'planned';
  if (dataAnchor > goal.periodEnd) return 'finished';
  return 'active';
}

/**
 * Repository row → list/edit view model. Formatting lives here rather than in EJS because templates must not
 * compute formulas, money strings or unit-dependent numbers (AGENTS.md §4, §6).
 * @param {object} goal Repository row.
 * @param {string} [dataAnchor] `YYYY-MM-DD` reporting date; omitted by create/update, whose caller redirects to the
 *   list and therefore has no use for a status derived from an arbitrary date.
 * @returns {Record<string, any>}
 */
function toView(goal, dataAnchor) {
  const status = dataAnchor ? statusAt(goal, dataAnchor) : null;
  return {
    ...goal,
    metricLabel: METRIC_LABELS[goal.metric] ?? goal.metric,
    metricUnit: METRIC_UNITS[goal.metric] ?? '',
    channelLabel: goal.channelId === null ? 'Вся компания' : goal.channelName ?? '—',
    ...formatTarget(goal.metric, goal.targetValue),
    periodStartLabel: formatDateRu(goal.periodStart),
    periodEndLabel: formatDateRu(goal.periodEnd),
    status,
    statusLabel: status ? STATUS_LABELS[status] : null,
    statusTone: status ? STATUS_TONES[status] : null,
  };
}

/**
 * @param {object} goal Repository row.
 * @returns {{ metric: string, channelId: string, targetValue: string, periodStart: string, periodEnd: string }}
 */
function toFormValues(goal) {
  return {
    metric: goal.metric,
    channelId: goal.channelId ?? '',
    targetValue: toFormTarget(goal.metric, goal.targetValue),
    periodStart: goal.periodStart,
    periodEnd: goal.periodEnd,
  };
}

/**
 * Audit payload. `targetValue` stays the exact decimal string, because the unit depends on `metric` and a float
 * would misrepresent both money and ratios.
 * @param {object} goal Mapped goal.
 * @returns {Record<string, unknown>}
 */
function auditPayload(goal) {
  return {
    metric: goal.metric,
    channelId: goal.channelId,
    targetValue: goal.targetValue,
    periodStart: goal.periodStart,
    periodEnd: goal.periodEnd,
  };
}

/**
 * Goal rules: the overlap rule and the audit trail. Express is invisible here; the service receives validated
 * primitives and an `actor` taken from the session by the controller.
 *
 * The overlap check and the write run in one transaction, guarded by an advisory lock per `(metric, channel)`
 * scope. The database unique index catches an identical period; the lock also covers two different periods that
 * would overlap, which a unique index alone cannot express without a range exclusion constraint.
 *
 * @param {{
 *   db: { connect: () => Promise<import('pg').PoolClient> },
 *   goalsRepository: ReturnType<typeof createGoalsRepository>,
 *   auditService: ReturnType<typeof import('./audit.service.js').createAuditService>,
 * }} deps
 */
export function createGoalsService({ db, goalsRepository, auditService }) {
  /**
   * @param {{ id?: string, ip?: string } | null | undefined} actor
   * @param {string} action One of `AUDIT_ACTIONS`.
   * @param {object} goal Goal state after the change.
   * @returns {Promise<void>}
   */
  async function recordAudit(actor, action, goal) {
    await auditService.record({
      userId: actor?.id ?? null,
      action,
      entity: 'goal',
      entityId: goal.id,
      payload: auditPayload(goal),
      ip: actor?.ip ?? null,
    });
  }

  return {
    /**
     * @param {{ channelId?: string | null, metric?: string | null }} [filters] `all`/NULL disables a condition.
     * @param {string} dataAnchor `YYYY-MM-DD` reporting date from `getDataAnchor`.
     * @returns {Promise<{
     *   filters: { channelId: string, metric: string },
     *   goals: object[],
     *   metricOptions: Array<{ value: string, label: string, unit: string }>,
     * }>}
     */
    async listGoalsForView({ channelId = 'all', metric = 'all' } = {}, dataAnchor) {
      const rows = await goalsRepository.listGoals({
        channelId: channelId === 'all' ? null : channelId,
        metric: metric === 'all' ? null : metric,
      });
      return {
        filters: { channelId, metric },
        goals: rows.map((row) => toView(row, dataAnchor)),
        // The create form documents the unit of every metric in its options, so the choice is informed.
        metricOptions: GOAL_METRICS.map((value) => ({
          value,
          label: METRIC_LABELS[value],
          unit: METRIC_UNITS[value],
        })),
      };
    },

    /**
     * @param {string} id
     * @returns {Promise<{
     *   id: string,
     *   values: object,
     *   metricLabel: string,
     *   metricUnit: string,
     *   channelLabel: string,
     * } | null>} Null when the id is gone, so a stale edit link can fall back to the ordinary list instead of a
     *   404 for a page that still exists.
     */
    async getGoalForm(id) {
      const goal = await goalsRepository.findGoalById(id);
      if (!goal) return null;
      const view = toView(goal);
      return {
        id: goal.id,
        values: toFormValues(goal),
        metricLabel: view.metricLabel,
        metricUnit: view.metricUnit,
        channelLabel: view.channelLabel,
      };
    },

    /**
     * @param {{
     *   metric: string, channelId: string | null, targetValue: string,
     *   periodStart: string, periodEnd: string,
     * }} input
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<object>} Created goal view model.
     * @throws {ValidationError} When the channel is missing or the period overlaps an existing goal.
     */
    async createGoal(input, actor) {
      if (input.channelId !== null && !(await goalsRepository.channelExists(input.channelId))) {
        throw new ValidationError(CHANNEL_NOT_FOUND);
      }

      let created;
      try {
        created = await withTransaction(db, async (client) => {
          const repository = createGoalsRepository(client);
          await repository.lockGoalScope(input.metric, input.channelId);

          const overlap = await repository.findOverlappingGoal({
            metric: input.metric,
            channelId: input.channelId,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
          });
          if (overlap) throw new ValidationError(OVERLAP_MESSAGE);

          const id = await repository.createGoal({ ...input, createdBy: actor?.id ?? null });
          const row = await repository.findGoalById(id);
          if (!row) throw new NotFoundError(GOAL_NOT_FOUND);
          return row;
        });
      } catch (error) {
        if (error?.code === '23505') throw new ValidationError(OVERLAP_MESSAGE);
        if (error?.code === '23503') throw new ValidationError(CHANNEL_NOT_FOUND);
        throw error;
      }

      await recordAudit(actor, AUDIT_ACTIONS.GOAL_CREATE, created);
      return toView(created);
    },

    /**
     * @param {string} id
     * @param {{ targetValue: string, periodStart: string, periodEnd: string }} input
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<object>} Updated goal view model.
     * @throws {NotFoundError} When the goal does not exist.
     * @throws {ValidationError} When the new period overlaps another goal of the same metric and channel.
     */
    async updateGoal(id, input, actor) {
      const before = await goalsRepository.findGoalById(id);
      if (!before) throw new NotFoundError(GOAL_NOT_FOUND);

      let updated;
      try {
        updated = await withTransaction(db, async (client) => {
          const repository = createGoalsRepository(client);
          await repository.lockGoalScope(before.metric, before.channelId);

          const overlap = await repository.findOverlappingGoal({
            metric: before.metric,
            channelId: before.channelId,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            excludeId: id,
          });
          if (overlap) throw new ValidationError(OVERLAP_MESSAGE);

          const changed = await repository.updateGoal(id, input);
          if (!changed) throw new NotFoundError(GOAL_NOT_FOUND);
          const row = await repository.findGoalById(id);
          if (!row) throw new NotFoundError(GOAL_NOT_FOUND);
          return row;
        });
      } catch (error) {
        if (error?.code === '23505') throw new ValidationError(OVERLAP_MESSAGE);
        throw error;
      }

      await recordAudit(actor, AUDIT_ACTIONS.GOAL_UPDATE, updated);
      return toView(updated);
    },

    /**
     * @param {string} id
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<void>}
     * @throws {NotFoundError} When the goal does not exist.
     */
    async deleteGoal(id, actor) {
      const goal = await goalsRepository.findGoalById(id);
      if (!goal) throw new NotFoundError(GOAL_NOT_FOUND);

      if (!(await goalsRepository.deleteGoal(id))) throw new NotFoundError(GOAL_NOT_FOUND);
      await recordAudit(actor, AUDIT_ACTIONS.GOAL_DELETE, goal);
    },
  };
}
