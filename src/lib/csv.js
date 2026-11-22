import { ValidationError } from './errors.js';

/** Separator fixed by the metrics spec §8: Excel in the Belarusian locale writes `;`, not `,`. */
export const DEFAULT_CSV_DELIMITER = ';';

/** Data-row limit fixed by the spec. The header is not counted. */
export const MAX_CSV_ROWS = 10_000;

/**
 * Formats a row limit for a Russian message. `toLocaleString` would use a non-breaking space in some ICU builds,
 * which makes the message impossible to assert on, so the thousands separator is inserted explicitly.
 * @param {number} value
 * @returns {string}
 */
function formatRowLimit(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * Splits one physical line into cells, honouring quoted fields.
 *
 * Excel writes a quoted field only when the value contains the separator, a quote or surrounding spaces; a doubled
 * `""` inside quotes is a literal quote. Multi-line fields are out of scope per the metrics spec, so a line must end
 * with every quote closed — anything else is unreadable CSV, not a value to guess at.
 *
 * @param {string} line Line without the trailing `\n`/`\r`.
 * @param {string} delimiter Field separator.
 * @param {number} lineNumber 1-based physical line for the error message.
 * @returns {string[]} Raw cell values with quotes removed.
 * @throws {ValidationError} On an unclosed quoted field.
 */
function splitLine(line, delimiter, lineNumber) {
  const cells = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell === '') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += char;
  }

  if (inQuotes) {
    throw new ValidationError(`Не удалось разобрать CSV: незакрытая кавычка в строке ${lineNumber}`);
  }
  cells.push(cell);
  return cells;
}

/**
 * Parses a CSV upload into a header list and numbered data rows.
 *
 * The parser is deliberately strict about the things that would silently corrupt analytics: it strips the UTF-8 BOM
 * Excel adds, removes `\r` so a Windows-saved file does not put `\r` into the last column, and refuses a file above
 * the row limit before any database work starts. It is deliberately lenient about the rest: blank lines are skipped
 * (they are formatting, not data) and extra columns are returned to the caller as plain data.
 *
 * @param {Buffer | string} input Raw upload or a string body.
 * @param {{ delimiter?: string, maxRows?: number }} [options]
 * @returns {{
 *   headers: string[],
 *   rows: Array<{ rowNumber: number, values: Record<string, string>, cellCount: number }>,
 * }} `rowNumber` is the physical 1-based line in the file, so the first data row is 2 (or higher after blank lines)
 *   and always matches what the person sees in a spreadsheet.
 * @throws {ValidationError} On an unreadable quote or more data rows than `maxRows`.
 */
export function parseCsv(input, { delimiter = DEFAULT_CSV_DELIMITER, maxRows = MAX_CSV_ROWS } = {}) {
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) {
    throw new TypeError('parseCsv expects a Buffer or a string');
  }

  let text = typeof input === 'string' ? input : input.toString('utf8');
  if (text.startsWith('\uFEFF')) text = text.slice(1);

  // Excel on Windows terminates every line with CRLF. Removing CR up front keeps the last column clean; the spec
  // explicitly allows it, and there is no multi-line field, so a bare CR inside a value would be data corruption.
  text = text.replace(/\r/g, '');

  const lines = text.split('\n');
  let headers = null;
  const rows = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (line.trim() === '') continue;

    const cells = splitLine(line, delimiter, lineNumber);

    if (headers === null) {
      headers = cells.map((cell) => cell.trim());
      // A spreadsheet often leaves a closing separator on the header line (`a;b;`). Those cells are padding, not
      // columns: keeping them would require an empty value in every data row.
      while (headers.length > 0 && headers[headers.length - 1] === '') headers.pop();
      continue;
    }

    if (rows.length >= maxRows) {
      throw new ValidationError(`Превышен лимит ${formatRowLimit(maxRows)} строк`);
    }

    const values = {};
    headers.forEach((header, columnIndex) => {
      if (header === '') return;
      values[header] = cells[columnIndex] ?? '';
    });
    rows.push({ rowNumber: lineNumber, values, cellCount: cells.length });
  }

  return { headers: headers ?? [], rows };
}

/**
 * Characters that make a spreadsheet treat a cell as a formula instead of text (CSV Formula Injection).
 * A leading apostrophe is the documented Excel/LibreOffice escape: the cell keeps its literal text and is never evaluated.
 */
const FORMULA_PREFIXES = Object.freeze(['=', '+', '-', '@', '\t', '\r']);

/** A genuine negative number must stay numeric; only text that merely starts with `-` is neutralised. */
const NEGATIVE_NUMBER = /^-\d+(?:[.,]\d+)?$/;

/**
 * @param {unknown} value
 * @returns {boolean} True when the cell would be interpreted as a formula.
 */
function isFormulaLike(value) {
  if (typeof value === 'number' || typeof value === 'bigint') return false;
  const text = String(value);
  if (NEGATIVE_NUMBER.test(text)) return false;
  return FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * @param {unknown} value
 * @param {string} delimiter
 * @returns {string} Cell ready to be written between separators.
 */
function escapeCell(value, delimiter) {
  const raw = value === null || value === undefined ? '' : String(value);
  // Formula injection is neutralised before quoting so the apostrophe ends up inside the quoted field.
  const text = isFormulaLike(value) ? `'${raw}` : raw;
  if (text.includes(delimiter) || text.includes('"') || text.includes('\n') || text.includes('\r')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Serialises a table into the same CSV dialect the importer reads, so a downloaded template can be uploaded back
 * unedited.
 *
 * Every text cell starting with `=`, `+`, `-`, `@`, TAB or CR is prefixed with an apostrophe, so a hostile channel
 * name such as `=1+1` opens as text instead of running as a formula. Real numbers, including negative ones, are
 * left numeric.
 *
 * @param {string[]} headers Column order and names.
 * @param {Array<Array<unknown> | Record<string, unknown>>} rows Cells in header order, or objects keyed by header.
 * @param {{ delimiter?: string, withBom?: boolean }} [options] The BOM makes Excel open Cyrillic headers as UTF-8.
 * @returns {string} CSV text with CRLF line endings.
 */
export function stringifyCsv(headers, rows, { delimiter = DEFAULT_CSV_DELIMITER, withBom = true } = {}) {
  const lines = [headers.map((header) => escapeCell(header, delimiter)).join(delimiter)];

  for (const row of rows) {
    const cells = Array.isArray(row) ? row : headers.map((header) => row?.[header]);
    lines.push(cells.map((cell) => escapeCell(cell, delimiter)).join(delimiter));
  }

  return `${withBom ? '\uFEFF' : ''}${lines.join('\r\n')}\r\n`;
}
