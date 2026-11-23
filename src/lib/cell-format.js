import { formatDateRu } from './dates.js';
import {
  formatCentsToByn,
  formatInteger,
  formatMonths,
  formatPercent,
  formatRatio,
  formatRomi,
} from './format.js';

/**
 * The single token → formatter map used by table cells.
 *
 * A screen model may not carry raw tokens and a React table may not build its own map: both would eventually format
 * the same value differently. This module is the one place that answers "what does `cents` mean", and every formatter
 * is imported unchanged from `format.js` (dates from the date module, since that is where the calendar formatter
 * lives). An unknown token is a programming error, not an empty cell.
 */
const FORMATTERS = Object.freeze({
  cents: formatCentsToByn,
  percent: formatPercent,
  romi: formatRomi,
  integer: formatInteger,
  months: formatMonths,
  ratio: formatRatio,
  date: formatDateRu,
});

/**
 * @param {'cents' | 'percent' | 'romi' | 'integer' | 'months' | 'ratio' | 'date'} token Cell type.
 * @param {unknown} value Raw value from the view-model.
 * @returns {string} Ready-to-display text, including the `—` for a missing value.
 * @throws {TypeError} When the token is unknown.
 */
export function cellFormat(token, value) {
  const formatter = FORMATTERS[token];
  if (!formatter) {
    throw new TypeError(`Unknown cell format token: ${JSON.stringify(token)}`);
  }
  return formatter(value);
}
