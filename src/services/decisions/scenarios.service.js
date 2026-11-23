import { AUDIT_ACTIONS } from '../../config/audit-actions.js';
import { METRICS_CONFIG } from '../../config/metrics.js';
import { addDays, toDateOnly } from '../../lib/dates.js';
import { withTransaction } from '../../lib/db.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { normalizeChannelIds, parseBigIntId } from '../../lib/ids.js';
import { centsToApi, roundHalfUp } from '../../lib/metrics-math.js';
import { centsFromDb, parseBynToCents } from '../../lib/money.js';
import { createAuditRepository } from '../../repositories/audit.repo.js';
import { createScenariosRepository } from '../../repositories/scenarios.repo.js';
import {
  optimizerSnapshot,
  storedScenarioParamsSchema,
  storedScenarioResultSchema,
} from '../../validators/scenarios.schema.js';
import { createAuditService } from '../audit.service.js';
import { computeRomi } from '../metrics/romi.service.js';
import { resolveWeekRange } from '../metrics/weekly-series.js';
import { allocateBudget } from './budget-optimizer.service.js';
import { fitSaturationCurve, predictConversions, toWeeklyBuckets } from './saturation.service.js';

/** The baseline is the same four complete weeks the alert screen compares, so "current" means the same period on both. */
const CURRENT_WEEKS = METRICS_CONFIG.alerts.windowWeeks;

/** Shown instead of a Zod path; the stored snapshot is internal data, not a form field a person can correct. */
const INVALID_SNAPSHOT_REASON =
  'Снимок сценария сохранён другой версией схемы или повреждён. Пересчитайте сценарий.';

/**
 * @param {unknown} anchor
 * @returns {string} A validated `YYYY-MM-DD` date.
 * @throws {ValidationError} When the anchor is missing or not a real calendar date.
 */
function normalizeAnchor(anchor) {
  if (anchor === null || anchor === undefined || anchor === '') {
    throw new ValidationError('Не указана отчётная дата');
  }
  try {
    return toDateOnly(anchor);
  } catch {
    throw new ValidationError('Некорректная отчётная дата');
  }
}

/**
 * @param {unknown} name
 * @returns {string} Trimmed scenario name.
 * @throws {ValidationError} When the name is not between 3 and 120 characters.
 */
function normalizeName(name) {
  if (typeof name !== 'string') throw new ValidationError('Укажите название сценария');
  const trimmed = name.trim();
  if (trimmed.length < 3) throw new ValidationError('Название сценария: минимум 3 символа');
  if (trimmed.length > 120) throw new ValidationError('Название сценария не длиннее 120 символов');
  return trimmed;
}

/**
 * An absent or blank budget is not zero: it means "use the current weekly budget", which the baseline snapshot
 * resolves. A present value goes through the shared BYN parser so `1 234,56` and `1234.56` behave as everywhere else.
 * @param {unknown} budgetByn
 * @returns {bigint | null}
 * @throws {ValidationError} When the entered amount is malformed.
 */
function parseOptionalBudget(budgetByn) {
  if (budgetByn === null || budgetByn === undefined) return null;
  if (typeof budgetByn === 'string' && budgetByn.trim() === '') return null;
  return parseBynToCents(/** @type {string | number} */ (budgetByn));
}

/**
 * Rounds `total / count` to whole kopecks, half up, without a float division.
 * @param {bigint} total
 * @param {number} count Positive integer.
 * @returns {bigint}
 */
function averageCents(total, count) {
  const divisor = BigInt(count);
  return (total * 2n + divisor) / (2n * divisor);
}

/**
 * Same rounding for customer counts, which are ordinary numbers.
 * @param {number} total
 * @param {number} count Positive integer.
 * @returns {number}
 */
function averageCount(total, count) {
  return Math.floor((total * 2 + count) / (2 * count));
}

/**
 * @param {{ spendCents: bigint, newCustomers: number }[]} buckets
 * @returns {{ spendCents: bigint, customers: number }} Average of the last four complete weeks.
 */
function currentWeek(buckets) {
  const recent = buckets.slice(-CURRENT_WEEKS);
  if (recent.length === 0) return { spendCents: 0n, customers: 0 };
  const spendCents = recent.reduce((sum, bucket) => sum + bucket.spendCents, 0n);
  const customers = recent.reduce((sum, bucket) => sum + bucket.newCustomers, 0);
  return {
    spendCents: averageCents(spendCents, recent.length),
    customers: averageCount(customers, recent.length),
  };
}

/**
 * One channel's 12-month forecast (metrics spec §6.3).
 *
 * `customers` is the fitted conversion count, so it stays fractional; CAC and revenue are derived money and are
 * rounded to whole kopecks. A channel with zero predicted customers has no CAC and no ROMI — null, never a fabricated
 * zero. A missing LTV makes revenue and ROMI unknowable but leaves CAC valid, because CAC does not depend on LTV.
 *
 * @param {{
 *   customers: number,
 *   plannedCents: bigint,
 *   ltvCents: bigint | null,
 * }} input
 * @returns {{
 *   customers: number,
 *   revenue12Cents: string | null,
 *   cacCents: string | null,
 *   romi12: number | null,
 * }}
 */
function buildForecast({ customers, plannedCents, ltvCents }) {
  const hasCustomers = customers > 0;
  const cacCents = hasCustomers && plannedCents > 0n ? roundHalfUp(Number(plannedCents) / customers) : null;

  if (!hasCustomers) {
    return { customers: 0, revenue12Cents: '0', cacCents: null, romi12: null };
  }

  if (ltvCents === null) {
    return {
      customers,
      revenue12Cents: null,
      cacCents: centsToApi(cacCents),
      romi12: null,
    };
  }

  // A forecast customer count is fractional, so this one multiplication cannot stay in bigint. The LTV itself is a
  // per-customer average of realistic size; `Number` is exact for every kopeck count below 2^53 and the rounded
  // result is validated against the stored JSON schema before it is written.
  const revenue12Cents = roundHalfUp(customers * Number(ltvCents));
  const romi12 = plannedCents > 0n
    ? computeRomi({ revenueCents: revenue12Cents, spendCents: plannedCents * 52n })
    : null;

  return {
    customers,
    revenue12Cents: centsToApi(revenue12Cents),
    cacCents: centsToApi(cacCents),
    romi12,
  };
}

/**
 * Scenario builder, persistence and snapshot reader (metrics spec §6).
 *
 * Builds every selected channel's saturation curve over 26 complete weeks, splits a weekly budget through KKT across
 * the channels that actually have a curve, and freezes the result into a JSON-safe object. `linear`/`no_data`
 * channels stay visible with a note but are excluded from `planned` and from the optimizer call: a curve that was not
 * fitted cannot be optimised.
 *
 * The service reads through injected repositories and writes only inside `withTransaction(db, …)`, where the scenario
 * row and the `scenario.create` audit row share one client. The detail path never refits a curve — it validates the
 * stored JSONB and returns it.
 *
 * @param {{
 *   db: { connect: () => Promise<import('pg').PoolClient> },
 *   metricsRepository: ReturnType<typeof import('../../repositories/metrics.repo.js').createMetricsRepository>,
 *   channelsRepository: ReturnType<typeof import('../../repositories/channels.repo.js').createChannelsRepository>,
 *   ltvService: ReturnType<typeof import('../metrics/ltv.service.js').createLtvService>,
 *   auditServiceFactory?: (client: import('pg').PoolClient) => ReturnType<typeof createAuditService>,
 * }} deps
 */
export function createScenariosService({
  db,
  metricsRepository,
  channelsRepository,
  ltvService,
  auditServiceFactory = (client) => createAuditService({ auditRepository: createAuditRepository(client) }),
}) {
  const scenariosRepository = createScenariosRepository(db);

  /**
   * Computes the snapshot and the parameters that reproduce it.
   *
   * @param {{
   *   anchor: string,
   *   budgetByn?: string | number | null,
   *   channelIds?: string[] | null,
   *   curveChannelId?: string | number | null,
   * }} input `curveChannelId` is validated when present but is a presentation choice: the snapshot stores every
   *   channel's curve, so the screen model can highlight any of them without a second calculation.
   * @returns {Promise<{ params: object, result: object }>}
   * @throws {ValidationError} When the date, channels, budget or cap is invalid.
   */
  async function prepareScenario({ anchor, budgetByn = null, channelIds = null, curveChannelId = null }) {
    const anchorDate = normalizeAnchor(anchor);
    const historyWeeks = METRICS_CONFIG.saturation.historyWeeks;
    const { firstWeekStart, lastWeekStart } = resolveWeekRange(anchorDate, historyWeeks);
    const history = {
      from: firstWeekStart,
      to: addDays(lastWeekStart, 6),
      weeks: historyWeeks,
    };

    const requestedIds = normalizeChannelIds(channelIds);
    const allChannels = await channelsRepository.listChannels();
    const channelById = new Map(allChannels.map((channel) => [channel.id, channel]));

    let selected;
    if (requestedIds === null) {
      selected = [...allChannels];
    } else {
      selected = requestedIds.map((id) => {
        const channel = channelById.get(id);
        if (!channel) throw new ValidationError('Канал не найден');
        return channel;
      });
    }
    // Canonical order makes two equivalent requests produce the same JSON, which keeps snapshots comparable.
    selected.sort((left, right) => left.code.localeCompare(right.code));
    if (selected.length === 0) throw new ValidationError('Выберите хотя бы один канал');

    if (curveChannelId !== null && curveChannelId !== undefined) {
      const curveId = parseBigIntId(curveChannelId);
      if (curveId === null || !selected.some((channel) => channel.id === curveId)) {
        throw new ValidationError('Некорректный канал кривой');
      }
    }

    // `listWeeklySeries` is company-wide; the fit needs one bucket per (channel, week), which is exactly the
    // per-channel aggregate used by the channel list. Filtering happens in memory so one grouped query serves every
    // selected channel instead of an N+1 loop.
    const weeklyRows = await metricsRepository.listChannelWeeklyCacInputs({
      from: history.from,
      to: history.to,
    });
    const selectedIds = new Set(selected.map((channel) => channel.id));
    const rowsByChannel = new Map(selected.map((channel) => [channel.id, []]));
    for (const row of weeklyRows) {
      if (!selectedIds.has(row.channelId)) continue;
      rowsByChannel.get(row.channelId).push(row);
    }
    const buckets = toWeeklyBuckets({
      firstWeekStart,
      weeks: historyWeeks,
      rowsByChannel,
    });

    // One LTV request for every channel: a per-channel call would be an N+1 and could read a moving dataset at
    // different moments. `ltvCents` arrives as a BIGINT string and crosses the boundary through `centsFromDb`.
    const ltv = await ltvService.getChannelLtv({
      anchor: anchorDate,
      horizonMonths: 12,
      channelIds: requestedIds,
    });
    const ltvByChannel = new Map(
      (ltv.rows ?? []).map((row) => [row.channelId, centsFromDb(row.ltvCents)]),
    );

    /** @type {Map<string, ReturnType<typeof fitSaturationCurve>>} */
    const fits = new Map();
    for (const channel of selected) {
      const points = buckets.get(channel.id) ?? [];
      fits.set(
        channel.id,
        fitSaturationCurve({
          points: points.map((point) => ({
            spendCents: point.spendCents,
            newCustomers: point.newCustomers,
          })),
        }),
      );
    }

    const optimizable = selected.filter((channel) => fits.get(channel.id).model === 'saturation');
    if (optimizable.length === 0) throw new ValidationError('Нет каналов с валидной кривой');

    const currentByChannel = new Map(
      selected.map((channel) => [channel.id, currentWeek(buckets.get(channel.id) ?? [])]),
    );
    // The cap compares the planned budget with what the optimised channels actually spend now. Excluded channels are
    // not part of the allocation, so their spend must not inflate the slider maximum.
    const baselineCents = optimizable.reduce(
      (sum, channel) => sum + currentByChannel.get(channel.id).spendCents,
      0n,
    );

    let budgetCents = parseOptionalBudget(budgetByn);
    if (budgetCents === null) budgetCents = baselineCents;
    if (budgetCents <= 0n) throw new ValidationError('Бюджет в BYN должен быть больше нуля');

    const capCents = baselineCents * BigInt(METRICS_CONFIG.scenarios.maxBudgetMultiplier);
    if (budgetCents > capCents) {
      throw new ValidationError(
        `Бюджет больше ${METRICS_CONFIG.scenarios.maxBudgetMultiplier}× текущего недельного бюджета в BYN`,
      );
    }

    const allocation = allocateBudget({
      curves: optimizable.map((channel) => {
        const fit = fits.get(channel.id);
        return { channelId: channel.id, model: 'saturation', K: fit.K, S: fit.S };
      }),
      budgetCents,
    });
    const plannedByn = new Map(
      allocation.allocations.map((entry) => [entry.channelId, entry.spendCents]),
    );

    const resultChannels = [];
    let totalCurrentCents = 0n;
    let totalCurrentCustomers = 0;
    let totalPlannedCents = 0n;
    let totalPlannedCustomers = 0;
    let totalRevenue12Cents = 0n;
    let revenueKnown = true;
    const warnings = [];

    const warnAboveCents = baselineCents * BigInt(METRICS_CONFIG.scenarios.warnBudgetMultiplier);
    if (budgetCents > warnAboveCents) {
      warnings.push(
        `Бюджет больше фактического более чем в ${METRICS_CONFIG.scenarios.warnBudgetMultiplier} раза — прогноз экстраполяция`,
      );
    }

    for (const channel of selected) {
      const fit = fits.get(channel.id);
      const current = currentByChannel.get(channel.id);
      const optimizableChannel = fit.model === 'saturation';

      let planned = null;
      let forecast = null;
      let note = null;

      if (optimizableChannel) {
        const spendCents = plannedByn.get(channel.id) ?? 0n;
        const customers = predictConversions(fit, Number(spendCents) / 100);
        planned = { spendCents: centsToApi(spendCents), customers };
        forecast = buildForecast({
          customers,
          plannedCents: spendCents,
          ltvCents: ltvByChannel.get(channel.id) ?? null,
        });
        note = fit.warning;

        totalCurrentCents += current.spendCents;
        totalCurrentCustomers += current.customers;
        totalPlannedCents += spendCents;
        totalPlannedCustomers += customers;
        if (forecast.revenue12Cents === null) {
          revenueKnown = false;
        } else {
          totalRevenue12Cents += BigInt(forecast.revenue12Cents);
        }
      } else {
        note = fit.model === 'linear' ? 'Линейная кривая — без оптимума' : 'Нет данных для кривой';
      }

      if (note) warnings.push(`${channel.name}: ${note}`);

      resultChannels.push({
        channelId: channel.id,
        channelCode: channel.code,
        channelName: channel.name,
        model: fit.model,
        K: fit.K,
        S: fit.S,
        r2: fit.r2,
        observed: (buckets.get(channel.id) ?? []).map((point) => ({
          spendCents: centsToApi(point.spendCents),
          customers: point.newCustomers,
        })),
        current: {
          spendCents: centsToApi(current.spendCents),
          customers: current.customers,
        },
        planned,
        forecast,
        note,
      });
    }

    const totalCacCents =
      totalPlannedCustomers > 0 ? roundHalfUp(Number(totalPlannedCents) / totalPlannedCustomers) : null;
    const totalRomi12 =
      totalPlannedCustomers > 0 && revenueKnown && totalPlannedCents > 0n
        ? computeRomi({
            revenueCents: totalRevenue12Cents,
            spendCents: totalPlannedCents * 52n,
          })
        : null;

    // Totals describe the optimised set only: they are the cap baseline and the sum of what the plan allocated.
    // Excluded channels remain visible in `channels` with a note but cannot contribute to a plan they are not part of.
    const result = {
      channels: resultChannels,
      totals: {
        current: {
          spendCents: centsToApi(totalCurrentCents),
          customers: totalCurrentCustomers,
        },
        planned: {
          spendCents: centsToApi(totalPlannedCents),
          customers: totalPlannedCustomers,
        },
        forecast: {
          customers: totalPlannedCustomers,
          revenue12Cents: revenueKnown ? centsToApi(totalRevenue12Cents) : null,
          cacCents: centsToApi(totalCacCents),
          romi12: totalRomi12,
        },
      },
      warnings,
    };

    const params = {
      schemaVersion: 1,
      anchor: anchorDate,
      history,
      budgetCents: centsToApi(budgetCents),
      channelIds: selected.map((channel) => channel.id),
      optimizer: optimizerSnapshot(),
      budgetPeriod: 'week',
    };

    return { params, result };
  }

  return {
    /**
     * Builds the current scenario without writing anything.
     * @param {{
     *   anchor: string,
     *   budgetByn?: string | number | null,
     *   channelIds?: string[] | null,
     *   curveChannelId?: string | number | null,
     * }} input
     * @returns {Promise<object>} The `result` shape stored in `scenarios.result`.
     */
    async buildScenario(input) {
      const { result } = await prepareScenario(input);
      return result;
    },

    /**
     * Recomputes the scenario from the request and stores it with `scenario.create` in one transaction.
     *
     * The client never sends a result: accepting one would let a tampered page store numbers the server never
     * produced. `name` is validated here as well as in the request schema because the service is also called by the
     * API and by tests directly.
     *
     * @param {{
     *   name: string,
     *   budgetByn?: string | number | null,
     *   channelIds?: string[] | null,
     *   anchor: string,
     * }} input
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<{ id: string }>}
     * @throws {ValidationError} When the name, budget or channels are invalid.
     */
    async saveScenario({ name, budgetByn = null, channelIds = null, anchor }, actor) {
      const safeName = normalizeName(name);
      const createdBy = parseBigIntId(actor?.id);
      if (createdBy === null) throw new ValidationError('Требуется автор сценария');

      const { params, result } = await prepareScenario({ anchor, budgetByn, channelIds });

      // The builder is code, not user input, but validating its output before it is frozen into JSONB turns a future
      // contract drift into a failed save instead of a row that the detail page has to mark invalid.
      const validatedResult = storedScenarioResultSchema.parse(result);

      const id = await withTransaction(db, async (client) => {
        const repository = createScenariosRepository(client);
        const created = await repository.createScenario({
          name: safeName,
          createdBy,
          params,
          result: validatedResult,
        });

        const auditService = auditServiceFactory(client);
        await auditService.record({
          userId: createdBy,
          action: AUDIT_ACTIONS.SCENARIO_CREATE,
          entity: 'scenario',
          entityId: created.id,
          payload: {
            name: safeName,
            budgetCents: params.budgetCents,
            channelIds: params.channelIds,
          },
          ip: actor?.ip ?? null,
        });

        return created.id;
      });

      return { id };
    },

    /**
     * One page of saved scenarios. A tampered snapshot is marked `invalid` instead of breaking the list.
     * @param {{ page?: number }} [input]
     * @returns {Promise<{
     *   rows: object[],
     *   page: number,
     *   total: number,
     *   hasMore: boolean,
     * }>}
     */
    async listScenarios({ page = 1 } = {}) {
      const list = await scenariosRepository.listScenarios({ page, limit: 50 });

      return {
        ...list,
        rows: list.rows.map((row) => {
          const params = storedScenarioParamsSchema.safeParse(row.params);
          const result = storedScenarioResultSchema.safeParse(row.result);
          const invalid = !params.success || !result.success;
          return {
            id: row.id,
            name: row.name,
            createdBy: row.createdBy,
            authorLabel: row.authorLabel,
            createdAt: row.createdAt,
            anchor: params.success ? params.data.anchor : null,
            budgetCents: params.success ? params.data.budgetCents : null,
            channelCount: params.success ? params.data.channelIds.length : null,
            invalid,
            invalidReason: invalid ? INVALID_SNAPSHOT_REASON : null,
          };
        }),
      };
    },

    /**
     * Reads one saved snapshot. The stored `result` is returned as-is; no curve is refitted and no live metric is
     * read, so a detail page opened a year later shows exactly what was saved.
     *
     * @param {string} id BIGINT id as a digit string.
     * @returns {Promise<object>} A detail with `invalid: false`, or an `invalid: true` explanation.
     * @throws {NotFoundError} When the scenario does not exist.
     * @throws {ValidationError} When the id is not a BIGINT.
     */
    async getScenarioDetail(id) {
      const scenarioId = parseBigIntId(id);
      if (scenarioId === null) throw new ValidationError('Некорректный идентификатор сценария');

      const row = await scenariosRepository.findScenarioById(scenarioId);
      if (!row) throw new NotFoundError('Сценарий не найден');

      const params = storedScenarioParamsSchema.safeParse(row.params);
      const result = storedScenarioResultSchema.safeParse(row.result);
      const base = {
        id: row.id,
        name: row.name,
        createdBy: row.createdBy,
        authorLabel: row.authorLabel,
        createdAt: row.createdAt,
      };

      if (!params.success || !result.success) {
        return {
          ...base,
          params: null,
          result: null,
          savedAnchor: null,
          invalid: true,
          invalidReason: INVALID_SNAPSHOT_REASON,
        };
      }

      return {
        ...base,
        params: params.data,
        result: result.data,
        savedAnchor: params.data.anchor,
        invalid: false,
        invalidReason: null,
      };
    },
  };
}
