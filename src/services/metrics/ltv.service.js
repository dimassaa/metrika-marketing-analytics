import { METRICS_CONFIG } from '../../config/metrics.js';
import { addMonths, startOfMonth, toDateOnly } from '../../lib/dates.js';
import { ValidationError } from '../../lib/errors.js';
import { formatCentsToByn } from '../../lib/format.js';
import { parseBigIntId } from '../../lib/ids.js';
import { centsToApi, roundNumber } from '../../lib/metrics-math.js';

/** Guard against a caller asking for a 1 000-column matrix by accident; 60 months is five years of history. */
const MAX_HORIZON_MONTHS = 60;

/** Short Russian month names for matrix row labels; the UI never builds labels from raw dates itself. */
const MONTH_LABELS = Object.freeze([
  'янв',
  'фев',
  'мар',
  'апр',
  'май',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
]);

/**
 * @param {string} cohortMonth `YYYY-MM-01`.
 * @returns {string} Human label, e.g. `янв 2026`.
 */
function formatCohortLabel(cohortMonth) {
  const month = Number(cohortMonth.slice(5, 7));
  return `${MONTH_LABELS[month - 1]} ${cohortMonth.slice(0, 4)}`;
}

/**
 * Zero-based month number, used to count how many calendar months separate a cohort from the anchor without
 * routing the comparison through a timezone.
 * @param {string} date `YYYY-MM-DD`.
 * @returns {number}
 */
function monthIndex(date) {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

/**
 * @param {unknown} value
 * @returns {number}
 * @throws {TypeError} When the horizon is not an integer inside the supported range.
 */
function assertHorizon(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_HORIZON_MONTHS) {
    throw new TypeError(`horizonMonths must be an integer between 1 and ${MAX_HORIZON_MONTHS}, got ${String(value)}`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 * @throws {TypeError} When the value is not a real `YYYY-MM-DD` date.
 */
function assertDate(value) {
  if (value === null || value === undefined || value === '') {
    throw new TypeError('expected a YYYY-MM-DD date');
  }
  return toDateOnly(value);
}

/**
 * Sums the margins inside the horizon and remembers whether any row existed. The total, not the per-customer LTV,
 * is what channel averages need: dividing per-cohort values first and then re-multiplying would round every cohort
 * twice.
 * @param {Map<number, { activeCustomers: number, marginCents: bigint }>} marginsByOffset
 * @param {number} horizonMonths
 * @returns {{ totalCents: bigint, hasMargin: boolean }}
 * @throws {TypeError} When an offset or amount is invalid.
 */
function sumHorizonMargins(marginsByOffset, horizonMonths) {
  let totalCents = 0n;
  let hasMargin = false;
  for (const [monthOffset, row] of marginsByOffset) {
    if (!Number.isInteger(monthOffset) || monthOffset < 0) {
      throw new TypeError(`monthOffset must be a non-negative integer, got ${String(monthOffset)}`);
    }
    if (typeof row?.marginCents !== 'bigint' || row.marginCents < 0n) {
      throw new TypeError(`marginCents must be a non-negative bigint, got ${String(row?.marginCents)}`);
    }
    if (monthOffset < horizonMonths) {
      totalCents += row.marginCents;
      hasMargin = true;
    }
  }
  return { totalCents, hasMargin };
}

/**
 * Sums only the margins inside the horizon and divides by the cohort size with half-up rounding. Both operands
 * are non-negative (orders.margin_cents has a CHECK >= 0), so the positive-value rounding identity is exact.
 * @param {bigint} totalCents
 * @param {number} customerCount Positive integer.
 * @returns {bigint}
 */
function divideCents(totalCents, customerCount) {
  const customers = BigInt(customerCount);
  return (totalCents * 2n + customers) / (2n * customers);
}

/**
 * LTV of one cohort at one horizon (metrics spec §2).
 *
 * `horizonMonths` counts whole calendar months from the cohort month: LTV3 sums offsets 0, 1 and 2, so an order in
 * offset 3 belongs to LTV6 but not LTV3. A cohort is complete only when its horizon end is on or before the data
 * anchor; incomplete cohorts still have a partial LTV in the matrix but must not enter channel averages.
 *
 * @param {{
 *   cohort: { cohortMonth: string, cohortSize: number },
 *   marginsByOffset: Map<number, { activeCustomers: number, marginCents: bigint }>,
 *   horizonMonths: number,
 *   anchor: string,
 * }} input
 * @returns {{ ltvCents: bigint | null, isComplete: boolean, monthsObserved: number }}
 *   `ltvCents` is null when the cohort has no margin row inside the horizon (an honest "no data", not zero).
 * @throws {TypeError} When an amount is not a bigint, a count is not an integer, or the inputs are malformed.
 */
export function computeCohortLtv({ cohort, marginsByOffset, horizonMonths, anchor }) {
  const cohortMonth = startOfMonth(assertDate(cohort.cohortMonth));
  const horizon = assertHorizon(horizonMonths);
  const anchorDate = assertDate(anchor);

  if (!Number.isInteger(cohort.cohortSize) || cohort.cohortSize <= 0) {
    throw new TypeError(`cohortSize must be a positive integer, got ${String(cohort.cohortSize)}`);
  }
  if (!(marginsByOffset instanceof Map)) {
    throw new TypeError('marginsByOffset must be a Map keyed by month offset');
  }

  const { totalCents, hasMargin } = sumHorizonMargins(marginsByOffset, horizon);

  // A month has been observed once its first day is no later than the anchor; the anchor month itself is partial
  // but still belongs to the matrix, which is why incomplete cohorts show cells rather than empty rows.
  const monthsObserved = Math.min(horizon, Math.max(0, monthIndex(anchorDate) - monthIndex(cohortMonth) + 1));

  return {
    ltvCents: hasMargin ? divideCents(totalCents, cohort.cohortSize) : null,
    isComplete: addMonths(cohortMonth, horizon) <= anchorDate,
    monthsObserved,
  };
}

/**
 * One matrix row: retention and cumulative LTV for `k = 0 … horizonMonths - 1`.
 *
 * A month that has not started relative to the anchor is `null` in both columns — the spec forbids painting future
 * cells as zero. A started month without orders has a real `0` retention: nobody from the cohort was active. Its
 * cumulative LTV stays `null` until the first observed margin row, because "no margin recorded" and "margin was
 * exactly zero" are different facts; once a row (even a zero-margin one) is seen, the cell carries a number.
 *
 * @param {{
 *   cohortMonth: string,
 *   cohortSize: number,
 *   marginsByOffset: Map<number, { activeCustomers: number, marginCents: bigint }>,
 *   horizonMonths: number,
 *   monthsObserved: number,
 * }} input
 * @returns {Array<{ monthOffset: number, retentionPct: number | null, cumLtvCents: string | null }>}
 */
function buildCells({ cohortMonth, cohortSize, marginsByOffset, horizonMonths, monthsObserved }) {
  const cells = [];
  let cumulativeCents = 0n;
  let hasMargin = false;

  for (let monthOffset = 0; monthOffset < horizonMonths; monthOffset += 1) {
    if (monthOffset >= monthsObserved) {
      cells.push({ monthOffset, retentionPct: null, cumLtvCents: null });
      continue;
    }

    const row = marginsByOffset.get(monthOffset);
    if (row) {
      if (!Number.isInteger(row.activeCustomers) || row.activeCustomers < 0 || row.activeCustomers > cohortSize) {
        throw new TypeError(
          `active customers for cohort ${cohortMonth} offset ${monthOffset} must be between 0 and ${cohortSize}`,
        );
      }
      if (typeof row.marginCents !== 'bigint' || row.marginCents < 0n) {
        throw new TypeError(`marginCents must be a non-negative bigint, got ${String(row.marginCents)}`);
      }
      cumulativeCents += row.marginCents;
      hasMargin = true;
    }

    cells.push({
      monthOffset,
      retentionPct: row ? roundNumber((row.activeCustomers * 100) / cohortSize, 2) : 0,
      cumLtvCents: hasMargin ? centsToApi(divideCents(cumulativeCents, cohortSize)) : null,
    });
  }

  return cells;
}

/**
 * @param {{
 *   cohortMonth: string,
 *   cohortSize: number,
 *   marginsByOffset: Map<number, { activeCustomers: number, marginCents: bigint }>,
 * }} entry
 * @param {{ anchor: string, horizonMonths: number }} options
 * @returns {object} JSON-safe matrix row; money leaves as decimal kopeck strings.
 */
function toCohortView(entry, { anchor, horizonMonths }) {
  const { ltvCents, isComplete, monthsObserved } = computeCohortLtv({
    cohort: entry,
    marginsByOffset: entry.marginsByOffset,
    horizonMonths,
    anchor,
  });

  return {
    cohortMonth: entry.cohortMonth,
    cohortLabel: formatCohortLabel(entry.cohortMonth),
    cohortSize: entry.cohortSize,
    ltvCents: centsToApi(ltvCents),
    ltvLabel: formatCentsToByn(ltvCents),
    isComplete,
    monthsObserved,
    cells: buildCells({
      cohortMonth: entry.cohortMonth,
      cohortSize: entry.cohortSize,
      marginsByOffset: entry.marginsByOffset,
      horizonMonths,
      monthsObserved,
    }),
  };
}

/**
 * Merges channel-cohorts into company-cohorts for the matrix. Sizes add up and the monthly activity adds up too:
 * every customer belongs to exactly one acquisition channel, so no customer is counted twice.
 *
 * @param {Array<{
 *   cohortMonth: string,
 *   cohortSize: number,
 *   marginsByOffset: Map<number, { activeCustomers: number, marginCents: bigint }>,
 * }>} entries
 * @returns {Array<{
 *   cohortMonth: string,
 *   cohortSize: number,
 *   marginsByOffset: Map<number, { activeCustomers: number, marginCents: bigint }>,
 * }>}
 */
function mergeCompanyCohorts(entries) {
  /** @type {Map<string, { cohortMonth: string, cohortSize: number, marginsByOffset: Map<number, any> }>} */
  const byMonth = new Map();

  for (const entry of entries) {
    let merged = byMonth.get(entry.cohortMonth);
    if (!merged) {
      merged = { cohortMonth: entry.cohortMonth, cohortSize: 0, marginsByOffset: new Map() };
      byMonth.set(entry.cohortMonth, merged);
    }

    merged.cohortSize += entry.cohortSize;
    for (const [monthOffset, row] of entry.marginsByOffset) {
      const existing = merged.marginsByOffset.get(monthOffset);
      merged.marginsByOffset.set(monthOffset, {
        activeCustomers: (existing?.activeCustomers ?? 0) + row.activeCustomers,
        marginCents: (existing?.marginCents ?? 0n) + row.marginCents,
      });
    }
  }

  return [...byMonth.values()].sort((left, right) => left.cohortMonth.localeCompare(right.cohortMonth));
}

/**
 * Weighted channel LTV over every completed cohort (metrics spec §2).
 *
 * The average is `Σ margin / Σ customers`, not the mean of per-cohort LTVs: a 100-customer cohort must not weigh
 * as much as a 400-customer one. Every completed cohort contributes its full `N`, even when it has no margin row
 * at all — the spec's denominator is the cohort size, and dropping a zero-margin cohort would quietly inflate the
 * channel average. Incomplete cohorts are excluded entirely; the matrix shows them with the `isComplete` flag.
 *
 * The channel list comes from the `channels` table, so a channel with spend but no customers yet is still returned
 * with `ltvCents: null` and `insufficient_history`; LTV:CAC can then left-join CAC rows. Inactive channels are
 * included for the same reason: historical LTV must remain available after a channel is archived.
 *
 * @param {Array<{
 *   cohortMonth: string, cohortSize: number, channelId: string, channelCode: string,
 *   marginsByOffset: Map<number, { activeCustomers: number, marginCents: bigint }>,
 * }>} entries
 * @param {Array<{ channelId: string, channelCode: string }>} channels
 * @param {{ anchor: string, horizonMonths: number }} options
 * @returns {{
 *   rows: Array<{
 *     channelId: string, channelCode: string, ltvCents: string | null,
 *     customerCount: number, cohortCount: number, status: 'ok' | 'insufficient_history',
 *   }>,
 *   blended: {
 *     ltvCents: string | null, customerCount: number,
 *     cohortCount: number, status: 'ok' | 'insufficient_history',
 *   },
 * }}
 *   `blended.cohortCount` is the number of distinct completed cohort months; a channel row counts its own
 *   completed channel-cohorts.
 */
function buildChannelLtv(entries, channels, { anchor, horizonMonths }) {
  /** @type {Map<string, { channelId: string, channelCode: string, totalCents: bigint, customers: number, cohorts: number }>} */
  const byChannel = new Map(
    channels.map((channel) => [
      channel.channelId,
      { channelId: channel.channelId, channelCode: channel.channelCode, totalCents: 0n, customers: 0, cohorts: 0 },
    ]),
  );
  const completedMonths = new Set();
  let totalCents = 0n;
  let totalCustomers = 0;

  for (const entry of entries) {
    const channel = byChannel.get(entry.channelId);
    if (!channel) {
      throw new TypeError(`cohort references a channel missing from the channel dimension: ${entry.channelId}`);
    }

    // Completeness is a calendar fact; computing it directly avoids summing the cohort once more just to read it.
    if (addMonths(entry.cohortMonth, horizonMonths) > anchor) continue;

    const { totalCents: cohortCents } = sumHorizonMargins(entry.marginsByOffset, horizonMonths);
    channel.totalCents += cohortCents;
    channel.customers += entry.cohortSize;
    channel.cohorts += 1;
    completedMonths.add(entry.cohortMonth);
    totalCents += cohortCents;
    totalCustomers += entry.cohortSize;
  }

  const rows = [...byChannel.values()]
    .sort((left, right) => String(left.channelCode).localeCompare(String(right.channelCode)))
    .map((channel) => ({
      channelId: channel.channelId,
      channelCode: channel.channelCode,
      ltvCents: centsToApi(channel.customers > 0 ? divideCents(channel.totalCents, channel.customers) : null),
      customerCount: channel.customers,
      cohortCount: channel.cohorts,
      status: channel.customers > 0 ? 'ok' : 'insufficient_history',
    }));

  return {
    rows,
    blended: {
      ltvCents: centsToApi(totalCustomers > 0 ? divideCents(totalCents, totalCustomers) : null),
      customerCount: totalCustomers,
      cohortCount: completedMonths.size,
      status: totalCustomers > 0 ? 'ok' : 'insufficient_history',
    },
  };
}

/**
 * @param {{ cohortMonth: string, channelId: string }} entry
 * @returns {string}
 */
function entryKey(entry) {
  return `${entry.cohortMonth}|${entry.channelId}`;
}

/**
 * LTV and retention service (BO-02, BO-06).
 *
 * Two repository queries load cohort sizes and monthly margins for the whole requested range; every horizon,
 * matrix row and channel average is then computed in memory. Express, `req` and the pool are invisible here.
 *
 * @param {{
 *   cohortsRepository: ReturnType<typeof import('../../repositories/cohorts.repo.js').createCohortsRepository>,
 * }} deps
 */
export function createLtvService({ cohortsRepository }) {
  /**
   * Converts a repository validation failure into the same 400 shape every metrics service uses.
   * @template T
   * @param {() => T} read
   * @returns {T}
   * @throws {ValidationError} When the aggregate input is malformed.
   */
  function validated(read) {
    try {
      return read();
    } catch {
      throw new ValidationError('Некорректные параметры отчёта LTV');
    }
  }

  /**
   * Loads the two aggregates and the channel dimension inside one snapshot, then joins sizes and margins by
   * (cohort month, channel). Returns one entry per channel-cohort with a keyed `marginsByOffset` map.
   *
   * The snapshot is what lets the consistency guards below stay loud: without it an import committing between the
   * reads could yield a margin row whose cohort the sizes read never saw.
   *
   * @param {{
   *   fromCohortMonth: string | null, toCohortMonth: string, channelId: string | null, anchor: string,
   * }} filters
   * @returns {Promise<{
   *   entries: Array<{
   *     cohortMonth: string,
   *     cohortSize: number,
   *     channelId: string,
   *     channelCode: string,
   *     marginsByOffset: Map<number, { activeCustomers: number, marginCents: bigint }>,
   *   }>,
   *   channels: Array<{ channelId: string, channelCode: string, isActive: boolean }>,
   * }>}
   */
  async function loadReport(filters) {
    const { sizes, margins, channels } = await cohortsRepository.withSnapshot(async (repository) => {
      // Sequential on purpose: all three statements share one client/snapshot, and node-postgres deprecates
      // overlapping queries on a single client.
      const sizeRows = await repository.listCohortSizes(filters);
      const marginRows = await repository.listCohortMonthlyMargins(filters);
      const channelRows = await repository.listChannels({ channelId: filters.channelId });
      return { sizes: sizeRows, margins: marginRows, channels: channelRows };
    });

    /** @type {Map<string, object>} */
    const byKey = new Map();
    for (const size of sizes) {
      if (!Number.isInteger(size.cohortSize) || size.cohortSize < 0) {
        throw new TypeError(`cohortSize must be a non-negative integer, got ${String(size.cohortSize)}`);
      }
      // N = 0 means the cohort has no customers and therefore does not exist in the report.
      if (size.cohortSize === 0) continue;
      if (byKey.has(entryKey(size))) {
        throw new TypeError(`duplicate cohort size for ${entryKey(size)}`);
      }
      byKey.set(entryKey(size), { ...size, marginsByOffset: new Map() });
    }

    for (const row of margins) {
      const entry = byKey.get(entryKey(row));
      if (!entry) {
        throw new TypeError(`margin row without a cohort size for ${entryKey(row)}`);
      }
      if (entry.marginsByOffset.has(row.monthOffset)) {
        throw new TypeError(`duplicate month offset ${row.monthOffset} for ${entryKey(row)}`);
      }
      entry.marginsByOffset.set(row.monthOffset, {
        activeCustomers: row.activeCustomers,
        marginCents: row.marginCents,
      });
    }

    return {
      entries: [...byKey.values()].sort(
        (left, right) =>
          left.cohortMonth.localeCompare(right.cohortMonth) ||
          String(left.channelCode).localeCompare(String(right.channelCode)),
      ),
      channels,
    };
  }

  /**
   * @param {{ anchor?: string, horizonMonths?: number, fromCohortMonth?: string | null, toCohortMonth?: string,
   *   channelId?: string | null }} [request]
   * @returns {{ anchor: string, horizonMonths: number, filters: object }} Normalised options.
   */
  function normaliseMatrixRequest({
    anchor,
    horizonMonths = METRICS_CONFIG.ltv.defaultHorizon,
    fromCohortMonth = null,
    toCohortMonth,
    channelId = null,
  } = {}) {
    const anchorDate = validated(() => assertDate(anchor));
    const horizon = validated(() => assertHorizon(horizonMonths));
    const from = validated(() => (fromCohortMonth === null ? null : startOfMonth(assertDate(fromCohortMonth))));
    const to = validated(() => startOfMonth(assertDate(toCohortMonth ?? anchorDate)));
    if (from !== null && from > to) {
      throw new ValidationError('Начало диапазона когорт не может быть позже окончания');
    }
    // A cohort month after the anchor has no observed data; allowing it would silently produce an empty row and a
    // report whose range lies about the data horizon.
    if (to > startOfMonth(anchorDate)) {
      throw new ValidationError('Последний месяц когорт не может быть позже отчётной даты');
    }
    const scopedChannelId = channelId === null || channelId === undefined ? null : parseBigIntId(channelId);
    if (channelId !== null && channelId !== undefined && scopedChannelId === null) {
      throw new ValidationError('Некорректный идентификатор канала');
    }

    return {
      anchor: anchorDate,
      horizonMonths: horizon,
      filters: { fromCohortMonth: from, toCohortMonth: to, channelId: scopedChannelId, anchor: anchorDate },
    };
  }

  return {
    /**
     * Retention matrix plus channel LTV for one anchor and horizon.
     *
     * The rows are company-wide cohorts; a channel filter narrows the customers before aggregation, so the same
     * method produces the per-channel matrix of the channel card. Incomplete cohorts stay in `cohorts` (their
     * partial cells are the point of a cohort matrix) and are repeated in `excludedIncomplete` for the note that
     * explains why they do not move the channel average.
     *
     * @param {{
     *   anchor: string,
     *   horizonMonths?: number,
     *   fromCohortMonth?: string | null,
     *   toCohortMonth?: string,
     *   channelId?: string | null,
     * }} request
     * @returns {Promise<{
     *   horizonMonths: number,
     *   anchor: string,
     *   cohorts: object[],
     *   channelLtv: object[],
     *   excludedIncomplete: object[],
     * }>}
     * @throws {ValidationError} When the anchor, horizon, month range or channel id is invalid.
     */
    async getCohortMatrix(request) {
      const { anchor, horizonMonths, filters } = normaliseMatrixRequest(request);
      const { entries, channels } = await loadReport(filters);
      const options = { anchor, horizonMonths };

      const cohorts = mergeCompanyCohorts(entries).map((entry) => toCohortView(entry, options));
      const excludedIncomplete = cohorts
        .filter((cohort) => !cohort.isComplete)
        .map(({ cohortMonth, cohortLabel, cohortSize, ltvCents, ltvLabel, monthsObserved }) => ({
          cohortMonth,
          cohortLabel,
          cohortSize,
          ltvCents,
          ltvLabel,
          isComplete: false,
          monthsObserved,
        }));

      return {
        horizonMonths,
        anchor,
        cohorts,
        channelLtv: buildChannelLtv(entries, channels, options).rows,
        excludedIncomplete,
      };
    },

    /**
     * Channel LTV at one horizon over the whole customer history.
     *
     * There is deliberately no `from = anchor - horizonMonths` lower bound: the horizon limits which monthly
     * margins are summed for each cohort, while the cohort set must cover every month that already has a completed
     * horizon. A rolling start would silently drop the older cohorts and inflate the channel average.
     *
     * @param {{ anchor: string, horizonMonths?: number }} request
     * @returns {Promise<{
     *   rows: Array<{
     *     channelId: string, channelCode: string, ltvCents: string | null,
     *     customerCount: number, cohortCount: number, status: 'ok' | 'insufficient_history',
     *   }>,
     *   blended: {
     *     ltvCents: string | null, customerCount: number,
     *     cohortCount: number, status: 'ok' | 'insufficient_history',
     *   },
     * }>}
     * @throws {ValidationError} When the anchor or horizon is invalid.
     */
    async getChannelLtv({ anchor, horizonMonths = METRICS_CONFIG.ltv.defaultHorizon } = {}) {
      const anchorDate = validated(() => assertDate(anchor));
      const horizon = validated(() => assertHorizon(horizonMonths));
      const { entries, channels } = await loadReport({
        fromCohortMonth: null,
        toCohortMonth: startOfMonth(anchorDate),
        channelId: null,
        anchor: anchorDate,
      });

      const { rows, blended } = buildChannelLtv(entries, channels, {
        anchor: anchorDate,
        horizonMonths: horizon,
      });

      return { rows, blended };
    },
  };
}
