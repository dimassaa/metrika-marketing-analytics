import { METRICS_CONFIG } from '../../config/metrics.js';
import { addDays } from '../../lib/dates.js';
import { ValidationError } from '../../lib/errors.js';
import { assertFinite, centsToApi } from '../../lib/metrics-math.js';
import { centsFromDb } from '../../lib/money.js';

/**
 * Deterministic saturation curve for one channel (metrics spec §6.1).
 *
 * The model is `conversions(b) = K·(1 − e^(−b/S))`, where `b` is weekly spend in BYN. The fit is a plain grid
 * search, not an optimiser: 60 linear `K` values and 60 logarithmic `S` values, SSE over all observed weeks, and the
 * first minimum in row-major order wins. A fixed grid makes the result reproducible byte for byte across processes
 * and runs; a random or iterative search would make a saved scenario impossible to reproduce after a deploy.
 *
 * Money enters as bigint kopecks (`points[].spendCents`) and leaves as decimal kopeck strings, exactly like every
 * other metrics service. The curve arithmetic itself is in BYN as floating point, which is correct here: `K` and `S`
 * are model parameters, not money, and no kopeck is ever reconstructed from them.
 */

/** Weekly buckets are the only window the saturation model accepts; 52 weeks is the same ceiling as the charts. */
const MAX_BUCKET_WEEKS = 52;

/**
 * @param {unknown} weeks
 * @throws {ValidationError} When the value is not an integer in `[1, 52]`.
 */
function assertWeekCount(weeks) {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_BUCKET_WEEKS) {
    throw new ValidationError(
      `Количество недель должно быть целым числом от 1 до ${MAX_BUCKET_WEEKS}`,
    );
  }
}

/**
 * @param {unknown} value
 * @param {string} name Field name used in the error.
 * @returns {number} The same finite, non-negative number.
 * @throws {TypeError} When the value is not a finite non-negative number.
 */
function assertCustomerCount(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number, got ${String(value)}`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} name Field name used in the error.
 * @returns {bigint} Non-negative kopecks.
 * @throws {TypeError} When the value is not integer kopecks or is negative.
 */
function assertSpendCents(value, name) {
  const spendCents = centsFromDb(value);
  if (spendCents === null || spendCents < 0n) {
    throw new TypeError(`${name} must be non-negative integer kopecks, got ${String(value)}`);
  }
  return spendCents;
}

/**
 * @param {Map<string, unknown> | Record<string, unknown> | undefined | null} rowsByChannel
 * @returns {Array<[string, unknown]>} Channel id and its raw rows, in input order.
 */
function channelEntries(rowsByChannel) {
  if (rowsByChannel instanceof Map) return [...rowsByChannel.entries()];
  if (rowsByChannel === null || rowsByChannel === undefined) return [];
  if (typeof rowsByChannel !== 'object' || Array.isArray(rowsByChannel)) {
    throw new TypeError('rowsByChannel must be a Map or a plain object keyed by channel id');
  }
  return Object.entries(rowsByChannel);
}

/**
 * Builds a complete Monday-to-Sunday bucket per channel.
 *
 * The axis is exactly `weeks` points long: a week with no row is a measured zero, because a missing bucket would
 * shorten the chart and shift every later week. Rows outside `[firstWeekStart, firstWeekStart + 7·(weeks−1)]` are
 * ignored and never extend the axis. Several rows for one week are summed: the repository contract allows a source
 * to split a week and dropping all but the last row would understate spend without any warning.
 *
 * `firstWeekStart` is the Monday returned by `resolveWeekRange(anchor, weeks).firstWeekStart`; this function does not
 * resolve the range itself, so the caller owns the data-anchor rule.
 *
 * @param {{
 *   firstWeekStart: string,
 *   weeks: number,
 *   rowsByChannel: Map<string, Array<{ weekStart: string, spendCents: bigint | string | number, newCustomers: number }>>
 *     | Record<string, Array<{ weekStart: string, spendCents: bigint | string | number, newCustomers: number }>>,
 * }} input
 * @returns {Map<string, Array<{ weekStart: string, spendCents: bigint, newCustomers: number }>>}
 * @throws {ValidationError} When `weeks` is not an integer in `[1, 52]`.
 * @throws {TypeError} When `rowsByChannel` or a row breaks the contract.
 */
export function toWeeklyBuckets({ firstWeekStart, weeks, rowsByChannel }) {
  assertWeekCount(weeks);

  const result = new Map();
  for (const [channelId, rawRows] of channelEntries(rowsByChannel)) {
    if (!Array.isArray(rawRows)) {
      throw new TypeError(`rowsByChannel[${String(channelId)}] must be an array`);
    }

    /** @type {Map<string, { spendCents: bigint, newCustomers: number }>} */
    const byWeek = new Map();
    for (const row of rawRows) {
      const weekStart = row?.weekStart;
      // A malformed week key would never match an axis date and the row would silently disappear from the fit.
      if (typeof weekStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
        throw new TypeError(`saturation bucket weekStart must be YYYY-MM-DD, got ${String(weekStart)}`);
      }
      const spendCents = assertSpendCents(row?.spendCents, 'saturation bucket spendCents');
      const newCustomers = assertCustomerCount(row?.newCustomers, 'saturation bucket newCustomers');
      const existing = byWeek.get(weekStart) ?? { spendCents: 0n, newCustomers: 0 };
      byWeek.set(weekStart, {
        spendCents: existing.spendCents + spendCents,
        newCustomers: existing.newCustomers + newCustomers,
      });
    }

    const buckets = [];
    for (let offset = 0; offset < weeks; offset += 1) {
      const weekStart = addDays(firstWeekStart, offset * 7);
      const row = byWeek.get(weekStart);
      buckets.push({
        weekStart,
        spendCents: row?.spendCents ?? 0n,
        newCustomers: row?.newCustomers ?? 0,
      });
    }
    result.set(channelId, buckets);
  }

  return result;
}

/**
 * Validates and normalises the fit input. Counts are accepted as any finite non-negative number because the fit is
 * also used with the smooth synthetic curve in the test suite; production counts are integers.
 *
 * @param {unknown} points
 * @returns {Array<{ spendCents: bigint, newCustomers: number }>}
 * @throws {TypeError} When a point breaks the contract.
 */
function normalizePoints(points) {
  if (!Array.isArray(points)) {
    throw new TypeError('saturation points must be an array');
  }
  return points.map((point) => ({
    spendCents: assertSpendCents(point?.spendCents, 'saturation point spendCents'),
    newCustomers: assertCustomerCount(point?.newCustomers, 'saturation point newCustomers'),
  }));
}

/**
 * Rounds `totalSpendCents / totalCustomers` to whole kopecks, half up.
 *
 * Integer customer counts take the exact bigint path. Fractional counts only exist in the synthetic fixture of the
 * test suite, and the fallback keeps that fixture usable; it is a derived ratio, never stored money, so the float
 * here cannot corrupt a `*_cents` column.
 *
 * @param {bigint} totalSpendCents
 * @param {number} totalCustomers
 * @returns {bigint}
 */
function cpaCentsFromTotals(totalSpendCents, totalCustomers) {
  if (Number.isInteger(totalCustomers)) {
    const customers = BigInt(totalCustomers);
    return (totalSpendCents * 2n + customers) / (2n * customers);
  }
  return BigInt(Math.round(Number(totalSpendCents) / totalCustomers));
}

/**
 * @param {number} min
 * @param {number} max
 * @param {number} steps
 * @returns {number[]} `steps` values from `min` to `max` inclusive, evenly spaced.
 */
function linearGrid(min, max, steps) {
  const step = (max - min) / (steps - 1);
  return Array.from({ length: steps }, (_, index) => min + step * index);
}

/**
 * @param {number} min Positive lower bound.
 * @param {number} max Upper bound.
 * @param {number} steps
 * @returns {number[]} `steps` values from `min` to `max` inclusive, spaced geometrically.
 */
function logarithmicGrid(min, max, steps) {
  const logMin = Math.log(min);
  const logMax = Math.log(max);
  return Array.from({ length: steps }, (_, index) =>
    Math.exp(logMin + ((logMax - logMin) * index) / (steps - 1)),
  );
}

/**
 * Best `(K, S)` of the deterministic grid.
 *
 * @param {number[]} spendsByn
 * @param {number[]} observed
 * @param {{ kMin: number, kMax: number, sMin: number, sMax: number, steps: number }} bounds
 * @returns {{ K: number, S: number, sse: number }}
 */
function searchCurve(spendsByn, observed, { kMin, kMax, sMin, sMax, steps }) {
  const kValues = linearGrid(kMin, kMax, steps);
  const sValues = logarithmicGrid(sMin, sMax, steps);

  let bestK = kValues[0];
  let bestS = sValues[0];
  let bestSse = Number.POSITIVE_INFINITY;

  // Row-major order plus a strict `<` is the tie-break: the first minimum on the grid wins, so the result depends on
  // the data and the configuration only, never on iteration order of an object or on floating-point luck.
  for (const K of kValues) {
    for (const S of sValues) {
      let sse = 0;
      for (let index = 0; index < spendsByn.length; index += 1) {
        const predicted = K * (1 - Math.exp(-spendsByn[index] / S));
        const residual = predicted - observed[index];
        sse += residual * residual;
      }
      if (sse < bestSse) {
        bestSse = sse;
        bestK = K;
        bestS = S;
      }
    }
  }

  return { K: bestK, S: bestS, sse: bestSse };
}

/**
 * Fits the saturation curve to the weekly points of one channel.
 *
 * Decision order (metrics spec §6.1):
 * 1. no spend or no new customers in the whole window → `no_data`; a curve through zeros is fiction.
 * 2. fewer than `config.minPositiveWeeks` weeks with spend > 0 → `linear` with the aggregate CPA and a visible note.
 * 3. otherwise the deterministic grid fit, with `R² = 1 − SSE/SST` over all points.
 *
 * Money fields are decimal kopeck strings. `meanSpendCents` is defined only over weeks with spend > 0 and is `null`
 * when there are none, never `0`: zero is a measured value, not "no weeks to average". The same mean bounds the
 * logarithmic `S` grid, so the displayed value and the search cannot disagree.
 *
 * @param {{
 *   points?: Array<{ spendCents: bigint | string | number, newCustomers: number }>,
 *   config?: typeof METRICS_CONFIG.saturation,
 * }} [input]
 * @returns {{
 *   model: 'saturation' | 'linear' | 'no_data',
 *   K: number | null,
 *   S: number | null,
 *   cpaCents: string | null,
 *   sse: number,
 *   sst: number,
 *   r2: number | null,
 *   unreliable: boolean,
 *   positiveWeeks: number,
 *   maxSpendCents: string,
 *   meanSpendCents: string | null,
 *   maxObservedCustomers: number,
 *   warning: string | null,
 * }}
 * @throws {TypeError} When a point or the grid configuration breaks the contract.
 */
export function fitSaturationCurve({ points = [], config = METRICS_CONFIG.saturation } = {}) {
  const normalized = normalizePoints(points);

  let totalSpendCents = 0n;
  let totalCustomers = 0;
  let positiveSpendCents = 0n;
  let positiveWeeks = 0;
  let maxSpendCents = 0n;
  let maxObservedCustomers = 0;

  for (const point of normalized) {
    totalSpendCents += point.spendCents;
    totalCustomers += point.newCustomers;
    if (point.spendCents > maxSpendCents) maxSpendCents = point.spendCents;
    if (point.newCustomers > maxObservedCustomers) maxObservedCustomers = point.newCustomers;
    if (point.spendCents > 0n) {
      positiveWeeks += 1;
      positiveSpendCents += point.spendCents;
    }
  }

  // Integer division with half-up rounding: (2·sum + weeks) / (2·weeks).
  const meanSpendCents =
    positiveWeeks === 0
      ? null
      : (positiveSpendCents * 2n + BigInt(positiveWeeks)) / (2n * BigInt(positiveWeeks));

  const shared = {
    positiveWeeks,
    maxSpendCents: centsToApi(maxSpendCents),
    meanSpendCents: meanSpendCents === null ? null : meanSpendCents.toString(),
    maxObservedCustomers,
  };

  if (totalSpendCents === 0n || totalCustomers <= 0) {
    return {
      model: 'no_data',
      K: null,
      S: null,
      cpaCents: null,
      sse: 0,
      sst: 0,
      r2: null,
      unreliable: true,
      ...shared,
      warning:
        totalSpendCents === 0n
          ? 'Нет недель с расходом — кривую построить нельзя'
          : 'Нет новых клиентов за период — кривую построить нельзя',
    };
  }

  if (positiveWeeks < config.minPositiveWeeks) {
    return {
      model: 'linear',
      K: null,
      S: null,
      cpaCents: cpaCentsFromTotals(totalSpendCents, totalCustomers).toString(),
      sse: 0,
      sst: 0,
      r2: null,
      // A linear fallback has no R² at all; the UI must treat it as "no curve", not as a good fit.
      unreliable: true,
      ...shared,
      warning: 'Недостаточно недель с расходом — использована линейная модель',
    };
  }

  if (!Number.isInteger(config.gridSteps) || config.gridSteps < 2) {
    throw new TypeError(`saturation gridSteps must be an integer of at least 2, got ${String(config.gridSteps)}`);
  }

  const spendsByn = normalized.map((point) => Number(point.spendCents) / 100);
  const observed = normalized.map((point) => point.newCustomers);
  const maxObserved = shared.maxObservedCustomers;
  const maxSpendByn = Number(maxSpendCents) / 100;
  const meanSpendByn = Number(meanSpendCents) / 100;

  const bounds = {
    kMin: config.kMinFactor * maxObserved,
    kMax: config.kMaxFactor * maxObserved,
    sMin: config.sMinFactor * meanSpendByn,
    sMax: config.sMaxFactor * maxSpendByn,
    steps: config.gridSteps,
  };
  for (const [name, value] of Object.entries(bounds)) {
    if (name !== 'steps') assertFinite(value, `saturation ${name}`);
  }
  if (!(bounds.kMin > 0) || !(bounds.kMax > bounds.kMin) || !(bounds.sMin > 0) || !(bounds.sMax > bounds.sMin)) {
    throw new TypeError('saturation grid bounds must be positive and increasing');
  }

  const { K, S, sse } = searchCurve(spendsByn, observed, bounds);
  assertFinite(K, 'saturation K');
  assertFinite(S, 'saturation S');
  assertFinite(sse, 'saturation SSE');

  const meanObserved = totalCustomers / observed.length;
  let sst = 0;
  for (const value of observed) {
    const deviation = value - meanObserved;
    sst += deviation * deviation;
  }

  // SST = 0 means every observation is identical. R² is then 1 only for a perfect fit and undefined otherwise;
  // dividing would produce 0/0 and poison the view-model with NaN.
  const r2 = sst === 0 ? (sse === 0 ? 1 : null) : 1 - sse / sst;
  if (r2 !== null) assertFinite(r2, 'saturation R²');
  const unreliable = r2 === null || r2 < config.r2WarnBelow;

  return {
    model: 'saturation',
    K,
    S,
    cpaCents: null,
    sse,
    sst,
    r2,
    unreliable,
    ...shared,
    warning: unreliable ? 'Кривая ненадёжна — низкое качество подгонки' : null,
  };
}

/**
 * Predicted conversions for a weekly spend. Returns `0` at zero spend and for every non-positive spend: a negative
 * budget has no meaning in the model, and returning a negative conversion would break monotonicity.
 *
 * The curve is monotone by construction (`exp` is decreasing), and the result is clamped at `K` so a caller that
 * plots or sums forecasts can never see a value above the theoretical ceiling because of a last-bit rounding.
 *
 * @param {ReturnType<typeof fitSaturationCurve>} fit
 * @param {number} spendByn Weekly spend in BYN.
 * @returns {number} Non-negative conversions; fractional, because a forecast is not a count yet.
 * @throws {TypeError} When `spendByn` is not a finite number.
 */
export function predictConversions(fit, spendByn) {
  assertFinite(spendByn, 'predictConversions spendByn');
  if (spendByn <= 0) return 0;
  if (!fit || fit.model === 'no_data') return 0;
  if (fit.model === 'linear') return predictLinear(fit, spendByn);

  const { K, S } = fit;
  if (typeof K !== 'number' || typeof S !== 'number' || !(K > 0) || !(S > 0)) return 0;

  const predicted = K * (1 - Math.exp(-spendByn / S));
  return Math.min(K, Math.max(0, predicted));
}

/**
 * Prediction of the linear fallback `q = b / CPA`. The CPA is stored as integer kopeck text, so the division happens
 * on kopecks (`b·100 / cpaCents`) and never compares BYN to a kopeck by accident.
 *
 * @param {ReturnType<typeof fitSaturationCurve>} fit
 * @param {number} spendByn Weekly spend in BYN.
 * @returns {number} Predicted conversions, or 0 when the fit carries no usable CPA.
 * @throws {TypeError} When `spendByn` is not a finite number.
 */
export function predictLinear(fit, spendByn) {
  assertFinite(spendByn, 'predictLinear spendByn');
  if (spendByn <= 0) return 0;
  if (!fit || fit.model !== 'linear') return 0;

  const cpaCents = centsFromDb(fit.cpaCents);
  if (cpaCents === null || cpaCents <= 0n) return 0;

  return (spendByn * 100) / Number(cpaCents);
}
