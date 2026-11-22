/**
 * Turns an object into a JSON string that is safe inside an HTML attribute.
 *
 * `JSON.stringify` alone is not enough: a string value containing `</script>` would close the script tag that
 * later reads the attribute, and a bare `<`/`>`/`&` can confuse HTML parsers. Escaping the three characters as
 * `\u003c`, `\u003e`, `\u0026` keeps the string valid JSON — `JSON.parse` restores the original characters — while
 * making it structurally impossible to break out of the attribute or the surrounding tag.
 *
 * The EJS `<%= %>` print escapes quotes for the attribute itself, so the browser's `dataset.props` returns the
 * literal JSON again.
 */

/**
 * @param {unknown} value JSON-serialisable screen model. `null` is a value; `undefined` is not.
 * @param {string} label Where the value came from; used in the error message and in the exception class name.
 * @returns {string} Escaped JSON, ready for `data-props="<%= … %>"`.
 * @throws {TypeError} When the value cannot be serialised (BigInt, cycle, `undefined` at the root). The message
 *   names the label, so a broken screen model points at the field instead of a generic JSON error.
 */
export function serializeDataProps(value, label = 'data-props') {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} cannot be serialised for an island: ${error.message}`, { cause: error });
  }
  if (json === undefined) {
    throw new TypeError(`${label} cannot be serialised for an island: JSON.stringify returned undefined`);
  }

  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/**
 * Island-aware wrapper. The island name, not a controller-local label, is what an operator sees when a prop object
 * contains a `bigint` (all money leaves the services as kopeck strings, so this is a programming error, not data).
 *
 * @param {unknown} model Screen model.
 * @param {string} islandName `dashboard`, `channels`, …
 * @returns {string} Escaped JSON for that island.
 * @throws {TypeError} See `serializeDataProps`.
 */
export function dataProps(model, islandName) {
  return serializeDataProps(model, `island "${islandName}" props`);
}
