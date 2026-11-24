import { z } from 'zod';
import { toDateOnly } from '../lib/dates.js';
import { ValidationError } from '../lib/errors.js';
import { parseBynToCents } from '../lib/money.js';
import { parseCsv } from '../lib/csv.js';

/**
 * Import kinds in the order they belong on screen. The list is closed because every kind maps to its own required
 * columns and its own dedupe rule; a typo must fail before the database sees the file.
 */
export const IMPORT_KINDS = Object.freeze(['daily_stats', 'customers', 'touchpoints', 'orders']);

/** Russian names shown on the import screen, in the report and in the audit journal. */
export const IMPORT_KIND_LABELS = Object.freeze({
  daily_stats: 'Статистика кампаний',
  customers: 'Клиенты',
  touchpoints: 'Касания',
  orders: 'Заказы',
});

/**
 * Required columns per kind, exactly as fixed in the metrics spec §8. Column order in the header is free; presence
 * is not. `campaign_code` is required even for `customers`, `touchpoints` and `orders`, where its value may be empty,
 * because hiding a column would make a typo in its name look like "no campaign".
 */
export const IMPORT_COLUMNS = Object.freeze({
  daily_stats: Object.freeze(['campaign_code', 'stat_date', 'impressions', 'clicks', 'leads', 'spend']),
  customers: Object.freeze(['external_id', 'first_channel_code', 'first_campaign_code', 'first_order_at']),
  touchpoints: Object.freeze(['customer_external_id', 'channel_code', 'campaign_code', 'occurred_at', 'kind']),
  orders: Object.freeze(['external_id', 'customer_external_id', 'campaign_code', 'occurred_at', 'revenue', 'margin']),
});

/** Touchpoint kinds accepted by the `touchpoints.kind` CHECK constraint. */
export const TOUCHPOINT_KINDS = Object.freeze(['click', 'impression', 'visit']);

/** PostgreSQL `INTEGER` upper bound for impressions, clicks and leads. */
const MAX_INTEGER = 2_147_483_647;

/** PostgreSQL `BIGINT` upper bound for money in kopecks. */
const MAX_BIGINT = 9_223_372_036_854_775_807n;

/**
 * ISO-8601 with an explicit offset: `2026-11-05T10:00:00+03:00`, `2026-11-05T10:00Z`, with optional seconds.
 * A timestamp without a zone is rejected instead of being interpreted in the server's local time.
 */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Builds a row-level validation error that remembers the offending column, so `parseImportFile` can report
 * `{ row, field, message }` without a second switch over the kind.
 * @param {string} field Column name.
 * @param {string} message Russian reason shown in the batch report.
 * @returns {ValidationError}
 */
function fieldError(field, message) {
  const error = new ValidationError(message);
  // A plain enumerable property: the API error handler only reads statusCode/code/message, this is internal detail.
  error.field = field;
  return error;
}

/**
 * @param {Record<string, string>} values
 * @param {string} field
 * @param {string} message
 * @returns {string} Trimmed non-empty value.
 * @throws {ValidationError}
 */
function requiredText(values, field, message) {
  const text = String(values[field] ?? '').trim();
  if (text === '') throw fieldError(field, message);
  return text;
}

/**
 * @param {Record<string, string>} values
 * @param {string} field
 * @returns {string} Trimmed value, or an empty string.
 */
function optionalText(values, field) {
  return String(values[field] ?? '').trim();
}

/**
 * @param {Record<string, string>} values
 * @param {string} field
 * @returns {bigint} Amount in kopecks.
 * @throws {ValidationError} With the money parser's specific reason, tagged with the column.
 */
function moneyCents(values, field) {
  let cents;
  try {
    cents = parseBynToCents(values[field] ?? '');
  } catch (error) {
    if (error instanceof ValidationError) throw fieldError(field, error.message);
    throw error;
  }
  // An ox-sized amount is still a valid decimal, but not a valid BIGINT: report it as a row error instead of
  // letting the INSERT fail with SQLSTATE 22003 and turn the whole file into a 500.
  if (cents > MAX_BIGINT) throw fieldError(field, 'Сумма слишком велика');
  return cents;
}

/**
 * @param {Record<string, string>} values
 * @param {string} field
 * @returns {number} Non-negative integer inside the PostgreSQL INTEGER range.
 * @throws {ValidationError}
 */
function counter(values, field) {
  const raw = String(values[field] ?? '').replace(/[\s\u00a0]/g, '');
  if (!/^\d+$/.test(raw)) throw fieldError(field, 'Укажите целое число не меньше 0');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_INTEGER) throw fieldError(field, 'Число слишком велико');
  return value;
}

/**
 * @param {Record<string, string>} values
 * @param {string} field
 * @returns {string} `YYYY-MM-DD` calendar date.
 * @throws {ValidationError} On a missing or impossible date such as `2026-02-30`.
 */
function calendarDate(values, field) {
  const raw = requiredText(values, field, 'Укажите дату в формате ГГГГ-ММ-ДД');
  try {
    return toDateOnly(raw);
  } catch {
    throw fieldError(field, 'Укажите дату в формате ГГГГ-ММ-ДД');
  }
}

/**
 * @param {Record<string, string>} values
 * @param {string} field
 * @param {{ required: boolean }} options
 * @returns {string | null} UTC instant as an ISO string with `Z`, or null for an empty optional field.
 * @throws {ValidationError} When the offset is missing or the value is not a real instant.
 */
function timestamp(values, field, { required }) {
  const raw = required
    ? requiredText(values, field, 'Укажите дату и время события')
    : optionalText(values, field);
  if (raw === '') return null;

  const message =
    'Укажите существующую дату и время в формате ISO с часовым поясом, например 2026-11-05T10:00:00+03:00';
  if (!ISO_WITH_OFFSET.test(raw)) throw fieldError(field, message);

  // `new Date('2026-02-30T10:00:00Z')` silently rolls over to 2 March. The calendar prefix is checked with the
  // shared Minsk-safe helper first, so an impossible day is a row error rather than a guessed instant.
  try {
    toDateOnly(raw.slice(0, 10));
  } catch {
    throw fieldError(field, message);
  }

  const instant = new Date(raw);
  if (Number.isNaN(instant.getTime())) throw fieldError(field, message);
  return instant.toISOString();
}

/**
 * Validates and normalises one data row. No database access: the result is what the service later resolves against
 * `channels`, `campaigns` and `customers`.
 *
 * @param {string} kind One of `IMPORT_KINDS`.
 * @param {Record<string, string>} values Raw cells keyed by header.
 * @returns {Record<string, unknown>} Typed row; money stays a `bigint` of kopecks, instants are UTC strings.
 * @throws {ValidationError} Tagged with the offending column in `error.field`.
 */
export function validateImportRow(kind, values) {
  switch (kind) {
    case 'daily_stats':
      return {
        campaignCode: requiredText(values, 'campaign_code', 'Укажите код кампании'),
        statDate: calendarDate(values, 'stat_date'),
        impressions: counter(values, 'impressions'),
        clicks: counter(values, 'clicks'),
        leads: counter(values, 'leads'),
        spendCents: moneyCents(values, 'spend'),
      };
    case 'customers':
      return {
        externalId: requiredText(values, 'external_id', 'Укажите идентификатор клиента'),
        firstChannelCode: requiredText(values, 'first_channel_code', 'Укажите код канала привлечения'),
        firstCampaignCode: optionalText(values, 'first_campaign_code') || null,
        firstOrderAt: timestamp(values, 'first_order_at', { required: false }),
      };
    case 'touchpoints': {
      const touchpointKind = requiredText(values, 'kind', 'Укажите тип касания');
      if (!TOUCHPOINT_KINDS.includes(touchpointKind)) {
        throw fieldError('kind', 'Тип касания: click, impression или visit');
      }
      return {
        customerExternalId: requiredText(values, 'customer_external_id', 'Укажите идентификатор клиента'),
        channelCode: requiredText(values, 'channel_code', 'Укажите код канала'),
        campaignCode: optionalText(values, 'campaign_code') || null,
        occurredAt: timestamp(values, 'occurred_at', { required: true }),
        kind: touchpointKind,
      };
    }
    case 'orders': {
      const revenueCents = moneyCents(values, 'revenue');
      const marginCents = moneyCents(values, 'margin');
      if (marginCents > revenueCents) throw fieldError('margin', 'Маржа не может превышать выручку');
      return {
        externalId: requiredText(values, 'external_id', 'Укажите идентификатор заказа'),
        customerExternalId: requiredText(values, 'customer_external_id', 'Укажите идентификатор клиента'),
        campaignCode: optionalText(values, 'campaign_code') || null,
        occurredAt: timestamp(values, 'occurred_at', { required: true }),
        revenueCents,
        marginCents,
      };
    }
    default:
      throw new ValidationError('Неизвестный тип импорта');
  }
}

/**
 * Parses a whole upload: file-level checks first, then every row.
 *
 * A missing required column, an empty file or unreadable CSV rejects the file with `ValidationError` (HTTP 400).
 * Row-level problems are collected; the caller still decides whether the batch is allowed to commit, because the
 * 10 % rule needs the whole file.
 *
 * @param {string} kind
 * @param {Buffer | string} input
 * @returns {{
 *   rowsTotal: number,
 *   warnings: string[],
 *   rows: Array<{ rowNumber: number, data: Record<string, unknown> }>,
 *   errors: Array<{ row: number, field: string | null, message: string }>,
 * }}
 * @throws {ValidationError} On an unknown kind, an empty file, a missing required column or unreadable CSV.
 */
export function parseImportFile(kind, input) {
  const requiredColumns = IMPORT_COLUMNS[kind];
  if (!requiredColumns) throw new ValidationError('Неизвестный тип импорта');

  const { headers, rows } = parseCsv(input);
  if (headers.length === 0) throw new ValidationError('Файл пуст');

  const missing = requiredColumns.filter((column) => !headers.includes(column));
  if (missing.length > 0) {
    throw new ValidationError(`В файле нет обязательных колонок: ${missing.join(', ')}`);
  }

  const warnings = headers
    .filter((header) => header !== '' && !requiredColumns.includes(header))
    .map((header) => `Лишняя колонка «${header}» проигнорирована`);

  const validRows = [];
  const errors = [];

  for (const row of rows) {
    // Fewer cells than headers means at least one required value is missing. Extra trailing cells are tolerated:
    // Excel sometimes leaves a closing separator, and the required-column check already guarantees the mapping.
    if (row.cellCount < headers.length) {
      errors.push({
        row: row.rowNumber,
        field: null,
        message: `Неверное число колонок: ожидается ${headers.length}`,
      });
      continue;
    }

    try {
      validRows.push({ rowNumber: row.rowNumber, data: validateImportRow(kind, row.values) });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      errors.push({ row: row.rowNumber, field: error.field ?? null, message: error.message });
    }
  }

  return { rowsTotal: rows.length, warnings, rows: validRows, errors };
}

/**
 * MIME types that a browser or an office suite reports for a CSV attachment.
 *
 * Windows Chrome sends `application/vnd.ms-excel` for `.csv`; Firefox and Chromium on Linux send `text/csv`. The
 * list stays closed: the upload is parsed as UTF-8 CSV, so an image or an XLSX is rejected before the parser turns
 * its bytes into confusing column errors.
 */
const CSV_UPLOAD_MIME_TYPES = Object.freeze([
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
]);

/**
 * Checks the uploaded file's extension and declared type before the buffer is parsed.
 *
 * The declared MIME comes from the client and can be spoofed; it is not a security boundary. The extension and the
 * content check (the CSV parser rejects binary garbage) are what keep a wrong file from producing a misleading
 * "missing columns" report. Together they satisfy the design spec's MIME/extension requirement.
 *
 * @param {{ originalname?: unknown, mimetype?: unknown }} file Multer file object.
 * @throws {ValidationError} When the name does not end in `.csv` or the type is not a CSV type.
 */
export function assertCsvUploadFile(file) {
  const filename = String(file?.originalname ?? '').toLowerCase();
  const mimeType = String(file?.mimetype ?? '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (!filename.endsWith('.csv') || !CSV_UPLOAD_MIME_TYPES.includes(mimeType)) {
    throw new ValidationError('Допустим только файл CSV с расширением .csv');
  }
}

/**
 * Shape of the multipart upload fields. `multer` gives every field as a string; the checkbox may arrive as `on`
 * from a native form or `true` from the island's `FormData`, so both spellings mean dry-run.
 */
export const importUploadSchema = z.object({
  kind: z.enum(IMPORT_KINDS, 'Неизвестный тип импорта'),
  dryRun: z.preprocess((value) => value === true || value === 'true' || value === 'on' || value === '1', z.boolean()),
});
