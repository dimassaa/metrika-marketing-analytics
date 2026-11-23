/**
 * Sorting for the channel table.
 *
 * The page owns the order: `?sort=&dir=` are plain GET parameters, the server sorts the screen model, and the island
 * only renders it. Keeping the comparison here (a pure module) means the table, the sort links and the tests share
 * one definition of "cheap first" and "worst health first".
 */

/**
 * Fields a reader can order the channel table by.
 *
 * `defaultDir` encodes the useful direction of each measure: more revenue and more customers are better, while a
 * lower CAC and a worse health status are what a person looks for first. Money is compared as `BigInt(cents)`, because
 * the kopeck strings are not numbers and `'1000' < '900'` is true for text.
 */
export const CHANNEL_SORT_FIELDS = Object.freeze({
  // Place 1 is the best channel, so the useful default is ascending. Treating the place like a value and sorting it
  // descending would open the table on the worst channel.
  rank: Object.freeze({ label: 'Место', defaultDir: 'asc' }),
  score: Object.freeze({ label: 'Оценка', defaultDir: 'desc' }),
  revenue: Object.freeze({ label: 'Выручка', defaultDir: 'desc' }),
  newCustomers: Object.freeze({ label: 'Новые клиенты', defaultDir: 'desc' }),
  cac: Object.freeze({ label: 'CAC', defaultDir: 'asc' }),
  health: Object.freeze({ label: 'Статус', defaultDir: 'asc' }),
});

/** Worst first for the default ascending direction: a reader scans risk before healthy. */
const HEALTH_ORDER = Object.freeze({ risk: 0, watch: 1, healthy: 2, no_data: 3 });

/**
 * Turns a decimal kopeck string into a bigint for comparison. A missing amount stays null and is sorted last in both
 * directions; a malformed string is a contract error, not a reason to silently reorder the table.
 *
 * @param {unknown} value
 * @param {string} name Field name for the error.
 * @returns {bigint | null}
 * @throws {TypeError} When a present value is not an integer.
 */
function moneyOf(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError(`${name} must be an integer kopeck string, got ${JSON.stringify(value)}`);
}

/**
 * @param {object} row Channel row.
 * @param {keyof typeof CHANNEL_SORT_FIELDS} sort Sort field.
 * @returns {number | bigint | string | null}
 * @throws {TypeError} When the field is unknown or a money value is malformed.
 */
function sortValue(row, sort) {
  switch (sort) {
    case 'rank':
      return Number.isInteger(row.rank) ? row.rank : null;
    case 'score':
      return typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : null;
    case 'revenue':
      return moneyOf(row.revenueCents, 'revenueCents');
    case 'newCustomers':
      return Number.isInteger(row.newCustomers) && row.newCustomers >= 0 ? row.newCustomers : null;
    case 'cac':
      return moneyOf(row.cacCents, 'cacCents');
    case 'health':
      return HEALTH_ORDER[row.status] ?? null;
    default:
      throw new TypeError(`unknown channel sort field: ${String(sort)}`);
  }
}

/**
 * Returns a sorted copy; the input array is never mutated.
 *
 * `null` is always last regardless of direction: an unmeasured CAC is not the cheapest CAC. For money the direction
 * flips the numeric comparison after the null check. Equal values fall back to the channel code, so two requests with
 * the same filters cannot reshuffle rows nondeterministically.
 *
 * @param {object[]} rows Channel rows.
 * @param {{ sort?: keyof typeof CHANNEL_SORT_FIELDS, dir?: 'asc' | 'desc' }} [options]
 * @returns {object[]} New array in display order.
 * @throws {TypeError} When the sort field or direction is unknown.
 */
export function sortChannelRows(rows, { sort = 'rank', dir } = {}) {
  const field = CHANNEL_SORT_FIELDS[sort];
  if (!field) throw new TypeError(`unknown channel sort field: ${String(sort)}`);

  const direction = dir ?? field.defaultDir;
  if (direction !== 'asc' && direction !== 'desc') {
    throw new TypeError(`unknown channel sort direction: ${String(dir)}`);
  }

  return [...rows].sort((left, right) => {
    const leftValue = sortValue(left, sort);
    const rightValue = sortValue(right, sort);

    if (leftValue === null && rightValue === null) {
      return left.code.localeCompare(right.code);
    }
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;

    let comparison;
    if (typeof leftValue === 'bigint') {
      comparison = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    } else {
      comparison = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    }

    if (comparison !== 0) return direction === 'asc' ? comparison : -comparison;
    return left.code.localeCompare(right.code);
  });
}
