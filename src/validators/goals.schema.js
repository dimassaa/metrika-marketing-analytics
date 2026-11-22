import { z } from 'zod';
import { toDateOnly } from '../lib/dates.js';
import { ValidationError } from '../lib/errors.js';
import { parseBynToCents } from '../lib/money.js';

/**
 * Goal metrics. The list mirrors the CHECK constraint in `001_init.sql`; a value outside it never reaches SQL.
 *
 * `target_value` is the one documented mixed-unit exception to the "money in kopecks" rule (see the M2 plan and
 * `IMPROVEMENTS.md`): BYN for `cac`, percent for `romi`, a ratio for `ltv_cac`, months for `payback` and an integer
 * count for `new_customers`. The column stays `NUMERIC(14,2)`; every unit is normalized to a two-decimal string
 * before storage so the database representation is predictable and M3 can parse it per metric.
 */
export const GOAL_METRICS = Object.freeze(['cac', 'romi', 'ltv_cac', 'payback', 'new_customers']);

/** Largest value `NUMERIC(14,2)` can hold, expressed in hundredths: 999 999 999 999.99. */
const MAX_TARGET_HUNDREDTHS = 99_999_999_999_999n;

/** Metric-specific planning bounds, in hundredths, so a typo cannot overflow the column or store a meaningless plan. */
const METRIC_BOUNDS = Object.freeze({
  cac: MAX_TARGET_HUNDREDTHS,
  romi: 1_000_000n, // 10 000 %
  ltv_cac: 100_000n, // 1 000
  payback: 60_000n, // 600 months
  new_customers: 100_000_000_000n, // 1 000 000 000 customers
});

const METRIC_MESSAGES = Object.freeze({
  cac: 'Плановое значение CAC слишком велико',
  romi: 'Плановое значение ROMI: число от 0 до 10 000, не более двух знаков после запятой',
  ltv_cac: 'Плановое значение LTV:CAC: число от 0 до 1 000, не более двух знаков после запятой',
  payback: 'Плановый payback: число месяцев от 0 до 600, не более двух знаков после запятой',
  new_customers: 'Плановое число новых клиентов: целое число не меньше 0',
});

/** Largest value a PostgreSQL BIGINT primary key can hold (2^63 - 1). */
const MAX_BIGINT_ID = 9223372036854775807n;
const ID_PATTERN = /^\d+$/;

/**
 * Validates a `YYYY-MM-DD` calendar date without letting a JS `Date` attach the machine's timezone.
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

const periodStartField = z
  .string({ error: 'Укажите начало периода' })
  .trim()
  .min(1, 'Укажите начало периода')
  .transform(toCalendarDate);

const periodEndField = z
  .string({ error: 'Укажите окончание периода' })
  .trim()
  .min(1, 'Укажите окончание периода')
  .transform(toCalendarDate);

const metricField = z.enum(GOAL_METRICS, 'Выберите метрику цели');

/**
 * Channel scope: an empty field, `null` or the literal `global` means a company-wide goal. Anything else must be a
 * digit string inside the BIGINT range, otherwise `$1::bigint` would turn a hand-typed form into a 500.
 * @param {unknown} value
 * @param {{ addIssue: (issue: { code: 'custom', message: string }) => void }} ctx
 * @returns {string | null | typeof z.NEVER}
 */
function toChannelScope(value, ctx) {
  if (value === null || value === undefined) return null;
  const id = String(value).trim();
  if (id === '' || id === 'global') return null;
  if (!ID_PATTERN.test(id)) {
    ctx.addIssue({ code: 'custom', message: 'Выберите канал цели или оставьте поле пустым' });
    return z.NEVER;
  }
  const numeric = BigInt(id);
  if (numeric < 1n || numeric > MAX_BIGINT_ID) {
    ctx.addIssue({ code: 'custom', message: 'Выберите канал цели или оставьте поле пустым' });
    return z.NEVER;
  }
  return id;
}

const channelField = z
  .union([z.string(), z.number(), z.null()], 'Выберите канал цели или оставьте поле пустым')
  .transform(toChannelScope)
  .optional();

/**
 * Splits a user-entered decimal into hundredths without floating point. Accepts comma and dot, and one or two
 * decimal places; grouping spaces are ignored the same way `parseBynToCents` ignores them.
 * @param {unknown} value
 * @param {{ addIssue: (issue: { code: 'custom', message: string }) => void }} ctx
 * @param {string} message Russian reason shown on the form.
 * @returns {bigint | typeof z.NEVER} Value in hundredths.
 */
function toHundredths(value, ctx, message) {
  if (value === null || value === undefined) {
    ctx.addIssue({ code: 'custom', message });
    return z.NEVER;
  }
  const normalized = String(value).trim().replace(/[\s\u00a0]/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    ctx.addIssue({ code: 'custom', message });
    return z.NEVER;
  }
  const [whole, fraction = ''] = normalized.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
}

/**
 * @param {bigint} hundredths
 * @returns {string} Canonical decimal string with exactly two decimal places, e.g. `42.50`.
 */
function decimalFromHundredths(hundredths) {
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}

/**
 * Validates the planned value against the unit of its metric and returns the decimal string stored in
 * `goals.target_value`. CAC is parsed through `parseBynToCents` (the same money parser as every other BYN field),
 * so no float ever touches the rouble amount.
 * @param {string} metric
 * @param {unknown} value
 * @param {{ addIssue: (issue: { code: 'custom', message: string }) => void }} ctx
 * @returns {string | typeof z.NEVER}
 */
function toTargetDecimal(metric, value, ctx) {
  const bound = METRIC_BOUNDS[metric] ?? MAX_TARGET_HUNDREDTHS;

  if (metric === 'new_customers') {
    const normalized = String(value ?? '').trim().replace(/[\s\u00a0]/g, '');
    if (!/^\d+$/.test(normalized)) {
      ctx.addIssue({ code: 'custom', message: METRIC_MESSAGES.new_customers });
      return z.NEVER;
    }
    const hundredths = BigInt(normalized) * 100n;
    if (hundredths > bound) {
      ctx.addIssue({ code: 'custom', message: METRIC_MESSAGES.new_customers });
      return z.NEVER;
    }
    return decimalFromHundredths(hundredths);
  }

  if (metric === 'cac') {
    let cents;
    try {
      cents = parseBynToCents(/** @type {string | number} */ (value));
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      ctx.addIssue({ code: 'custom', message: error.message });
      return z.NEVER;
    }
    if (cents > bound) {
      ctx.addIssue({ code: 'custom', message: METRIC_MESSAGES.cac });
      return z.NEVER;
    }
    return decimalFromHundredths(cents);
  }

  const hundredths = toHundredths(value, ctx, METRIC_MESSAGES[metric]);
  if (typeof hundredths !== 'bigint') return z.NEVER;
  if (hundredths > bound) {
    ctx.addIssue({ code: 'custom', message: METRIC_MESSAGES[metric] });
    return z.NEVER;
  }
  return decimalFromHundredths(hundredths);
}

const targetField = z.union([z.string(), z.number()], 'Укажите плановое значение');

/**
 * `POST /app/goals` — metric and channel are chosen once; the service checks the period against existing goals.
 */
export const goalCreateSchema = z
  .object({
    metric: metricField,
    channelId: channelField,
    targetValue: targetField,
    periodStart: periodStartField,
    periodEnd: periodEndField,
  })
  .refine((data) => data.periodEnd >= data.periodStart, {
    message: 'Дата окончания не может быть раньше даты старта',
    path: ['periodEnd'],
  })
  .transform((data, ctx) => ({
    metric: data.metric,
    channelId: data.channelId ?? null,
    targetValue: toTargetDecimal(data.metric, data.targetValue, ctx),
    periodStart: data.periodStart,
    periodEnd: data.periodEnd,
  }));

/**
 * `POST /app/goals/:id` — only the planned value and the period are editable. The metric is immutable, so the
 * stored value has to come from the service; this helper applies the same unit and date rules as creation.
 * @param {string} metric Stored metric of the edited goal.
 * @param {Record<string, unknown>} input Raw request body.
 * @returns {import('zod').ZodSafeParseResult<{ targetValue: string, periodStart: string, periodEnd: string }>}
 */
export function parseGoalUpdate(metric, input) {
  return z
    .object({
      targetValue: targetField,
      periodStart: periodStartField,
      periodEnd: periodEndField,
    })
    .refine((data) => data.periodEnd >= data.periodStart, {
      message: 'Дата окончания не может быть раньше даты старта',
      path: ['periodEnd'],
    })
    .transform((data, ctx) => ({
      targetValue: toTargetDecimal(metric, data.targetValue, ctx),
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
    }))
    .safeParse(input);
}

/**
 * Query-string filters. Unknown values fall back to `all` instead of erroring: a stale bookmarked URL should show
 * the full list, not a 400 page.
 */
export const goalFiltersSchema = z.object({
  channelId: z
    .string()
    .catch('all')
    .default('all')
    .transform((value) => {
      if (!ID_PATTERN.test(value)) return 'all';
      const numeric = BigInt(value);
      return numeric >= 1n && numeric <= MAX_BIGINT_ID ? value : 'all';
    }),
  metric: z.enum(['all', ...GOAL_METRICS]).catch('all'),
  edit: z
    .unknown()
    .optional()
    .transform((value) => {
      if (typeof value !== 'string' || !ID_PATTERN.test(value)) return null;
      const numeric = BigInt(value);
      return numeric >= 1n && numeric <= MAX_BIGINT_ID ? value : null;
    }),
});

/**
 * Keeps a rejected form usable: only strings of a sane length reach the template, and the metric select always has
 * a valid option. EJS still escapes every value.
 * @param {Record<string, unknown> | undefined} body
 * @returns {{ metric: string, channelId: string, targetValue: string, periodStart: string, periodEnd: string }}
 */
export function goalFormValues(body) {
  const text = (value) => (typeof value === 'string' ? value.slice(0, 100) : '');
  const metric = text(body?.metric);
  return {
    metric: GOAL_METRICS.includes(metric) ? metric : 'cac',
    channelId: text(body?.channelId),
    targetValue: text(body?.targetValue),
    periodStart: text(body?.periodStart),
    periodEnd: text(body?.periodEnd),
  };
}
