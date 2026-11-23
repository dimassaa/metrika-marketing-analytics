import { z } from 'zod';
import { METRICS_CONFIG } from '../config/metrics.js';
import { ValidationError } from '../lib/errors.js';
import { parseBigIntId } from '../lib/ids.js';
import { CHANNEL_SORT_FIELDS } from '../lib/sort-rows.js';

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

/**
 * Cohort horizon. The API and the page share the same allowed set, so a bookmarked `horizon=7` cannot silently
 * render a matrix whose completeness rule nobody designed (the spec has 3/6/12-month LTV horizons only).
 */
const horizonField = z.preprocess(
  (value) => {
    if (value === undefined) return METRICS_CONFIG.ltv.defaultHorizon;
    if (typeof value === 'string' && value.trim() !== '') return Number(value);
    return value;
  },
  z
    .number({ error: 'Горизонт указывается числом месяцев' })
    .int({ error: 'Горизонт указывается целым числом месяцев' })
    .refine((value) => METRICS_CONFIG.ltv.horizons.includes(value), {
      message: `Горизонт может быть только ${METRICS_CONFIG.ltv.horizons.join(', ')} месяцев`,
    }),
);

/** Cohort month bound accepts `YYYY-MM` or the service's own `YYYY-MM-01` spelling. */
const cohortMonthField = z
  .string({ error: 'Месяц когорты указывается в формате ГГГГ-ММ' })
  .regex(/^\d{4}-\d{2}(-01)?$/, 'Месяц когорты указывается в формате ГГГГ-ММ')
  .optional();

/** The cohorts screen has a monthly horizon, not a day window: `days` is deliberately absent from this schema. */
export const cohortsQuerySchema = z
  .object({
    horizon: horizonField,
    channelId: z
      .string({ error: 'Некорректный идентификатор канала' })
      .regex(/^\d+$/, 'Некорректный идентификатор канала')
      .optional(),
    fromCohortMonth: cohortMonthField,
    toCohortMonth: cohortMonthField,
  })
  .transform((value) => ({ ...value, channelId: value.channelId ?? null }));

/** Dashboard query: a period plus the BO-13 channel filter. */
export const dashboardQuerySchema = z
  .object({ ...periodShape, channelIds: channelIdsField })
  .refine(hasNoPeriodConflict, PERIOD_CONFLICT)
  .transform((value) => ({ ...value, channelIds: value.channelIds ?? null }));

/**
 * Query keys of the four ranking weights and their criterion codes. The form uses the `w*` spelling in the URL; the
 * ranking service uses the criterion codes.
 */
const WEIGHT_PARAMS = Object.freeze({
  wCac: 'cac',
  wRomi: 'romi',
  wLtvCac: 'ltvCac',
  wNewCustomers: 'newCustomers',
});

const WEIGHT_LABELS = Object.freeze({
  wCac: 'CAC',
  wRomi: 'ROMI',
  wLtvCac: 'LTV:CAC',
  wNewCustomers: 'новые клиенты',
});

/** Four optional string fields: the schema validates the combination in one transform. */
const weightShape = Object.freeze(
  Object.fromEntries(
    Object.keys(WEIGHT_PARAMS).map((name) => [
      name,
      z.string({ error: `Вес ${WEIGHT_LABELS[name]} указывается одним числом` }).optional(),
    ]),
  ),
);

/**
 * @param {Record<string, unknown>} params Query object.
 * @returns {boolean} True when at least one `w*` parameter is present.
 */
export function hasWeightParams(params) {
  return Object.keys(WEIGHT_PARAMS).some((name) => params?.[name] !== undefined);
}

/**
 * Turns the four percentage GET parameters into ranking weights.
 *
 * All four or none: a partial set is a person editing half of a bookmark, and silently mixing old defaults with one
 * new value would score a model nobody asked for. Percentages need not sum to 100 — the ranking normalises them, and
 * `0/100/0/0` is a legitimate "score by ROMI only" experiment — but a zero total is rejected before any division.
 *
 * @param {Record<string, unknown>} [params] Query object with `wCac`, `wRomi`, `wLtvCac`, `wNewCustomers`.
 * @returns {{ cac: number, romi: number, ltvCac: number, newCustomers: number }} Weights as fractions.
 * @throws {ValidationError} On a partial set, a non-numeric value, a value outside 0–100 or a zero total.
 */
export function parseWeightParams(params = {}) {
  const present = Object.keys(WEIGHT_PARAMS).filter((name) => params?.[name] !== undefined);
  if (present.length === 0) return { ...METRICS_CONFIG.ranking.weights };
  if (present.length !== 4) {
    throw new ValidationError('Укажите все четыре веса рейтинга или ни одного');
  }

  const raw = {};
  for (const [name, criterion] of Object.entries(WEIGHT_PARAMS)) {
    const value = params[name];
    if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) {
      throw new ValidationError(`Вес ${WEIGHT_LABELS[name]} должен быть числом от 0 до 100`);
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
      throw new ValidationError(`Вес ${WEIGHT_LABELS[name]} должен быть числом от 0 до 100`);
    }
    raw[criterion] = numeric;
  }

  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) {
    throw new ValidationError('Сумма весов рейтинга должна быть больше нуля');
  }

  return Object.fromEntries(Object.entries(raw).map(([criterion, value]) => [criterion, value / 100]));
}

/**
 * Adds the parsed weights to a validated query object.
 * @param {Record<string, unknown>} value
 * @param {{ addIssue: (issue: { code: 'custom', message: string }) => void }} ctx
 * @returns {Record<string, unknown>}
 */
function withWeights(value, ctx) {
  try {
    return { ...value, weights: parseWeightParams(value), weightsCustom: hasWeightParams(value) };
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    ctx.addIssue({ code: 'custom', message: error.message });
    return z.NEVER;
  }
}

const statusField = z.enum(['all', 'active', 'archived'], 'Статус канала: all, active или archived').default('all');
const statusLenientField = z
  .enum(['all', 'active', 'archived'])
  .catch('all')
  .default('all');
const kindField = z.enum(['all', 'paid', 'owned', 'earned'], 'Тип канала: all, paid, owned или earned').default('all');
const kindLenientField = z
  .enum(['all', 'paid', 'owned', 'earned'])
  .catch('all')
  .default('all');

const sortField = z
  .enum(Object.keys(CHANNEL_SORT_FIELDS), 'Неизвестное поле сортировки каналов')
  .optional();
const dirField = z.enum(['asc', 'desc'], 'Направление сортировки: asc или desc').optional();

/**
 * Applies the default period-independent sort and its default direction.
 * @param {Record<string, any>} value
 * @returns {Record<string, any>}
 */
function settleSort(value) {
  const sort = value.sort ?? 'rank';
  return { ...value, sort, dir: value.dir ?? CHANNEL_SORT_FIELDS[sort].defaultDir };
}

/**
 * Strict channel query for `/api/v1/channels`: an unknown status/kind is a 400, because an API client asking for a
 * filter must not receive a silently wider report.
 */
export const channelsQuerySchema = z
  .object({ ...periodShape, status: statusField, kind: kindField, sort: sortField, dir: dirField, ...weightShape })
  .refine(hasNoPeriodConflict, PERIOD_CONFLICT)
  .transform(settleSort)
  .transform(withWeights);

/**
 * Tolerant channel query for `/app/channels`: stale bookmarks with `status=bogus` show «все» with a 200, while an
 * invalid sort or weight set stays a 400 because the table order would otherwise not match what the caller sees.
 */
export const channelsPageQuerySchema = z
  .object({
    ...periodShape,
    status: statusLenientField,
    kind: kindLenientField,
    sort: sortField,
    dir: dirField,
    ...weightShape,
  })
  .refine(hasNoPeriodConflict, PERIOD_CONFLICT)
  .transform(settleSort)
  .transform(withWeights);

/** Raw M3 ranking report: period plus weights, no table filters or sort. */
export const rankingQuerySchema = z
  .object({ ...periodShape, ...weightShape })
  .refine(hasNoPeriodConflict, PERIOD_CONFLICT)
  .transform(withWeights);
