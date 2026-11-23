import { METRICS_CONFIG } from '../config/metrics.js';
import { addDays, toDateOnly } from './dates.js';
import { ValidationError } from './errors.js';

/**
 * Reporting window fixed by metrics spec §0.1: 30 calendar days counted back from the data anchor.
 * The value comes from `METRICS_CONFIG` so the service default and the UI period options cannot disagree.
 */
export const DEFAULT_PERIOD_DAYS = METRICS_CONFIG.periods.defaultDays;

const DAY_MS = 86_400_000;

/**
 * Validates a calendar date and turns a malformed value into the same 400 every metrics screen expects, instead of
 * leaking the `TypeError`/`RangeError` of the date helper.
 * @param {unknown} value
 * @param {string} label
 * @returns {string} `YYYY-MM-DD`.
 * @throws {ValidationError} When the value is not a real calendar date.
 */
function requireDate(value, label) {
  try {
    return toDateOnly(value);
  } catch {
    throw new ValidationError(`Некорректная дата периода: ${label}`);
  }
}

/**
 * Inclusive number of calendar days between two `YYYY-MM-DD` values. Arithmetic runs on UTC date parts, so neither
 * the machine's timezone nor a DST change can make a 30-day period 29 or 31 days long.
 *
 * Exported for the screen models that receive a service period without a `days` field; they must not re-implement the
 * arithmetic and disagree with `resolvePeriod` by a day.
 *
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
export function inclusiveDays(from, to) {
  const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
  const [toYear, toMonth, toDay] = to.split('-').map(Number);
  const milliseconds = Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay);
  return Math.round(milliseconds / DAY_MS) + 1;
}

/**
 * The single period resolver for the metrics engine and the CSV export (metrics spec §0.1).
 *
 * The data anchor, not the system clock, is "today". `days` counts inclusively, so the default 30-day window on an
 * anchor of 2026-11-22 starts on 2026-10-24. An explicit `to` is respected — a user asking for October gets October
 * — but never beyond the anchor, because there is no data after it and a future end date would silently inflate the
 * period label. An explicit `from` without `to` runs through the anchor, preserving the M2 export behaviour.
 *
 * @param {{
 *   anchor: string | null | undefined,
 *   from?: string | null,
 *   to?: string | null,
 *   days?: number,
 * }} input
 * @returns {{ from: string, to: string, days: number }} Inclusive bounds and their real calendar length.
 * @throws {ValidationError} When the anchor is missing, a date is malformed, `days` is not positive or `from > to`.
 */
export function resolvePeriod({ anchor, from = null, to = null, days = DEFAULT_PERIOD_DAYS } = {}) {
  if (typeof anchor !== 'string' || anchor === '') {
    throw new ValidationError('Не удалось определить отчётную дату');
  }
  if (!Number.isInteger(days) || days < 1) {
    throw new ValidationError('Период должен содержать целое положительное число дней');
  }

  const anchorDate = requireDate(anchor, 'отчётная дата');
  const explicitTo = to === null || to === undefined ? null : requireDate(to, 'окончание');
  const explicitFrom = from === null || from === undefined ? null : requireDate(from, 'начало');

  const resolvedTo = explicitTo !== null && explicitTo < anchorDate ? explicitTo : anchorDate;
  const resolvedFrom = explicitFrom ?? addDays(resolvedTo, -(days - 1));

  if (resolvedFrom > resolvedTo) {
    throw new ValidationError('Начало периода не может быть позже окончания');
  }

  return { from: resolvedFrom, to: resolvedTo, days: inclusiveDays(resolvedFrom, resolvedTo) };
}
