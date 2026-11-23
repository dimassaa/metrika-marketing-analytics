import { z } from 'zod';
import { METRICS_CONFIG } from '../config/metrics.js';
import { toDateOnly } from '../lib/dates.js';
import { ValidationError } from '../lib/errors.js';
import { parseBigIntId } from '../lib/ids.js';
import { parseBynToCents } from '../lib/money.js';

/**
 * Zod contracts for saved scenarios.
 *
 * Two different jobs live here:
 * - request schemas (`scenarioSaveSchema`, `scenarioQuerySchema`) validate what a browser sends;
 * - stored schemas (`storedScenarioParamsSchema`, `storedScenarioResultSchema`) validate a JSONB snapshot on read, so
 *   a tampered or future-version row becomes `invalid: true` instead of a 500 or a silent recomputation.
 *
 * Stored schemas are `strict()` at every level: an unknown key means the snapshot was written by a different version
 * or edited by hand, and ignoring it would hide the drift. Cents are decimal strings because JavaScript numbers cannot
 * hold every BIGINT kopeck exactly; `NUMERIC` values that are not money (K, S, R², ROMI) stay numbers.
 */

const ID_PATTERN = /^\d+$/;
const CENTS_PATTERN = /^\d+$/;

/**
 * Validates a `YYYY-MM-DD` calendar date without attaching the machine's timezone.
 * @param {unknown} value
 * @param {{ addIssue: (issue: { code: 'custom', message: string }) => void }} ctx
 * @returns {string | typeof z.NEVER}
 */
function toCalendarDate(value, ctx) {
  try {
    return toDateOnly(/** @type {string} */ (value));
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Укажите дату в формате ГГГГ-ММ-ДД' });
    return z.NEVER;
  }
}

const dateField = z.string({ error: 'Укажите дату' }).trim().min(1, 'Укажите дату').transform(toCalendarDate);

const centsField = z.string().regex(CENTS_PATTERN, 'Сумма должна быть целым числом копеек');
const nullableCentsField = centsField.nullable();
const idField = z.string().regex(ID_PATTERN, 'Идентификатор должен быть числом');
const nonNegativeNumber = z.number().finite().min(0);
const positiveNumber = z.number().finite().positive();
const nullablePositiveNumber = positiveNumber.nullable();
const nullableFiniteNumber = z.number().finite().nullable();

/** Optimizer snapshot: exactly the tunables that produced the fit. A new key requires `schemaVersion: 2`. */
const optimizerField = z
  .object({
    historyWeeks: z.number().int().positive(),
    gridSteps: z.number().int().min(2),
    minPositiveWeeks: z.number().int().positive(),
    r2WarnBelow: z.number().finite(),
    kMinFactor: positiveNumber,
    kMaxFactor: positiveNumber,
    sMinFactor: positiveNumber,
    sMaxFactor: positiveNumber,
  })
  .strict();

/** `params` column of `scenarios`: how to reproduce the snapshot, not the snapshot itself. */
export const storedScenarioParamsSchema = z
  .object({
    schemaVersion: z.literal(1),
    anchor: dateField,
    history: z.object({ from: dateField, to: dateField, weeks: z.number().int().positive() }).strict(),
    budgetCents: centsField,
    channelIds: z.array(idField),
    optimizer: optimizerField,
    budgetPeriod: z.literal('week'),
  })
  .strict();

const observedPointSchema = z
  .object({
    spendCents: centsField,
    customers: nonNegativeNumber,
  })
  .strict();

const sideSchema = z
  .object({
    spendCents: centsField,
    customers: nonNegativeNumber,
  })
  .strict();

const forecastSchema = z
  .object({
    customers: nonNegativeNumber,
    revenue12Cents: nullableCentsField,
    cacCents: nullableCentsField,
    romi12: nullableFiniteNumber,
  })
  .strict();

const scenarioChannelSchema = z
  .object({
    channelId: idField,
    // Names are part of the snapshot: a saved detail must not re-read the live dimension to label its own rows.
    channelCode: z.string(),
    channelName: z.string(),
    model: z.enum(['saturation', 'linear', 'no_data']),
    K: nullablePositiveNumber,
    S: nullablePositiveNumber,
    r2: nullableFiniteNumber,
    observed: z.array(observedPointSchema),
    current: sideSchema,
    // Linear/no_data channels stay visible but have no allocation and therefore no forecast.
    planned: sideSchema.nullable(),
    forecast: forecastSchema.nullable(),
    note: z.string().nullable(),
  })
  .strict();

/** `result` column of `scenarios`: the frozen calculation the detail page renders. */
export const storedScenarioResultSchema = z
  .object({
    channels: z.array(scenarioChannelSchema),
    totals: z
      .object({
        current: sideSchema,
        planned: sideSchema,
        forecast: forecastSchema,
      })
      .strict(),
    warnings: z.array(z.string()),
  })
  .strict();

/**
 * Normalises the multi-select input. A plain HTML form sends a single string, a repeated field arrives as an array,
 * a hand-written URL may use a comma-separated list, and "all channels" is represented by an empty value or no field
 * at all.
 * @param {unknown} value
 * @param {{ addIssue: (issue: { code: 'custom', message: string }) => void }} ctx
 * @returns {string[] | null | typeof z.NEVER}
 */
function toChannelIdList(value, ctx) {
  if (value === null || value === undefined) return null;
  const raw = Array.isArray(value) ? value : [value];
  const compact = raw
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (compact.length === 0) return null;

  const ids = [];
  for (const item of compact) {
    const id = parseBigIntId(item);
    if (id === null) {
      ctx.addIssue({ code: 'custom', message: 'Некорректный идентификатор канала' });
      return z.NEVER;
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

const channelIdListField = z
  .union([z.array(z.union([z.string(), z.number()])), z.string(), z.number(), z.null()])
  .optional()
  .transform(toChannelIdList);

/**
 * Optional single-channel selector for the saturation-curve chart. `null` means "pick the problem channel".
 * @param {unknown} value
 * @param {{ addIssue: (issue: { code: 'custom', message: string }) => void }} ctx
 * @returns {string | null | typeof z.NEVER}
 */
function toOptionalId(value, ctx) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === '') return null;
  const id = parseBigIntId(text);
  if (id === null) {
    ctx.addIssue({ code: 'custom', message: 'Некорректный идентификатор канала' });
    return z.NEVER;
  }
  return id;
}

const optionalIdField = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform(toOptionalId);

const pageField = z.coerce.number().int().min(1, 'Страница должна быть положительным числом').default(1);

/**
 * Validates an optional BYN budget at the request boundary.
 *
 * The service parses the amount again because it is also called directly by tests; validating here turns a malformed
 * browser value into a 400 with a field-level message instead of a service exception that only the central handler
 * can label. The prefix names the currency so the person knows which input is wrong; `0` and the cap are checked by
 * the service, which needs the current weekly baseline.
 *
 * @param {unknown} value
 * @param {{ addIssue: (issue: { code: 'custom', message: string }) => void }} ctx
 * @returns {void}
 */
function checkBudget(value, ctx) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' && value.trim() === '') return;
  try {
    parseBynToCents(/** @type {string | number} */ (value));
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    ctx.addIssue({ code: 'custom', message: `Бюджет в BYN: ${error.message}` });
  }
}

const budgetField = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .superRefine(checkBudget);

/**
 * `POST /app/scenarios` body. The server recomputes the result, so `result` is not part of the schema.
 *
 * Request schemas are not `strict()`: a form always carries `_csrf` and may carry an unrelated field, and rejecting
 * those would turn a harmless extra input into a 400. Unknown keys are stripped by Zod before the controller sees
 * them; stored JSONB snapshots, in contrast, are strict because there an unknown key means real schema drift.
 */
export const scenarioSaveSchema = z.object({
  name: z
    .string({ error: 'Укажите название сценария' })
    .trim()
    .min(3, 'Название сценария: минимум 3 символа')
    .max(120, 'Название сценария не длиннее 120 символов'),
  // An empty budget means "the current weekly budget"; the service resolves it from the snapshot baseline.
  budgetByn: budgetField,
  channelIds: channelIdListField,
  anchor: dateField.optional(),
});

/** `GET /app/scenarios` query: budget, channel selection, curve channel and the list page. */
export const scenarioQuerySchema = z.object({
  budgetByn: budgetField,
  channelIds: channelIdListField,
  curveChannelId: optionalIdField,
  page: pageField,
});

/** `GET /app/scenarios/:id` has no user-controlled query beyond the list page. */
export const scenarioDetailQuerySchema = z.object({ page: pageField });

/**
 * Convenience export for tests and callers that want the same optimizer snapshot the service stores.
 * @returns {typeof METRICS_CONFIG.saturation} A plain, JSON-safe copy of the frozen config subtree.
 */
export function optimizerSnapshot() {
  return { ...METRICS_CONFIG.saturation };
}
