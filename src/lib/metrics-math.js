/**
 * Arithmetic shared by the metrics services.
 *
 * Money stays a `bigint` of kopecks until a view-model is built; ratios, percentages and normalised scores are
 * numbers because that is what the UI and JSON need. Every division checks its denominator first: a missing value
 * is `null`, never `NaN` or `Infinity` (metrics spec §0).
 */

/** Decimal places used when a normalised score is produced. Ranking shows a percentage with one decimal, so six
 *  guard digits are plenty and keep `normalizeNumber`/`normalizeBigInt` consistent with each other. */
const NORMALIZE_DECIMALS = 6;

/**
 * @param {number} value Finite number to check.
 * @param {string} name Field name used in the error, so a bad formula is easy to locate.
 * @returns {number} The same value.
 * @throws {TypeError} When the value is not a finite number.
 */
export function assertFinite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got ${String(value)}`);
  }
  return value;
}

/**
 * @param {number | null | undefined} value
 * @param {string} name
 * @returns {number | null} `null` is the only allowed "no value"; anything else must be finite.
 * @throws {TypeError} When a non-null value is not a finite number.
 */
export function assertFiniteOrNull(value, name) {
  if (value === null || value === undefined) return null;
  return assertFinite(value, name);
}

/**
 * Decimal string of integer kopecks for JSON. The value is deliberately a string: JavaScript numbers cannot hold
 * every BIGINT kopeck count exactly, and the client must not lose a kopeck while parsing.
 * @param {bigint | null} cents
 * @returns {string | null}
 * @throws {TypeError} When the value is not a bigint.
 */
export function centsToApi(cents) {
  if (cents === null || cents === undefined) return null;
  if (typeof cents !== 'bigint') {
    throw new TypeError(`centsToApi expected bigint kopecks, got ${typeof cents}`);
  }
  return cents.toString();
}

/**
 * Renders kopecks as the decimal a `NUMERIC` column accepts: `5000n → '50.00'`.
 * Used when a computed money value has to be stored, never for display (that is `formatCentsToByn`).
 * @param {bigint | null} cents
 * @returns {string | null}
 * @throws {TypeError} When the value is not a bigint.
 */
export function centsToBynDecimal(cents) {
  if (cents === null || cents === undefined) return null;
  if (typeof cents !== 'bigint') {
    throw new TypeError(`centsToBynDecimal expected bigint kopecks, got ${typeof cents}`);
  }
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${absolute / 100n}.${fraction}`;
}

/**
 * Divides two bigint amounts and rounds the ratio half up away from zero without routing the division through a
 * float. The numerator and denominator may each be negative; the result keeps the mathematical sign.
 *
 * The final `Number` conversion is exact only while the scaled bigint is at most 2^53; a larger ratio is
 * approximate. That is acceptable here because ratios are view-model numbers, never money: CAC and all balances
 * remain bigint kopecks.
 *
 * @param {bigint} numerator
 * @param {bigint} denominator
 * @param {number} [decimals] Result precision, 0–12.
 * @returns {number | null} `null` when the denominator is zero.
 * @throws {TypeError} When the operands or the precision are not integers.
 */
export function centsRatio(numerator, denominator, decimals = 2) {
  assertBigInt(numerator, 'centsRatio numerator');
  assertBigInt(denominator, 'centsRatio denominator');
  assertDecimals(decimals);
  if (denominator === 0n) return null;

  const negative = numerator < 0n !== denominator < 0n;
  const absoluteNumerator = numerator < 0n ? -numerator : numerator;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  const scale = 10n ** BigInt(decimals);

  // floor((|num| * scale * 2 + |den|) / (2 * |den|)) is exact half-up rounding of |num|/|den| * scale.
  const scaled = (absoluteNumerator * scale * 2n + absoluteDenominator) / (2n * absoluteDenominator);
  const value = Number(scaled) / Number(scale);
  return negative && value !== 0 ? -value : value;
}

/**
 * Same as `centsRatio`, but the result is a percentage: `50000n / 100000n → 50`.
 * @param {bigint} numerator
 * @param {bigint} denominator
 * @param {number} [decimals]
 * @returns {number | null}
 */
export function centsPercent(numerator, denominator, decimals = 2) {
  assertBigInt(numerator, 'centsPercent numerator');
  assertBigInt(denominator, 'centsPercent denominator');
  return centsRatio(numerator * 100n, denominator, decimals);
}

/**
 * Normalises a bigint into `[0, 1]` for the ranking. The calculation is done in bigint so the score does not depend
 * on floating-point subtraction of two large kopeck values.
 * @param {bigint} value
 * @param {bigint} min
 * @param {bigint} max
 * @returns {number} `1` when the range is empty, which makes a single-candidate ranking neutral rather than zero.
 */
export function normalizeBigInt(value, min, max) {
  assertBigInt(value, 'normalizeBigInt value');
  assertBigInt(min, 'normalizeBigInt min');
  assertBigInt(max, 'normalizeBigInt max');
  if (max === min) return 1;

  const scale = 10n ** BigInt(NORMALIZE_DECIMALS);
  const span = max - min;
  const offset = value - min;
  const negative = offset < 0n !== span < 0n;
  const absoluteOffset = offset < 0n ? -offset : offset;
  const absoluteSpan = span < 0n ? -span : span;
  const scaled = (absoluteOffset * scale * 2n + absoluteSpan) / (2n * absoluteSpan);
  const normalized = Number(scaled) / Number(scale);
  return negative && normalized !== 0 ? -normalized : normalized;
}

/**
 * Number counterpart of `normalizeBigInt`, for values that already are ratios.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function normalizeNumber(value, min, max) {
  assertFinite(value, 'normalizeNumber value');
  assertFinite(min, 'normalizeNumber min');
  assertFinite(max, 'normalizeNumber max');
  if (max === min) return 1;
  return roundNumber((value - min) / (max - min), NORMALIZE_DECIMALS);
}

/**
 * Percent change against the absolute previous value, as metrics spec §0 defines it.
 * @param {number} current
 * @param {number} previous
 * @returns {number | null} `null` when there is no baseline to compare against.
 */
export function percentChange(current, previous) {
  assertFinite(current, 'percentChange current');
  assertFinite(previous, 'percentChange previous');
  if (previous === 0) return null;
  return roundNumber(((current - previous) / Math.abs(previous)) * 100, 2);
}

/**
 * Rounds a number to a fixed number of decimals, half up away from zero. This is for display values only; money and
 * health comparisons use `bigint` (metrics spec §0 and plan decision 7).
 * @param {number | null | undefined} value
 * @param {number} decimals Non-negative integer.
 * @returns {number | null}
 * @throws {TypeError} When the value is not finite or the precision is invalid.
 */
export function roundNumber(value, decimals) {
  if (value === null || value === undefined) return null;
  const numeric = assertFinite(value, 'roundNumber value');
  assertDecimals(decimals);

  const factor = 10 ** decimals;
  const scaled = numeric * factor;
  // A relative epsilon absorbs the last-bit error of the multiplication; without it 2.9996 * 1000 can land on
  // 2999.5999999999995 and round down. A constant epsilon would be far too small for large scaled values.
  const epsilon = Math.abs(scaled) * Number.EPSILON;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled) + epsilon);
  return rounded === 0 ? 0 : rounded / factor;
}

/**
 * Rounds a number to a whole bigint, half up away from zero. Money must never be rounded through a decimal string.
 * @param {number} value
 * @returns {bigint}
 * @throws {TypeError} When the value is not finite.
 */
export function roundHalfUp(value) {
  const numeric = assertFinite(value, 'roundHalfUp value');
  const rounded = Math.sign(numeric) * Math.round(Math.abs(numeric));
  return BigInt(rounded);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @throws {TypeError} When the value is not a bigint.
 */
function assertBigInt(value, name) {
  if (typeof value !== 'bigint') {
    throw new TypeError(`${name} must be a bigint, got ${typeof value}`);
  }
}

/**
 * @param {number} decimals
 * @throws {TypeError} When the precision is not a small non-negative integer.
 */
function assertDecimals(decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
    throw new TypeError(`decimals must be an integer between 0 and 12, got ${String(decimals)}`);
  }
}
