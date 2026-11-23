import { METRICS_CONFIG } from '../../config/metrics.js';
import { isoWeekStart, toDateOnly } from '../../lib/dates.js';
import { ValidationError } from '../../lib/errors.js';
import { parseBigIntId, normalizeChannelIds } from '../../lib/ids.js';
import { centsPercent, centsToApi } from '../../lib/metrics-math.js';
import { computeRomi } from './romi.service.js';

const DAY_MS = 86_400_000;
const ATTRIBUTION_MODELS = METRICS_CONFIG.attribution.models;
const DEFAULT_MODEL = METRICS_CONFIG.attribution.defaultModel;

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string} `YYYY-MM-DD`.
 * @throws {ValidationError} When the value is not a real calendar date.
 */
function requireDate(value, label) {
  if (value === null || value === undefined || value === '') {
    throw new ValidationError(`Не указана дата атрибуции: ${label}`);
  }
  try {
    return toDateOnly(value);
  } catch {
    throw new ValidationError(`Некорректная дата атрибуции: ${label}`);
  }
}

/**
 * @param {{ from?: string | null, to?: string | null }} request
 * @returns {{ from: string, to: string }} Inclusive Minsk calendar dates.
 * @throws {ValidationError} When a bound is missing, malformed or reversed.
 */
function normalisePeriod({ from, to }) {
  const fromDate = requireDate(from, 'начало');
  const toDate = requireDate(to, 'окончание');
  if (fromDate > toDate) {
    throw new ValidationError('Начало периода не может быть позже окончания');
  }
  return { from: fromDate, to: toDate };
}

/**
 * @param {unknown} models
 * @returns {string[]} Requested models without duplicates, in caller order.
 * @throws {ValidationError} When the list is empty or contains an unknown model.
 */
function normaliseModels(models) {
  const requested = models === undefined || models === null ? [...ATTRIBUTION_MODELS] : models;
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new ValidationError('Укажите хотя бы одну модель атрибуции');
  }

  const unique = [];
  for (const model of requested) {
    if (!ATTRIBUTION_MODELS.includes(model)) {
      throw new ValidationError('Неизвестная модель атрибуции');
    }
    if (!unique.includes(model)) unique.push(model);
  }
  return unique;
}

/**
 * @param {unknown} value
 * @returns {string}
 * @throws {TypeError} When an order row does not match the repository contract.
 */
function assertOrder(value) {
  if (typeof value?.orderId !== 'string' || typeof value.customerId !== 'string') {
    throw new TypeError('order id and customer id must be strings');
  }
  if (value.firstChannelId !== null && typeof value.firstChannelId !== 'string') {
    throw new TypeError('order firstChannelId must be a string or null');
  }
  if (!(value.occurredAt instanceof Date) || Number.isNaN(value.occurredAt.getTime())) {
    throw new TypeError('order occurredAt must be a valid Date');
  }
  if (typeof value.revenueCents !== 'bigint' || value.revenueCents < 0n) {
    throw new TypeError('order revenueCents must be a non-negative bigint');
  }
}

/**
 * @param {unknown} value
 * @returns {void}
 * @throws {TypeError} When the touchpoint row does not match the repository contract.
 */
function assertTouchpoint(value) {
  if (typeof value?.touchpointId !== 'string' || !/^\d+$/.test(value.touchpointId)) {
    throw new TypeError('touchpoint id must be a decimal string');
  }
  if (typeof value.customerId !== 'string' || typeof value.channelId !== 'string') {
    throw new TypeError('touchpoint customer id and channel id must be strings');
  }
  if (!(value.occurredAt instanceof Date) || Number.isNaN(value.occurredAt.getTime())) {
    throw new TypeError('touchpoint occurredAt must be a valid Date');
  }
}

/**
 * Chronological order, with the database id as the tie-break.
 *
 * The id comparison has to go through `BigInt`: lexicographic ordering would put `'10'` before `'9'` and move the
 * residual kopeck of a linear split to an arbitrary touch, making the report depend on string lengths.
 *
 * @param {{ touchpointId: string, occurredAt: Date }} left
 * @param {{ touchpointId: string, occurredAt: Date }} right
 * @returns {number}
 */
function compareTouchpoints(left, right) {
  const byTime = left.occurredAt.getTime() - right.occurredAt.getTime();
  if (byTime !== 0) return byTime;

  const leftId = BigInt(left.touchpointId);
  const rightId = BigInt(right.touchpointId);
  if (leftId < rightId) return -1;
  return leftId > rightId ? 1 : 0;
}

/**
 * Attributes order revenue to channels under one model (metrics spec §3.1).
 *
 * The window is `[order.occurred_at - windowDays days, order.occurred_at]`, both ends inclusive. A customer without
 * any touchpoint in the window falls back to `customers.first_channel_id`; an order whose customer has neither a
 * touch nor an acquisition channel cannot be attributed and is omitted, so the caller can compare
 * `totalAttributedCents` with `totalRevenueCents` and see the gap instead of receiving a fabricated channel.
 *
 * `linear` is cent-exact: `base = revenue / n` and the remainder is handed out one kopeck at a time to the earliest
 * touches in `(occurred_at, touchpoint.id)` order. That makes `Σ amountCents === revenueCents` for every order
 * without putting a single kopeck through floating point.
 *
 * @param {{
 *   orders: Array<{
 *     orderId: string, customerId: string, firstChannelId: string,
 *     occurredAt: Date, revenueCents: bigint,
 *   }>,
 *   touchpoints: Array<{
 *     touchpointId: string, customerId: string, channelId: string, occurredAt: Date,
 *   }>,
 *   model: 'last_touch' | 'first_touch' | 'linear',
 *   windowDays?: number,
 * }} input
 * @returns {Array<{ orderId: string, channelId: string, amountCents: bigint }>}
 * @throws {TypeError} When the model, the window or a row is invalid.
 */
export function attributeOrders({
  orders,
  touchpoints,
  model,
  windowDays = METRICS_CONFIG.attribution.windowDays,
}) {
  if (!ATTRIBUTION_MODELS.includes(model)) {
    throw new TypeError(`unknown attribution model: ${String(model)}`);
  }
  if (!Number.isInteger(windowDays) || windowDays < 0) {
    throw new TypeError(`windowDays must be a non-negative integer, got ${String(windowDays)}`);
  }
  if (!Array.isArray(orders) || !Array.isArray(touchpoints)) {
    throw new TypeError('orders and touchpoints must be arrays');
  }

  /** @type {Map<string, Array<{ touchpointId: string, customerId: string, channelId: string, occurredAt: Date }>>} */
  const touchesByCustomer = new Map();
  for (const touchpoint of touchpoints) {
    assertTouchpoint(touchpoint);
    let group = touchesByCustomer.get(touchpoint.customerId);
    if (!group) {
      group = [];
      touchesByCustomer.set(touchpoint.customerId, group);
    }
    group.push(touchpoint);
  }
  // Sorting a customer's touches once is enough: filtering by a window preserves their relative order.
  for (const group of touchesByCustomer.values()) group.sort(compareTouchpoints);

  const windowMs = windowDays * DAY_MS;
  /** @type {Array<{ orderId: string, channelId: string, amountCents: bigint }>} */
  const allocations = [];

  for (const order of orders) {
    assertOrder(order);
    const orderAt = order.occurredAt.getTime();
    const windowStart = orderAt - windowMs;
    const candidates = (touchesByCustomer.get(order.customerId) ?? []).filter((touchpoint) => {
      const touchAt = touchpoint.occurredAt.getTime();
      return touchAt >= windowStart && touchAt <= orderAt;
    });

    if (candidates.length === 0) {
      // Orders whose acquisition channel is unknown are left out on purpose: a channel must never be invented.
      if (order.firstChannelId === null) continue;
      allocations.push({ orderId: order.orderId, channelId: order.firstChannelId, amountCents: order.revenueCents });
      continue;
    }

    if (model === 'last_touch') {
      const last = candidates[candidates.length - 1];
      allocations.push({ orderId: order.orderId, channelId: last.channelId, amountCents: order.revenueCents });
      continue;
    }

    if (model === 'first_touch') {
      const first = candidates[0];
      allocations.push({ orderId: order.orderId, channelId: first.channelId, amountCents: order.revenueCents });
      continue;
    }

    const touchCount = BigInt(candidates.length);
    const base = order.revenueCents / touchCount;
    const remainder = order.revenueCents % touchCount;
    // `remainder < touchCount <= candidates.length`, so the Number conversion is exact.
    const extraTouches = Number(remainder);

    candidates.forEach((touchpoint, index) => {
      allocations.push({
        orderId: order.orderId,
        channelId: touchpoint.channelId,
        amountCents: index < extraTouches ? base + 1n : base,
      });
    });
  }

  return allocations;
}

/**
 * Aggregates allocation rows into one model view. Money stays bigint until `centsToApi` at the very edge.
 *
 * @param {Array<{ orderId: string, channelId: string, amountCents: bigint }>} allocations
 * @param {Map<string, bigint>} spendByChannel
 * @param {Array<{ channelId: string, channelCode: string }>} channels
 * @param {Map<string, { channelId: string, channelCode: string }>} channelById
 * @returns {{
 *   revenueByChannel: Array<{ channelId: string, channelCode: string, revenueCents: string, romiPct: number | null }>,
 *   revenueCents: Map<string, bigint>,
 *   totalAttributedCents: string,
 *   totalSpendCents: string,
 *   romiPct: number | null,
 * }}
 * @throws {TypeError} When an allocation points at a channel missing from the dimension, which would leak kopecks.
 */
function buildModelView(allocations, spendByChannel, channels, channelById) {
  /** @type {Map<string, bigint>} */
  const revenueByChannel = new Map();
  let totalAttributed = 0n;
  let totalSpend = 0n;

  for (const allocation of allocations) {
    if (!channelById.has(allocation.channelId)) {
      throw new TypeError(`attributed channel ${allocation.channelId} is missing from the channel list`);
    }
    revenueByChannel.set(
      allocation.channelId,
      (revenueByChannel.get(allocation.channelId) ?? 0n) + allocation.amountCents,
    );
    totalAttributed += allocation.amountCents;
  }

  const rows = channels.map((channel) => {
    const revenueCents = revenueByChannel.get(channel.channelId) ?? 0n;
    const spendCents = spendByChannel.get(channel.channelId) ?? 0n;
    // Spend is a period aggregate, not a model allocation: every model compares its own attributed revenue with the
    // same money. Summing the dimension (rather than the spend map) keeps the total consistent with the rows above.
    totalSpend += spendCents;
    return {
      channelId: channel.channelId,
      channelCode: channel.channelCode,
      revenueCents: centsToApi(revenueCents),
      // ROMI is undefined without spend by definition (metrics spec §3.2); null is the honest value, not 0.
      romiPct: spendCents === 0n ? null : centsPercent(revenueCents - spendCents, spendCents),
    };
  });

  return {
    revenueByChannel: rows,
    revenueCents: revenueByChannel,
    totalAttributedCents: centsToApi(totalAttributed),
    totalSpendCents: centsToApi(totalSpend),
    // The model-level ROMI reuses the single formula; a zero period spend makes it null instead of Infinity.
    romiPct: computeRomi({ revenueCents: totalAttributed, spendCents: totalSpend }),
  };
}

/**
 * Revenue attribution service (BO-03, BO-05; metrics spec §3.1).
 *
 * One pass over the period's orders and touchpoints feeds all three models; the comparison table then reuses those
 * maps, so the number of queries stays constant regardless of the number of orders or channels.
 *
 * @param {{
 *   attributionRepository: ReturnType<typeof import('../../repositories/attribution.repo.js').createAttributionRepository>,
 *   metricsRepository: ReturnType<typeof import('../../repositories/metrics.repo.js').createMetricsRepository>,
 *   channelsRepository: ReturnType<typeof import('../../repositories/channels.repo.js').createChannelsRepository>,
 * }} deps
 */
export function createAttributionService({ attributionRepository, metricsRepository, channelsRepository }) {
  /**
   * Loads everything a report or a series needs.
   *
   * The two reads are sequential on purpose. A service may receive a single `pg.Client` (tests, report
   * transactions): with `Promise.all` both queries are in flight from the caller's perspective, `pg` internally
   * queues them, and a failure in the first does not stop the second from being sent. Sequential awaits keep one
   * connection's work ordered and abort the touchpoint read when the order read fails.
   *
   * @param {{ from: string, to: string }} period
   * @returns {Promise<{ orders: object[], touchpoints: object[] }>}
   */
  async function loadInputs(period) {
    const orders = await attributionRepository.listOrdersInPeriod(period);
    const touchpoints = await attributionRepository.listTouchpointsForOrders(period);
    return { orders, touchpoints };
  }

  /**
   * @param {{ from: string, to: string }} period
   * @param {'last_touch' | 'first_touch' | 'linear'} model
   * @param {string | null} channelId Single-channel filter used by the passport.
   * @param {string[] | null} channelIds Multi-channel filter used by the dashboard.
   * @returns {Promise<Array<{ weekStart: string, revenueCents: string }>>}
   */
  async function buildSeries(period, model, channelId, channelIds = null) {
    const { orders, touchpoints } = await loadInputs(period);
    const allocations = attributeOrders({ orders, touchpoints, model });
    const allowed = channelIds === null ? null : new Set(channelIds);

    /** @type {Map<string, string>} */
    const weekByOrder = new Map();
    for (const order of orders) {
      weekByOrder.set(order.orderId, isoWeekStart(toDateOnly(order.occurredAt)));
    }

    /** @type {Map<string, bigint>} */
    const revenueByWeek = new Map();
    for (const allocation of allocations) {
      // The channel filter runs after allocation: a channel receives its own share, not a re-split of the order.
      const matches =
        allowed === null
          ? channelId === null || allocation.channelId === channelId
          : allowed.has(allocation.channelId);
      if (!matches) continue;
      const weekStart = weekByOrder.get(allocation.orderId);
      if (weekStart === undefined) {
        throw new TypeError(`allocation refers to unknown order ${allocation.orderId}`);
      }
      revenueByWeek.set(weekStart, (revenueByWeek.get(weekStart) ?? 0n) + allocation.amountCents);
    }

    // Weeks without any attributed revenue are not invented: the chart consumer fills them with `0n`.
    return [...revenueByWeek.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([weekStart, revenueCents]) => ({ weekStart, revenueCents: centsToApi(revenueCents) }));
  }

  return {
    /**
     * Three-model attribution report for one period.
     *
     * `models` narrows the returned map, but every configured model is always allocated: the comparison table has
     * fixed last/first/linear columns and needs all three, and one extra bounded pass is cheaper than a second
     * report call. `deltaLinearVsLastCents` is explicitly labelled by `deltaModel: 'linear'`, so a consumer cannot
     * misread it as a first-touch or generic delta. `totalRevenueCents` is the period's order revenue;
     * `totalAttributedCents` sums the shares, and their equality is the cent-leak invariant the tests assert.
     *
     * @param {{
     *   from: string,
     *   to: string,
     *   models?: Array<'last_touch' | 'first_touch' | 'linear'>,
     * }} request
     * @returns {Promise<{
     *   period: { from: string, to: string },
     *   models: Record<string, {
     *     revenueByChannel: Array<{
     *       channelId: string, channelCode: string, revenueCents: string, romiPct: number | null,
     *     }>,
     *     totalRevenueCents: string,
     *     totalAttributedCents: string,
     *     totalSpendCents: string,
     *     romiPct: number | null,
     *   }>,
     *   comparison: Array<{
     *     channelId: string,
     *     channelCode: string,
     *     channelName: string,
     *     lastTouchCents: string,
     *     firstTouchCents: string,
     *     linearCents: string,
     *     deltaModel: 'linear',
     *     deltaLinearVsLastCents: string,
     *     deltaLinearVsLastPct: number | null,
     *   }>,
     * }>}
     * @throws {ValidationError} When the period or the model list is invalid.
     * @throws {TypeError} When repository rows or allocations break their contract.
     */
    async getAttributionReport({ from, to, models } = {}) {
      const period = normalisePeriod({ from, to });
      const requestedModels = normaliseModels(models);

      // Sequential for the same reason as `loadInputs`: all four reads may share one checked-out `pg.Client`.
      const inputs = await loadInputs(period);
      const spendRows = await metricsRepository.listChannelSpend(period);
      const channelRows = await channelsRepository.listChannels();

      const channels = channelRows
        .map((channel) => ({
          channelId: channel.id,
          channelCode: channel.code,
          // The screen shows names; keeping both lets the API consumer choose without a second channel lookup.
          channelName: channel.name,
        }))
        .sort((left, right) => left.channelCode.localeCompare(right.channelCode));
      const channelById = new Map(channels.map((channel) => [channel.channelId, channel]));
      const spendByChannel = new Map(spendRows.map((row) => [row.channelId, row.spendCents]));

      let totalRevenue = 0n;
      for (const order of inputs.orders) totalRevenue += order.revenueCents;

      /** @type {Map<string, ReturnType<typeof buildModelView>>} */
      const viewsByModel = new Map();
      for (const model of ATTRIBUTION_MODELS) {
        const allocations = attributeOrders({ ...inputs, model });
        viewsByModel.set(model, buildModelView(allocations, spendByChannel, channels, channelById));
      }

      /** @type {Record<string, object>} */
      const modelsView = {};
      for (const model of requestedModels) {
        const view = viewsByModel.get(model);
        modelsView[model] = {
          revenueByChannel: view.revenueByChannel,
          totalRevenueCents: centsToApi(totalRevenue),
          totalAttributedCents: view.totalAttributedCents,
          // Additive M3 fields: the attribution screen compares each model's own ROMI against the same period spend.
          totalSpendCents: view.totalSpendCents,
          romiPct: view.romiPct,
        };
      }

      const lastTouch = viewsByModel.get(DEFAULT_MODEL);
      const firstTouch = viewsByModel.get('first_touch');
      const linear = viewsByModel.get('linear');

      const comparison = channels.map((channel) => {
        const lastTouchCents = lastTouch.revenueCents.get(channel.channelId) ?? 0n;
        const firstTouchCents = firstTouch.revenueCents.get(channel.channelId) ?? 0n;
        const linearCents = linear.revenueCents.get(channel.channelId) ?? 0n;

        return {
          channelId: channel.channelId,
          channelCode: channel.channelCode,
          channelName: channel.channelName,
          lastTouchCents: centsToApi(lastTouchCents),
          firstTouchCents: centsToApi(firstTouchCents),
          linearCents: centsToApi(linearCents),
          // The actionable comparison is how far the redistributing linear model moves a channel away from the
          // default; first-touch keeps its own column so the consumer is not forced to derive it. The prefixed
          // names plus `deltaModel` make the base models explicit instead of relying on a comment.
          deltaModel: 'linear',
          deltaLinearVsLastCents: centsToApi(linearCents - lastTouchCents),
          deltaLinearVsLastPct: centsPercent(linearCents - lastTouchCents, lastTouchCents),
        };
      });

      return { period, models: modelsView, comparison };
    },

    /**
     * Weekly attributed revenue for the dashboard and the channel card (Mon–Sun weeks).
     *
     * The channel filter is applied to allocation rows, never to orders, so filtering cannot drop the part of an
     * order that belongs to another channel and then re-split the rest. Only weeks that received a share are
     * returned; the chart fills the gaps with zero because an absent week and a zero-revenue week look different.
     *
     * @param {{
     *   from: string,
     *   to: string,
     *   model?: 'last_touch' | 'first_touch' | 'linear',
     *   channelId?: string | null,
     *   channelIds?: string[] | null,
     * }} request
     * @returns {Promise<Array<{ weekStart: string, revenueCents: string }>>}
     * @throws {ValidationError} When the period, model, channel id or channel list is invalid.
     */
    async getAttributionSeries({
      from,
      to,
      model = DEFAULT_MODEL,
      channelId = null,
      channelIds = null,
    } = {}) {
      const period = normalisePeriod({ from, to });
      const selectedModel = normaliseModels([model])[0];
      const scopedIds = normalizeChannelIds(channelIds);

      let scopedChannelId = null;
      if (scopedIds === null && channelId !== null && channelId !== undefined) {
        scopedChannelId = parseBigIntId(channelId);
        if (scopedChannelId === null) {
          throw new ValidationError('Некорректный идентификатор канала');
        }
      }

      return buildSeries(period, selectedModel, scopedChannelId, scopedIds);
    },
  };
}
