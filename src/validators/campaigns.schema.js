import { z } from 'zod';
import { toDateOnly } from '../lib/dates.js';
import { parseBynToCents } from '../lib/money.js';
import { ValidationError } from '../lib/errors.js';

/** Campaign status vocabulary; mirrors the CHECK constraint in `001_init.sql`. */
export const CAMPAIGN_STATUSES = Object.freeze(['active', 'paused', 'finished']);

/** Largest value a PostgreSQL BIGINT primary key can hold (2^63 - 1). */
const MAX_BIGINT_ID = 9223372036854775807n;
const ID_PATTERN = /^\d+$/;

const codeField = z
  .string({ error: 'Укажите код кампании' })
  .trim()
  .min(1, 'Укажите код кампании')
  .max(60, 'Код кампании не длиннее 60 символов')
  .regex(/^[a-z0-9_]+$/, 'Код кампании: только строчные латинские буквы, цифры и подчёркивание');

const nameField = z
  .string({ error: 'Укажите название кампании' })
  .trim()
  .min(2, 'Название кампании: минимум 2 символа')
  .max(120, 'Название кампании не длиннее 120 символов');

const statusField = z.enum(CAMPAIGN_STATUSES, 'Выберите статус: active, paused или finished');

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

const startedOnField = z
  .string({ error: 'Укажите дату старта' })
  .trim()
  .min(1, 'Укажите дату старта')
  .transform(toCalendarDate);

const endedOnField = z
  .union([z.string(), z.null()], 'Укажите дату окончания или оставьте поле пустым')
  .optional()
  .transform((value, ctx) => {
    // The quick-add form on the channel passport omits the field entirely; that is the same "no end date" as an
    // empty input, and the database stores both as NULL.
    if (value === null || value === undefined || value.trim() === '') return null;
    return toCalendarDate(value, ctx);
  });

/**
 * Parses the optional budget input into kopecks; an empty field means "budget not set" and stores NULL.
 * @param {unknown} value
 * @param {{ addIssue: (issue: { code: 'custom', message: string }) => void }} ctx
 * @returns {bigint | null | typeof z.NEVER}
 */
function toOptionalCents(value, ctx) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  try {
    return parseBynToCents(/** @type {string | number} */ (value));
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    ctx.addIssue({ code: 'custom', message: error.message });
    return z.NEVER;
  }
}

const budgetField = z
  .union([z.string(), z.number(), z.null()], 'Укажите бюджет одним значением')
  .transform(toOptionalCents)
  .optional();

/**
 * Channel id as a validated digit string. The range check keeps an oversized value away from `$1::bigint`, which
 * would answer with SQLSTATE 22003 and turn a hand-typed form into a 500.
 * @param {unknown} value
 * @param {{ addIssue: (issue: { code: 'custom', message: string }) => void }} ctx
 * @returns {string | typeof z.NEVER}
 */
function toChannelId(value, ctx) {
  const id = String(value ?? '').trim();
  if (!ID_PATTERN.test(id)) {
    ctx.addIssue({ code: 'custom', message: 'Выберите канал для кампании' });
    return z.NEVER;
  }
  const numeric = BigInt(id);
  if (numeric < 1n || numeric > MAX_BIGINT_ID) {
    ctx.addIssue({ code: 'custom', message: 'Выберите канал для кампании' });
    return z.NEVER;
  }
  return id;
}

const channelIdField = z.union([z.string(), z.number()], 'Выберите канал для кампании').transform(toChannelId);

/**
 * The date-range rule is the same for create and edit, so it lives in one refinement that both schemas reuse.
 * @param {{ startedOn: string, endedOn: string | null }} data
 * @returns {boolean}
 */
function hasValidDateRange(data) {
  return !data.endedOn || data.endedOn >= data.startedOn;
}

const DATE_RANGE_MESSAGE = 'Дата окончания не может быть раньше даты старта';

/** `POST /app/campaigns` — the code is the campaign identity inside imports and is not editable later. */
export const campaignCreateSchema = z
  .object({
    channelId: channelIdField,
    code: codeField,
    name: nameField,
    status: statusField,
    startedOn: startedOnField,
    endedOn: endedOnField,
    budgetByn: budgetField,
    from: z.string().optional(),
  })
  .refine(hasValidDateRange, { message: DATE_RANGE_MESSAGE, path: ['endedOn'] })
  .transform((data) => ({
    channelId: data.channelId,
    code: data.code,
    name: data.name,
    status: data.status,
    startedOn: data.startedOn,
    endedOn: data.endedOn,
    budgetCents: data.budgetByn ?? null,
    from: data.from === 'channel' ? 'channel' : null,
  }));

/** `POST /app/campaigns/:id` — name, status, dates and budget; the channel stays because history hangs on it. */
export const campaignUpdateSchema = z
  .object({
    name: nameField,
    status: statusField,
    startedOn: startedOnField,
    endedOn: endedOnField,
    budgetByn: budgetField,
  })
  .refine(hasValidDateRange, { message: DATE_RANGE_MESSAGE, path: ['endedOn'] })
  .transform((data) => ({
    name: data.name,
    status: data.status,
    startedOn: data.startedOn,
    endedOn: data.endedOn,
    budgetCents: data.budgetByn ?? null,
  }));

/**
 * Digits alone are not enough for a filter: an oversized value would reach `$1::bigint` and fail there. Values that
 * cannot be a real id are treated as "no filter", which is also what a stale bookmark deserves.
 * @param {string} value
 * @returns {string | null}
 */
function toFilterId(value) {
  if (!ID_PATTERN.test(value)) return null;
  const numeric = BigInt(value);
  return numeric >= 1n && numeric <= MAX_BIGINT_ID ? value : null;
}

/**
 * Query-string filters. Unknown values fall back to "all" instead of erroring: a stale bookmark should show the full
 * list, not a 400 page.
 */
export const campaignFiltersSchema = z.object({
  channelId: z
    .string()
    .catch('all')
    .default('all')
    .transform((value) => toFilterId(value) ?? 'all'),
  status: z.enum(['all', ...CAMPAIGN_STATUSES]).catch('all'),
  q: z
    .string()
    .trim()
    .max(80)
    .catch('')
    .default(''),
  edit: z
    .unknown()
    .optional()
    .transform((value) => (typeof value === 'string' ? toFilterId(value) : null)),
});

/**
 * Keeps a rejected form usable: only strings of a sane length reach the template, and selects always carry a valid
 * option. EJS still escapes every value.
 * @param {Record<string, unknown> | undefined} body
 * @returns {{ channelId: string, code: string, name: string, status: string, startedOn: string, endedOn: string, budgetByn: string, channelName: string }}
 */
export function campaignFormValues(body) {
  const text = (value) => (typeof value === 'string' ? value.slice(0, 120) : '');
  const status = text(body?.status);
  return {
    channelId: text(body?.channelId),
    code: text(body?.code),
    name: text(body?.name),
    status: CAMPAIGN_STATUSES.includes(status) ? status : 'active',
    startedOn: text(body?.startedOn),
    endedOn: text(body?.endedOn),
    budgetByn: text(body?.budgetByn),
    // The channel name is never sent by the form; the edit header simply omits it on a rejected submit.
    channelName: '',
  };
}
