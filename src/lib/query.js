/**
 * Query-string helpers for the server-rendered GET controls.
 *
 * Every filter and period control on a metrics page is a plain GET form or link: the server owns the state, the URL
 * is the single source of truth, and no JavaScript is needed to change a filter. Building those URLs by hand in
 * every template is how one control silently drops a neighbouring parameter; this module merges the current query
 * with a patch and keeps arrays as repeated keys, which is exactly how `<select multiple>` submits.
 */

/**
 * Merges `patch` into `current` and serialises the result as a query string (without the leading `?`).
 *
 * - Arrays become repeated parameters (`channelIds=1&channelIds=2`) so a multi-select survives a round trip.
 * - `null`, `undefined` and `''` remove the key; a patch therefore doubles as "reset this filter".
 * - Existing keys keep their position, so a stable URL stays stable; new keys are appended in patch order.
 * - Values are percent-encoded with `encodeURIComponent`, because channel names and search terms are Cyrillic.
 *
 * @param {Record<string, unknown>} [current] Parsed or raw query object.
 * @param {Record<string, unknown>} [patch] Keys to override, add or remove.
 * @returns {string} `days=90&channelIds=1&channelIds=2&sort=cac`, or an empty string when nothing remains.
 */
export function buildQueryString(current = {}, patch = {}) {
  /** @type {Map<string, string[]>} */
  const merged = new Map();

  /**
   * @param {string} key
   * @param {unknown} value
   */
  function put(key, value) {
    if (value === null || value === undefined || value === '') {
      merged.delete(key);
      return;
    }

    if (Array.isArray(value)) {
      const items = value
        .filter((item) => item !== null && item !== undefined && item !== '')
        .map((item) => String(item));
      if (items.length === 0) merged.delete(key);
      else merged.set(key, items);
      return;
    }

    merged.set(key, [String(value)]);
  }

  for (const [key, value] of Object.entries(current)) put(key, value);
  for (const [key, value] of Object.entries(patch)) put(key, value);

  const parts = [];
  for (const [key, values] of merged) {
    for (const value of values) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }

  return parts.join('&');
}
