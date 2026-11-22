import { z } from 'zod';
import { toDateOnly } from '../lib/dates.js';
import { ValidationError } from '../lib/errors.js';
import { CHANNEL_KINDS } from './channels.schema.js';
import { CAMPAIGN_STATUSES } from './campaigns.schema.js';

/** Datasets the download route accepts. The set is closed: anything else is a 400, not an empty file. */
export const EXPORT_DATASETS = Object.freeze(['channels', 'campaigns', 'daily_stats', 'orders']);

/** Largest value a PostgreSQL BIGINT primary key can hold (2^63 - 1). */
const MAX_BIGINT_ID = 9223372036854775807n;
const ID_PATTERN = /^\d+$/;

/**
 * A filter id is either `all`, an absent value or a valid BIGINT id. Stale bookmarks and hand-edited URLs fall back
 * to "no filter" instead of reaching `$1::bigint` and failing there.
 * @param {string} value
 * @returns {string | null}
 */
function toFilterId(value) {
  if (value === 'all' || value === '') return null;
  if (!ID_PATTERN.test(value)) return null;
  const numeric = BigInt(value);
  return numeric >= 1n && numeric <= MAX_BIGINT_ID ? value : null;
}

const idFilter = z.string().catch('all').default('all').transform(toFilterId);

/**
 * Calendar date filter. A malformed or impossible date is a 400: silently dropping it would export a different
 * period than the one the caller asked for.
 */
const dateFilter = z
  .string()
  .trim()
  .optional()
  .catch(undefined)
  .transform((value, ctx) => {
    if (value === undefined || value === '') return null;
    try {
      return toDateOnly(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Укажите дату в формате ГГГГ-ММ-ДД' });
      return z.NEVER;
    }
  });

const PERIOD_MESSAGE = 'Начало периода не может быть позже окончания';

/** The date-range rule is shared by the two time-series datasets. */
const withPeriodCheck = (schema) =>
  schema.refine((data) => !data.from || !data.to || data.from <= data.to, {
    message: PERIOD_MESSAGE,
    path: ['from'],
  });

const channelsFilters = z.object({
  status: z.enum(['all', 'active', 'archived']).catch('all'),
  kind: z.enum(['all', ...CHANNEL_KINDS]).catch('all'),
});

const campaignsFilters = z.object({
  channelId: idFilter,
  status: z.enum(['all', ...CAMPAIGN_STATUSES]).catch('all'),
  q: z
    .string()
    .trim()
    .max(80)
    .catch('')
    .default('')
    .transform((value) => (value === '' ? null : value)),
});

const dailyStatsFilters = withPeriodCheck(
  z.object({
    channelId: idFilter,
    campaignId: idFilter,
    from: dateFilter,
    to: dateFilter,
  }),
);

const ordersFilters = withPeriodCheck(
  z.object({
    channelId: idFilter,
    from: dateFilter,
    to: dateFilter,
  }),
);

const FILTER_SCHEMAS = Object.freeze({
  channels: channelsFilters,
  campaigns: campaignsFilters,
  daily_stats: dailyStatsFilters,
  orders: ordersFilters,
});

/**
 * Validates the dataset and the query-string filters once, so the service never sees an unknown dataset or an
 * impossible period.
 *
 * @param {unknown} dataset Raw `:dataset` route param.
 * @param {Record<string, unknown>} query Express query object.
 * @returns {{
 *   dataset: 'channels' | 'campaigns' | 'daily_stats' | 'orders',
 *   filters: Record<string, string | null>,
 * }}
 * @throws {ValidationError} On an unknown dataset, a malformed date or a reversed period.
 */
export function parseExportRequest(dataset, query) {
  if (!EXPORT_DATASETS.includes(dataset)) {
    throw new ValidationError('Неизвестный набор данных для экспорта');
  }

  const parsed = FILTER_SCHEMAS[dataset].safeParse(query ?? {});
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? 'Некорректные фильтры экспорта');
  }

  return { dataset, filters: parsed.data };
}
