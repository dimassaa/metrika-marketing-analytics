import { z } from 'zod';
import { parseBynToCents } from '../lib/money.js';
import { ValidationError } from '../lib/errors.js';

/** Schema mirrors the CHECK constraints in `001_init.sql`; values the database would reject never reach SQL. */
export const CHANNEL_KINDS = Object.freeze(['paid', 'owned', 'earned']);
const MAX_ROMI = 10_000;

const codeField = z
  .string({ error: 'Укажите код канала' })
  .trim()
  .min(1, 'Укажите код канала')
  .max(40, 'Код канала не длиннее 40 символов')
  .regex(/^[a-z0-9_]+$/, 'Код: только строчные латинские буквы, цифры и подчёркивание');

const nameField = z
  .string({ error: 'Укажите название канала' })
  .trim()
  .min(2, 'Название канала: минимум 2 символа')
  .max(100, 'Название канала не длиннее 100 символов');

const kindField = z.enum(CHANNEL_KINDS, 'Выберите тип канала: paid, owned или earned');

/**
 * Turns the optional CAC input into kopecks, or null when the field is empty.
 *
 * The transform reports the Russian message from `parseBynToCents` as a Zod issue instead of throwing, so the
 * controller keeps a single `safeParse` failure path for every field.
 * @param {unknown} value
 * @param {{ addIssue: (issue: { code: 'custom', message: string }) => void }} ctx Zod transform context.
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

/**
 * Parses the target ROMI percentage. A target is a non-negative planning value, so a minus sign is rejected here
 * rather than stored and later compared with a formula result.
 * @param {unknown} value
 * @param {{ addIssue: (issue: { code: 'custom', message: string }) => void }} ctx
 * @returns {number | null | typeof z.NEVER}
 */
function toOptionalPercent(value, ctx) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;

  const normalized = String(value).trim().replace(',', '.');
  const message = 'Целевой ROMI: число от 0 до 10 000, не более двух знаков после запятой';
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    ctx.addIssue({ code: 'custom', message });
    return z.NEVER;
  }
  const numeric = Number(normalized);
  if (numeric > MAX_ROMI) {
    ctx.addIssue({ code: 'custom', message: 'Целевой ROMI не больше 10 000%' });
    return z.NEVER;
  }
  return numeric;
}

const optionalAmountField = z
  .union([z.string(), z.number(), z.null()], 'Укажите сумму одним значением')
  .transform(toOptionalCents)
  .optional();

const optionalPercentField = z
  .union([z.string(), z.number(), z.null()], 'Укажите процент одним значением')
  .transform(toOptionalPercent)
  .optional();

/**
 * Maps form field names to the service vocabulary. An absent optional field arrives as `undefined`; the service
 * stores NULL, so it is normalised here once instead of every caller handling two "empty" spellings.
 * @param {{ targetCacByn?: bigint | null, targetRomiPct?: number | null }} data
 * @returns {{ targetCacCents: bigint | null, targetRomiPct: number | null }}
 */
function toServiceTargets({ targetCacByn, targetRomiPct }) {
  return { targetCacCents: targetCacByn ?? null, targetRomiPct: targetRomiPct ?? null };
}

/** `POST /app/channels` — the code is part of the channel identity and is not editable later. */
export const channelCreateSchema = z
  .object({
    code: codeField,
    name: nameField,
    kind: kindField,
    targetCacByn: optionalAmountField,
    targetRomiPct: optionalPercentField,
  })
  .transform((data) => ({ code: data.code, name: data.name, kind: data.kind, ...toServiceTargets(data) }));

/** `POST /app/channels/:id` — name, kind and targets; the code stays because existing imports reference it. */
export const channelUpdateSchema = z
  .object({
    name: nameField,
    kind: kindField,
    targetCacByn: optionalAmountField,
    targetRomiPct: optionalPercentField,
  })
  .transform((data) => ({ name: data.name, kind: data.kind, ...toServiceTargets(data) }));

/**
 * Keeps a rejected form usable: only strings of a sane length reach the template, and the kind select always has a
 * valid option. Values are still escaped by EJS; this only prevents arrays and megabyte strings from being echoed.
 * @param {Record<string, unknown> | undefined} body
 * @returns {{ code: string, name: string, kind: string, targetCacByn: string, targetRomiPct: string }}
 */
export function channelFormValues(body) {
  const text = (value) => (typeof value === 'string' ? value.slice(0, 100) : '');
  const kind = text(body?.kind);
  return {
    code: text(body?.code),
    name: text(body?.name),
    kind: CHANNEL_KINDS.includes(kind) ? kind : 'paid',
    targetCacByn: text(body?.targetCacByn),
    targetRomiPct: text(body?.targetRomiPct),
  };
}
