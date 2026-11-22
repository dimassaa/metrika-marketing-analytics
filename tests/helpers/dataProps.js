/**
 * Reads the island model out of rendered HTML.
 *
 * EJS escapes the attribute for HTML (`&amp;`, `&#34;`, …) while the island helper escapes JSON-sensitive characters
 * as `\u003c`-style escapes. Decoding the five EJS entities restores the exact string the browser puts into
 * `dataset.props`, which is what this helper must return.
 *
 * @param {string} html Rendered page.
 * @param {string} [island] Island name from `data-island`.
 * @returns {object} Parsed screen model.
 * @throws {Error} When the mount node is missing or its props are not JSON.
 */
export function extractDataProps(html, island = 'dashboard') {
  const match = new RegExp(`data-island="${island}"[^>]*data-props="([^"]*)"`).exec(html);
  if (!match) throw new Error(`no [data-island="${island}"] with data-props in the page`);

  const json = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error(`[data-island="${island}"] data-props is not valid JSON`, { cause: error });
  }
}

/**
 * @param {string} html Rendered page.
 * @param {string} [island]
 * @returns {number} Number of mount nodes for the island.
 */
export function countIslands(html, island = 'dashboard') {
  return (html.match(new RegExp(`data-island="${island}"`, 'g')) ?? []).length;
}
