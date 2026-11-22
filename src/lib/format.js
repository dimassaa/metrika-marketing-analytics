import { roundNumber } from './metrics-math.js';
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
 * Renders a compact BYN amount for a chart axis: `1 234`, `12,3 тыс.`, `1,2 млн`.
 *
 * Compaction applies to whole roubles (the input is kopecks), so the unit always means roubles: `12,3 тыс.` is
 * 12 300 BYN. A chart axis has no room for kopecks; the tooltip and the duplicate table keep the exact amount.
 * Below ten thousand roubles the grouped number is short enough and more precise than a unit suffix.
 *
 * @param {bigint | string | number | null | undefined} value Amount in kopecks.
 * @returns {string} Ready-to-display compact amount; the caller adds the BYN glyph to the axis label.
 */
export function formatCompactCents(value) {
  const cents = centsFromDb(value);
  if (cents === null) return EM_DASH;

  const negative = cents < 0n;
  const rubles = (negative ? -cents : cents + 50n) / 100n;
  if (rubles === 0n) return '0';

  /**
   * @param {bigint} unit Size of one compact unit in roubles.
   * @param {string} suffix
   * @returns {string}
   */
  const compact = (unit, suffix) => {
    const tenths = (rubles + unit / 20n) / (unit / 10n);
    const whole = tenths / 10n;
    const fraction = tenths % 10n;
    const body = fraction === 0n ? whole.toString() : `${whole},${fraction}`;
    return `${body} ${suffix}`;
  };

  let text;
  if (rubles < 10_000n) {
    text = groupThousands(rubles.toString());
  } else if (rubles < 1_000_000n) {
    text = compact(1000n, 'тыс.');
  } else {
    text = compact(1_000_000n, 'млн');
  }
  return `${negative ? MINUS : ''}${text}`;
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
 * Renders ROMI with the UI contract of metrics spec §3.2: signed and one decimal (`+713,1%`, `−0,1%`).
 *
 * A negative value that rounds to zero at one decimal must never read as `0,0%` or as a positive zero: it becomes
 * `−<0,1%`, which keeps the sign and says "less than a tenth of a percent". The raw API value keeps two decimals;
 * this formatter is display-only.
 *
 * @param {string | number | null | undefined} value ROMI percentage.
 * @returns {string} Ready-to-display signed percentage, or `—` for NULL.
 * @throws {TypeError} When the value is not a finite number.
 */
export function formatRomi(value) {
  if (value === null || value === undefined || value === '') return EM_DASH;

  const numeric = typeof value === 'string' ? Number(value.trim().replace(',', '.')) : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new TypeError(`formatRomi expected a finite number, got ${JSON.stringify(value)}`);
  }

  const rounded = roundNumber(numeric, 1);
  if (rounded === 0) {
    // Exact zero is a measured zero. A tiny negative is not zero and must keep its direction.
    if (numeric === 0) return '0,0%';
    return numeric < 0 ? `${MINUS}<0,1%` : '+0,0%';
  }

  const sign = rounded < 0 ? MINUS : '+';
  return `${sign}${Math.abs(rounded).toFixed(1).replace('.', ',')}%`;
}

/**
 * Expands exponent notation into a plain decimal so `formatMonths` never shows `1e-7` to a user. The exponent is
 * bounded: a value needing more than 100 zeros on either side of the decimal point is not a month count, and
 * expanding it would allocate a pointless string.
 *
 * @param {string} text Decimal with a dot, possibly in exponent form.
 * @returns {string} Plain decimal with a dot.
 * @throws {TypeError} When the exponent is outside the supported range.
 */
function expandExponent(text) {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (!match) return text;

  const [, sign, whole, fraction = '', exponentText] = match;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
    throw new TypeError(`formatMonths exponent is out of range: ${JSON.stringify(text)}`);
  }

  const digits = `${whole}${fraction}`;
  const point = whole.length + exponent;
  let plain;
  if (point <= 0) {
    plain = `0.${'0'.repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    plain = `${digits}${'0'.repeat(point - digits.length)}`;
  } else {
    plain = `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  plain = plain.replace(/^0+(?=\d)/, '');
  return sign === '-' ? `-${plain}` : plain;
}

/**
 * Renders a month count without fake precision: `12`, `12,5`, `—`. Used by payback and LTV horizons, where a whole
 * month must not read as `12,00` and a percentage formatter would add a misleading `%`.
 *
 * @param {string | number | null | undefined} value Months, usually the NUMERIC text `pg` returns.
 * @returns {string} Ready-to-display month count, or `—` for NULL.
 * @throws {TypeError} When the value is not numeric.
 */
export function formatMonths(value) {
  if (value === null || value === undefined || value === '') return EM_DASH;

  const raw = (typeof value === 'string' ? value.trim() : String(value)).replace(',', '.');
  if (!Number.isFinite(Number(raw))) {
    throw new TypeError(`formatMonths expected a finite number, got ${JSON.stringify(value)}`);
  }
  const text = expandExponent(raw);

  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  const body = trimmed === '' ? whole : `${whole},${trimmed}`;
  return `${negative ? MINUS : ''}${body}`;
}

/**
 * Renders a coefficient with a fixed number of decimals and a comma: `2,999`, `2,50`. The precision bounds and the
 * error message come from `roundNumber`, so this formatter cannot accept more digits than the arithmetic supports.
 *
 * @param {string | number | null | undefined} value Ratio value, e.g. LTV:CAC.
 * @param {{ decimals?: number }} [options] Decimal places, default 3 per metrics spec §0.
 * @returns {string} Ready-to-display ratio, or `—` for NULL.
 * @throws {TypeError} When the value is not finite or the precision is invalid.
 */
export function formatRatio(value, { decimals = 3 } = {}) {
  if (value === null || value === undefined || value === '') return EM_DASH;

  const numeric = typeof value === 'string' ? Number(value.trim().replace(',', '.')) : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new TypeError(`formatRatio expected a finite number, got ${JSON.stringify(value)}`);
  }

  const rounded = roundNumber(numeric, decimals);
  const sign = rounded < 0 ? MINUS : '';
  return `${sign}${Math.abs(rounded).toFixed(decimals).replace('.', ',')}`;
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
