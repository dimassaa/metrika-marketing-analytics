import { centsFromDb } from './money.js';

/** Typographic minus: the UI shows `−8,1%`, never the ASCII hyphen of a form field. */
const MINUS = '\u2212';
const EM_DASH = '—';

/**
 * Groups digits with a plain space (`12 345`). The currency sign is rendered by the template as
 * `<span class="byn">BYN</span>`, so this module never deals with HTML or currency symbols.
 * @param {string} digits Digits, optionally negative.
 * @returns {string}
 */
function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * @param {string} text Normalized decimal text; the caller guarantees finiteness.
 * @returns {string} Up to two decimals, at least one, with a comma.
 */
function withCommaDecimals(text) {
  const [whole, fraction = ''] = text.split('.');
  const decimals = (fraction + '00').slice(0, 2).replace(/0$/, '');
  return `${groupThousands(whole)},${decimals}`;
}

/**
 * Renders integer kopecks as a BYN amount without the currency sign: `1 234,56`, `0,00`, `—` for NULL.
 * Accepts the string `pg` returns for BIGINT, because formatting is the first place that value is displayed.
 *
 * @param {bigint | string | number | null | undefined} value Amount in kopecks.
 * @returns {string} Ready-to-display amount; the template appends the BYN glyph.
 */
export function formatCentsToByn(value) {
  const cents = centsFromDb(value);
  if (cents === null) return EM_DASH;

  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  const sign = negative ? MINUS : '';
  return `${sign}${groupThousands(whole.toString())},${fraction}`;
}

/**
 * Renders a percentage (`12,4%`, `−8,1%`, `+12,4%` when signed) from the NUMERIC string `pg` returns.
 * One or two decimals: whole targets such as 120 read as `120,0%`, which keeps a column of values aligned.
 *
 * @param {string | number | bigint | null | undefined} value Percent value, e.g. `'115.50'` or `-8.1`.
 * @param {{ signed?: boolean }} [options] `signed` prefixes positive values with `+`, for deltas.
 * @returns {string} Ready-to-display percentage, or `—` for NULL.
 * @throws {TypeError} When the value is not a finite number.
 */
export function formatPercent(value, { signed = false } = {}) {
  if (value === null || value === undefined || value === '') return EM_DASH;

  const numeric = typeof value === 'string' ? Number(value.trim().replace(',', '.')) : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new TypeError(`formatPercent expected a finite number, got ${JSON.stringify(value)}`);
  }

  const negative = numeric < 0;
  const absolute = Math.abs(numeric);
  const sign = negative ? MINUS : numeric > 0 && signed ? '+' : '';
  // `toFixed` only runs after the value is known finite, and percentages are not money, so a float is acceptable.
  return `${sign}${withCommaDecimals(absolute.toFixed(2))}%`;
}

/**
 * Renders a whole count with grouped thousands: `12 345`. Used for customer, click and campaign counters.
 * @param {string | number | bigint | null | undefined} value Integer, or NULL when nothing was counted.
 * @returns {string} Ready-to-display integer, or `—` for NULL.
 * @throws {TypeError} When the value is not an integer.
 */
export function formatInteger(value) {
  if (value === null || value === undefined || value === '') return EM_DASH;

  let integer;
  if (typeof value === 'bigint') {
    integer = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    integer = BigInt(value);
  } else if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    integer = BigInt(value);
  } else {
    throw new TypeError(`formatInteger expected an integer, got ${JSON.stringify(value)}`);
  }

  const negative = integer < 0n;
  return `${negative ? MINUS : ''}${groupThousands((negative ? -integer : integer).toString())}`;
}
