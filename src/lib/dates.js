/**
 * Calendar helpers pinned to Europe/Minsk (the demo company's reporting timezone).
 *
 * Two value types are used on purpose and never mixed silently:
 * - an **instant** is a JS `Date` (a point in time, stored as `timestamptz` in UTC);
 * - a **calendar date** is a plain `YYYY-MM-DD` string, because a calendar day has no timezone and `Date`
 *   would attach the machine's local zone to it. Repositories compare/return the same strings
 *   (`stat_date::text`), which keeps the tests independent from the process timezone.
 *
 * Europe/Minsk is permanently UTC+3 with no DST since 2011, but the offset is derived through `Intl` instead
 * of being hardcoded so the helpers stay correct if the zone rules ever change.
 */

const MINSK_TIME_ZONE = 'Europe/Minsk';
const DAY_MS = 86_400_000;

const minskFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: MINSK_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {number} value
 * @returns {string} Two-digit zero-padded number.
 */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * Splits a `YYYY-MM-DD` string into numbers and rejects impossible calendar dates.
 * @param {string} dateOnly
 * @returns {{ year: number, month: number, day: number }}
 * @throws {TypeError} When the value is not a `YYYY-MM-DD` string.
 * @throws {RangeError} When the value is syntactically valid but not a real date, e.g. `2026-02-30`.
 */
function parseDateOnly(dateOnly) {
  if (typeof dateOnly !== 'string' || !DATE_ONLY_PATTERN.test(dateOnly)) {
    throw new TypeError(`expected a YYYY-MM-DD calendar date, got ${JSON.stringify(dateOnly)}`);
  }
  const year = Number(dateOnly.slice(0, 4));
  const month = Number(dateOnly.slice(5, 7));
  const day = Number(dateOnly.slice(8, 10));
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RangeError(`not a calendar date: ${dateOnly}`);
  }
  return { year, month, day };
}

/**
 * Formats the UTC parts of a `Date` built by `Date.UTC`, so no local timezone can shift the day.
 * @param {Date} date
 * @returns {string} `YYYY-MM-DD`.
 */
function formatUtcDate(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * Offset of Europe/Minsk from UTC in milliseconds at the given instant.
 * @param {Date} instant
 * @returns {number} Offset in milliseconds (positive east of Greenwich).
 */
function minskOffsetMs(instant) {
  const instantMs = instant.getTime();
  const parts = minskFormatter.formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  const wallClockMs = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
  // formatToParts drops milliseconds, so compare against the instant truncated to whole seconds.
  return wallClockMs - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Converts any instant or calendar value into the Europe/Minsk calendar date it falls on.
 * A `YYYY-MM-DD` input is returned unchanged, which makes the function idempotent for callers that already
 * normalised their dates.
 * @param {Date | string | number} [date] Instant (Date or epoch ms) or calendar date string; defaults to now.
 * @returns {string} `YYYY-MM-DD` in Europe/Minsk.
 */
export function toDateOnly(date = new Date()) {
  if (typeof date === 'string' && DATE_ONLY_PATTERN.test(date)) {
    parseDateOnly(date);
    return date;
  }
  const instant = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError(`invalid date: ${String(date)}`);
  }
  const values = Object.fromEntries(
    minskFormatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * Today's calendar date in Europe/Minsk.
 * @param {Date} [now] Injectable clock, used by tests.
 * @returns {string} `YYYY-MM-DD`.
 */
export function minskToday(now = new Date()) {
  return toDateOnly(now);
}

/**
 * Yesterday's calendar date in Europe/Minsk: the last day the demo seed fills with data.
 * @param {Date} [now] Injectable clock, used by tests.
 * @returns {string} `YYYY-MM-DD`.
 */
export function minskYesterday(now = new Date()) {
  return addDays(minskToday(now), -1);
}

/**
 * Adds a number of calendar days. Arithmetic runs in UTC on date parts only, so a DST change or the machine's
 * local zone can never move the result to a neighbouring day.
 * @param {string} date `YYYY-MM-DD` calendar date.
 * @param {number} days Signed number of days.
 * @returns {string} `YYYY-MM-DD`.
 */
export function addDays(date, days) {
  const { year, month, day } = parseDateOnly(date);
  return formatUtcDate(new Date(Date.UTC(year, month - 1, day + days)));
}

/**
 * First day of the calendar month containing `date`.
 * @param {string} date `YYYY-MM-DD`.
 * @returns {string} `YYYY-MM-01`.
 */
export function startOfMonth(date) {
  const { year, month } = parseDateOnly(date);
  return `${year}-${pad2(month)}-01`;
}

/**
 * Monday of the ISO week containing `date`. Weeks start on Monday and the whole week stays inside the
 * calendar year for bucketing, which is what the weekly charts and CAC alert windows use.
 * @param {string} date `YYYY-MM-DD`.
 * @returns {string} `YYYY-MM-DD` of the Monday.
 */
export function isoWeekStart(date) {
  const { year, month, day } = parseDateOnly(date);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const daysSinceMonday = (utc.getUTCDay() + 6) % 7;
  return formatUtcDate(new Date(Date.UTC(year, month - 1, day - daysSinceMonday)));
}

/**
 * Russian numeric date, e.g. `20.11.2026` — the format shown next to «Данные по».
 * @param {string | Date} date Calendar date or instant.
 * @returns {string} `DD.MM.YYYY` in Europe/Minsk.
 */
export function formatDateRu(date) {
  const [year, month, day] = toDateOnly(date).split('-');
  return `${day}.${month}.${year}`;
}

/**
 * First instant of the given Minsk calendar day.
 *
 * The offset is looked up twice: once at the naive UTC guess and once at the corrected instant. Europe/Minsk
 * has no midnight transition, so the second lookup only confirms the result; the pattern stays correct for
 * zones that do.
 * @param {string} date `YYYY-MM-DD`.
 * @returns {Date} Instant of 00:00:00.000 in Europe/Minsk.
 */
export function minskDayStart(date) {
  const { year, month, day } = parseDateOnly(date);
  const naiveUtcMs = Date.UTC(year, month - 1, day);
  const guessedMs = naiveUtcMs - minskOffsetMs(new Date(naiveUtcMs));
  return new Date(naiveUtcMs - minskOffsetMs(new Date(guessedMs)));
}

/**
 * Last instant of the given Minsk calendar day (23:59:59.999), the inclusive upper bound for seeded events.
 * @param {string} date `YYYY-MM-DD`.
 * @returns {Date}
 */
export function minskDayEnd(date) {
  return new Date(minskDayStart(date).getTime() + DAY_MS - 1);
}
