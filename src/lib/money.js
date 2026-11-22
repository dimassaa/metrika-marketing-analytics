import { ValidationError } from './errors.js';

/**
 * Parsed BYN amount: whole roubles and up to two kopeck digits.
 * Amounts never go through floating point — the parts are concatenated into a bigint, because `0.1 + 0.2`
 * mistakes in money are exactly what the kopecks-in-BIGINT model exists to prevent.
 */
const BYN_AMOUNT = /^(\d+)(?:[.,](\d{1,2}))?$/;
/** Integer cents as returned by node-postgres for a BIGINT column. */
const INTEGER_CENTS = /^\d+$/;

/**
 * Converts a user-entered BYN amount into integer kopecks.
 *
 * Accepts `1 234,56`, `1234.56`, `50`, and tolerates the `BYN` suffix users copy from the screen. Spaces (including
 * non-breaking ones) are grouping, not decimals, so they are stripped before matching. Values with more than two
 * decimal places are rejected instead of rounded: silently changing a price is worse than asking for a correction.
 *
 * @param {string | number} input Amount in Belarusian roubles; a number is accepted for internal callers.
 * @returns {bigint} Amount in kopecks.
 * @throws {ValidationError} On negative, empty, non-numeric or over-precise input.
 */
export function parseBynToCents(input) {
  if (input === null || input === undefined) {
    throw new ValidationError('Укажите сумму в белорусских рублях');
  }
  if (typeof input === 'number' && !Number.isFinite(input)) {
    throw new ValidationError('Сумма должна быть числом');
  }
  if (typeof input !== 'string' && typeof input !== 'number') {
    throw new ValidationError('Сумма должна быть числом');
  }

  // Whitespace is a grouping separator in both `1 234,56` and a pasted `1 234,56 BYN`.
  const normalized = String(input).trim().replace(/[\s\u00a0]/g, '').replace(/BYN$/i, '');
  if (normalized === '') {
    throw new ValidationError('Укажите сумму в белорусских рублях');
  }
  if (normalized.startsWith('-')) {
    throw new ValidationError('Сумма не может быть отрицательной');
  }

  const match = BYN_AMOUNT.exec(normalized);
  if (!match) {
    if (/^\d+[.,]\d{3,}$/.test(normalized)) {
      throw new ValidationError('Сумма указывается с точностью до копеек: не более двух знаков после запятой');
    }
    throw new ValidationError('Введите сумму в белорусских рублях, например 1 234,56');
  }

  const [, whole, fraction = ''] = match;
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

/**
 * The single bridge from node-postgres values to money bigints.
 *
 * `pg` returns BIGINT as a string to avoid precision loss. A see-through `Number()` would reintroduce it, and a
 * float can never be an exact kopeck count, so non-integers are rejected loudly rather than rounded.
 *
 * @param {string | number | bigint | null | undefined} value Raw column value or an already-parsed amount.
 * @returns {bigint | null} Kopecks, or null when the column is NULL (an honest "not set").
 * @throws {TypeError} When the value is not an integer number of kopecks.
 */
export function centsFromDb(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`centsFromDb expected integer kopecks, got ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    if (!INTEGER_CENTS.test(value)) {
      throw new TypeError(`centsFromDb expected integer kopecks as a string, got ${JSON.stringify(value)}`);
    }
    return BigInt(value);
  }
  throw new TypeError(`centsFromDb cannot convert ${typeof value} to kopecks`);
}
