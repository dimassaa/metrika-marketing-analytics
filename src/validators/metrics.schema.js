import { z } from 'zod';
import { METRICS_CONFIG } from '../config/metrics.js';
import { ValidationError } from '../lib/errors.js';
import { parseBigIntId } from '../lib/ids.js';

/**
 * Query schemas for the metrics API and pages.
 *
 * The page and the API parse with the same schema. That is deliberate: the SSR `data-props` object and the JSON
 * response must be identical, so a parameter accepted by one and rejected by the other would be a contract bug.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `days` arrives as a string from a query string. An empty value stays empty so the schema, not `Number('')`, decides
 * whether it is valid; the allowed values are the period options the UI offers, because a free-form day count would
 * let a bookmarked `days=9999` create an unplannable range.
 */
const daysField = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
  z
    .number({ error: 'Период указывается числом дней' })
    .int({ error: 'Период указывается целым числом дней' })
    .refine((value) => METRICS_CONFIG.periods.options.includes(value), {
      message: `Период может быть только ${METRICS_CONFIG.periods.options.join(', ')} дней`,
    })
    .optional(),
);

const dateField = z
  .string()
  .regex(DATE_PATTERN, 'Дата указывается в формате ГГГГ-ММ-ДД')
  .optional();

/**
 * Days and explicit bounds are mutually exclusive. `from`/`to` without `days` is allowed: the export and the
 * channel card use that form, and `resolvePeriod` fills the missing side.
 */
function hasNoPeriodConflict(value) {
  return !(value.days !== undefined && (value.from !== undefined || value.to !== undefined));
}

const PERIOD_CONFLICT = {
  message: 'Нельзя указывать days вместе с from или to',
  path: ['days'],
};

/** The base period query; other schemas extend its shape without re-declaring the rules. */
const periodShape = {
  days: daysField,
  from: dateField,
  to: dateField,
};

/**
 * Normalises the repeated/comma-separated `channelIds` form into a list of BIGINT strings.
 *
 * The raw parsing rules live only in `parseChannelIds`; this field wraps them for Zod so the page and the API keep
 * the same behaviour and the same Russian messages. An empty value is a user mistake, not "all channels": silently
 * widening the report would show numbers for channels the person did not select.
 */
const channelIdsField = z.preprocess(
  (value, ctx) => {
    if (value === undefined) return undefined;
    try {
      return parseChannelIds(value);
    } catch (error) {
      if (error instanceof ValidationError) {
        ctx.addIssue({ code: 'custom', message: error.message });
        return z.NEVER;
      }
      throw error;
    }
  },
  z.array(z.string()).optional(),
);

/**
 * @param {unknown} value Query value: an array, a comma-separated string or a single id.
 * @returns {string[] | null} Unique ids, or null when the filter is absent (all channels).
 * @throws {ValidationError} When the value is empty or contains a non-BIGINT id.
 */
export function parseChannelIds(value) {
  if (value === undefined || value === null) return null;
  const items = (Array.isArray(value) ? value : [value]).flatMap((item) => String(item).split(','));

  const ids = items.map((item) => {
    const trimmed = item.trim();
    if (trimmed === '') throw new ValidationError('Укажите хотя бы один канал');
    const id = parseBigIntId(trimmed);
    if (id === null) throw new ValidationError('Некорректный идентификатор канала');
    return id;
  });

  return [...new Set(ids)];
}

/** Period-only query, used by screens without a channel filter. */
export const periodQuerySchema = z.object(periodShape).refine(hasNoPeriodConflict, PERIOD_CONFLICT);

/** Dashboard query: a period plus the BO-13 channel filter. */
export const dashboardQuerySchema = z
  .object({ ...periodShape, channelIds: channelIdsField })
  .refine(hasNoPeriodConflict, PERIOD_CONFLICT)
  .transform((value) => ({ ...value, channelIds: value.channelIds ?? null }));
