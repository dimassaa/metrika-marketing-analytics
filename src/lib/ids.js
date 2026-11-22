/**
 * Shared validation for PostgreSQL `BIGINT` ids taken from routes and forms.
 *
 * `pg` returns BIGINT as a decimal string, and `$1::bigint` rejects a value above 2^63 - 1 with SQLSTATE 22003,
 * turning a hand-typed URL into a 500. Normalising through `BigInt` also makes `007` and `7` the same id, so a
 * service that compares ids does not have to know which spelling the browser sent.
 */

/** Largest value a PostgreSQL BIGINT primary key can hold (2^63 - 1). */
export const MAX_BIGINT_ID = 9223372036854775807n;

/**
 * @param {unknown} value Raw id from a route param, form field or query string.
 * @returns {string | null} Normalized decimal string inside the BIGINT range, or null for non-digits, zero and
 *   oversized values.
 */
export function parseBigIntId(value) {
  const id = String(value ?? '');
  if (!/^\d+$/.test(id)) return null;
  const numeric = BigInt(id);
  return numeric >= 1n && numeric <= MAX_BIGINT_ID ? numeric.toString() : null;
}
