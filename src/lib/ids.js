/**
 * Shared validation for PostgreSQL `BIGINT` ids taken from routes and forms.
 *
 * `pg` returns BIGINT as a decimal string, and `$1::bigint` rejects a value above 2^63 - 1 with SQLSTATE 22003,
 * turning a hand-typed URL into a 500. Normalising through `BigInt` also makes `007` and `7` the same id, so a
 * service that compares ids does not have to know which spelling the browser sent.
 */

import { ValidationError } from './errors.js';

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

/**
 * Normalises an optional multi-channel filter for the metrics services.
 *
 * `null`/`undefined` means "every channel" and keeps the pre-filter behaviour. A present filter must contain at
 * least one valid BIGINT id: an empty list would silently widen the report to all channels, which is the opposite
 * of what the user selected. Duplicates are removed because a repeated query key is a normal way to submit a
 * multi-select, not an error.
 *
 * @param {unknown} value Array of raw ids, or null/undefined.
 * @returns {string[] | null} Unique normalised ids, or null for "all channels".
 * @throws {ValidationError} When the value is not an array, is empty, or contains an invalid id.
 */
export function normalizeChannelIds(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new ValidationError('Некорректный список каналов');
  }
  const ids = value.map((item) => parseBigIntId(item));
  if (ids.length === 0 || ids.some((id) => id === null)) {
    throw new ValidationError('Некорректный идентификатор канала');
  }
  return [...new Set(ids)];
}
