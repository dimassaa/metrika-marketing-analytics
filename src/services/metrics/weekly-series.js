import { METRICS_CONFIG } from '../../config/metrics.js';
import { addDays, formatDateRu, isoWeekStart } from '../../lib/dates.js';
import { ValidationError } from '../../lib/errors.js';
import { assertFiniteOrNull, centsToApi, roundNumber } from '../../lib/metrics-math.js';
import { centsFromDb } from '../../lib/money.js';
import { computeCac } from './cac.service.js';
import { computeRomi } from './romi.service.js';

/**
 * Weekly buckets shared by the dashboard and the channel card.
 *
 * Both screens plot the same Mon–Sun series and must not drift into different rules for which week is "the last
 * one": a chart of the dashboard and a chart of a channel would then disagree about the shape of the same period.
 * The module is pure — it receives repository rows and returns a JSON-safe view-model — so it can be unit-tested
 * without a database and neither service has to import the other.
 */

/** ROMI is stored and shown with two decimals by every metrics view-model (metrics spec §3.2). */
const ROMI_DISPLAY_DECIMALS = 2;

/**
 * Monday-to-Sunday weeks covered by the series.
 *
 * The last complete week is the week containing `to` when `to` is its Sunday; otherwise the previous one. The brief
 * states `addDays(isoWeekStart(to), -7)`, which is the same answer for every day except Sunday — there it would drop
 * a complete week, so the semantic rule ("only full weeks") decides.
 *
 * @param {string} to Inclusive reporting end as `YYYY-MM-DD`.
 * @param {number} weeks Number of buckets.
 * @returns {{ firstWeekStart: string, lastWeekStart: string }}
 * @throws {ValidationError} When `weeks` is not a positive integer.
 */
export function resolveWeekRange(to, weeks = METRICS_CONFIG.dashboard.weeks) {
  if (!Number.isInteger(weeks) || weeks < 1) {
    throw new ValidationError('Количество недель должно быть целым положительным числом');
  }

  const currentWeekStart = isoWeekStart(to);
  const lastWeekStart = addDays(currentWeekStart, 6) <= to ? currentWeekStart : addDays(currentWeekStart, -7);

  return { firstWeekStart: addDays(lastWeekStart, -7 * (weeks - 1)), lastWeekStart };
}

/**
 * Builds one bucket per complete week. A week without spend or customers inside the requested range still gets a
 * bucket with zeros: the chart needs a stable x-axis and an absent week must not shorten the period.
 *
 * Attributed revenue is filled with `0n` when the attribution series has no row for the week. Revenue rows outside
 * `[firstWeekStart, firstWeekStart + 7 * (weeks - 1)]` are ignored and never extend the axis; in particular the
 * attribution service may return the still-running week, which is not a complete bucket here.
 *
 * @param {{
 *   firstWeekStart: string,
 *   weeks: number,
 *   weeklyRows?: Array<{ weekStart: string, spendCents: bigint, newCustomers: number }>,
 *   attributedRows?: Array<{ weekStart: string, revenueCents: string }>,
 * }} input
 * @returns {Array<{
 *   weekStart: string,
 *   weekLabel: string,
 *   spendCents: string,
 *   newCustomers: number,
 *   cacCents: string | null,
 *   romiPct: number | null,
 * }>}
 * @throws {TypeError} When a repository row breaks the contract (non-bigint spend, negative count).
 */
export function buildWeeklySeries({ firstWeekStart, weeks, weeklyRows = [], attributedRows = [] }) {
  if (!Number.isInteger(weeks) || weeks < 1) {
    throw new TypeError(`weeks must be a positive integer, got ${String(weeks)}`);
  }

  /** @type {Map<string, { spendCents: bigint, newCustomers: number }>} */
  const spendByWeek = new Map(
    weeklyRows.map((row) => [row.weekStart, { spendCents: row.spendCents, newCustomers: row.newCustomers }]),
  );
  /** @type {Map<string, bigint>} */
  const revenueByWeek = new Map(
    attributedRows.map((row) => [row.weekStart, centsFromDb(row.revenueCents) ?? 0n]),
  );

  const series = [];
  for (let offset = 0; offset < weeks; offset += 1) {
    const weekStart = addDays(firstWeekStart, offset * 7);
    const row = spendByWeek.get(weekStart);
    const spendCents = row?.spendCents ?? 0n;
    const newCustomers = row?.newCustomers ?? 0;
    const revenueCents = revenueByWeek.get(weekStart) ?? 0n;

    const { cacCents } = computeCac({ spendCents, newCustomers });
    const romiPct = assertFiniteOrNull(
      roundNumber(computeRomi({ revenueCents, spendCents }), ROMI_DISPLAY_DECIMALS),
      'weekly romiPct',
    );

    series.push({
      weekStart,
      weekLabel: formatDateRu(weekStart),
      spendCents: centsToApi(spendCents),
      newCustomers,
      cacCents: centsToApi(cacCents),
      romiPct,
    });
  }

  return series;
}
