import { startOfMonth, toDateOnly } from '../lib/dates.js';
import { ValidationError } from '../lib/errors.js';
import { parseBigIntId } from '../lib/ids.js';
import { centsFromDb } from '../lib/money.js';

/**
 * Cohort aggregates for LTV (metrics spec §2 and §5).
 *
 * A cohort is a Minsk calendar month of `customers.first_order_at`, not a UTC month: the demo company reports in
 * Europe/Minsk, and an order at 00:30 on the 1st belongs to the new month even though its UTC timestamp still says
 * the previous day. Both queries therefore derive `cohort_month` with
 * `date_trunc('month', first_order_at AT TIME ZONE 'Europe/Minsk')` and filter the customers table by explicit
 * `timestamptz` bounds built from the Minsk month start — a naked `date + interval` compared to `timestamptz` would
 * be read in the session timezone and shift the first three hours of every month.
 *
 * The repository returns raw aggregate rows only. Sums stay `bigint` (through `::bigint::text`, the shape `pg`
 * gives for BIGINT) and the service does the per-horizon arithmetic; that keeps the number of queries independent
 * of the number of cohorts.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 */
export function createCohortsRepository(db) {
  /**
   * Normalises an optional month bound to the first day of its month.
   * @param {unknown} value
   * @param {string} label Field name for the error message.
   * @returns {string | null}
   * @throws {ValidationError} When the value is not a real calendar date.
   */
  function optionalMonth(value, label) {
    if (value === null || value === undefined) return null;
    try {
      return startOfMonth(toDateOnly(value));
    } catch {
      throw new ValidationError(`Некорректный месяц когорты: ${label}`);
    }
  }

  /**
   * @param {unknown} value
   * @returns {string}
   * @throws {ValidationError} When the upper bound is missing or malformed.
   */
  function requiredMonth(value) {
    const month = optionalMonth(value, 'окончание');
    if (month === null) throw new ValidationError('Не указан последний месяц когорты');
    return month;
  }

  /**
   * @param {unknown} channelId
   * @returns {string | null}
   * @throws {ValidationError} When the filter is present but not a BIGINT id.
   */
  function optionalChannelId(channelId) {
    if (channelId === null || channelId === undefined) return null;
    const parsed = parseBigIntId(channelId);
    if (parsed === null) throw new ValidationError('Некорректный идентификатор канала');
    return parsed;
  }

  /**
   * Runs one aggregate over the cohort CTE shared by both queries. The tail is a literal defined next to its call
   * site, never user input. Filters are applied to `first_order_at` with Minsk `timestamptz` bounds, so the
   * expression stays index-friendly and the month upper bound cannot be interpreted in the session timezone.
   *
   * @param {unknown[]} params `[$1 from month, $2 to month, $3 channel id]`.
   * @param {string} tail Aggregate SELECT/CTE body appended to the cohort CTE.
   * @returns {Promise<{ rows: any[] }>}
   */
  function queryCohort(params, tail) {
    return db.query(
      `WITH cohort AS (
         SELECT c.id AS customer_id,
                c.first_channel_id,
                date_trunc('month', c.first_order_at AT TIME ZONE 'Europe/Minsk')::date AS cohort_month
           FROM customers c
          WHERE c.first_order_at IS NOT NULL
            AND ($1::date IS NULL
                 OR c.first_order_at >= (($1::date)::timestamp AT TIME ZONE 'Europe/Minsk'))
            AND c.first_order_at < ((($2::date + interval '1 month'))::timestamp AT TIME ZONE 'Europe/Minsk')
            AND ($3::bigint IS NULL OR c.first_channel_id = $3::bigint)
       )
       ${tail}`,
      params,
    );
  }

  return {
    /**
     * Number of customers in every month × channel cohort. The row count is the batch size, not one query per
     * cohort: the service joins these sizes with the monthly margins in memory.
     *
     * @param {{ fromCohortMonth?: string | null, toCohortMonth: string, channelId?: string | null }} filters
     * @returns {Promise<Array<{
     *   cohortMonth: string, channelId: string, channelCode: string, cohortSize: number,
     * }>>}
     * @throws {ValidationError} When a bound or the channel filter is malformed.
     */
    async listCohortSizes({ fromCohortMonth = null, toCohortMonth, channelId = null }) {
      const { rows } = await queryCohort(
        [optionalMonth(fromCohortMonth, 'начало'), requiredMonth(toCohortMonth), optionalChannelId(channelId)],
        `SELECT co.cohort_month::text AS cohort_month,
                co.first_channel_id::text AS channel_id,
                ch.code AS channel_code,
                count(*)::int AS cohort_size
           FROM cohort co
           JOIN channels ch ON ch.id = co.first_channel_id
          GROUP BY co.cohort_month, co.first_channel_id, ch.code
          ORDER BY co.cohort_month, ch.code`,
      );

      return rows.map((row) => ({
        cohortMonth: row.cohort_month,
        channelId: row.channel_id,
        channelCode: row.channel_code,
        cohortSize: countFromRow(row.cohort_size, 'cohort_size'),
      }));
    },

    /**
     * Margin and activity per cohort month and month offset. `monthOffset` is the number of full Minsk calendar
     * months between the cohort month and the order month; `active_customers` counts distinct customers with at
     * least one order in that month.
     *
     * Offsets are not capped here because the repository does not know the requested horizon — the service sums
     * only `monthOffset < horizonMonths`, which keeps 3/6/12-month reports on one dataset. Orders before the cohort
     * month are excluded with the explicit Minsk lower bound, so a negative offset can never appear.
     *
     * @param {{ fromCohortMonth?: string | null, toCohortMonth: string, channelId?: string | null }} filters
     * @returns {Promise<Array<{
     *   cohortMonth: string, channelId: string, monthOffset: number,
     *   marginCents: bigint, activeCustomers: number,
     * }>>}
     * @throws {ValidationError} When a bound or the channel filter is malformed.
     */
    async listCohortMonthlyMargins({ fromCohortMonth = null, toCohortMonth, channelId = null }) {
      const { rows } = await queryCohort(
        [optionalMonth(fromCohortMonth, 'начало'), requiredMonth(toCohortMonth), optionalChannelId(channelId)],
        `SELECT co.cohort_month::text AS cohort_month,
                co.first_channel_id::text AS channel_id,
                ((date_part('year', o.occurred_at AT TIME ZONE 'Europe/Minsk')
                  - date_part('year', co.cohort_month)) * 12
                 + date_part('month', o.occurred_at AT TIME ZONE 'Europe/Minsk')
                 - date_part('month', co.cohort_month))::int AS month_offset,
                count(DISTINCT o.customer_id)::int AS active_customers,
                sum(o.margin_cents)::bigint::text AS margin_cents
           FROM cohort co
           JOIN orders o ON o.customer_id = co.customer_id
          WHERE o.occurred_at >= (co.cohort_month::timestamp AT TIME ZONE 'Europe/Minsk')
          GROUP BY co.cohort_month, co.first_channel_id, month_offset
          ORDER BY co.cohort_month, co.first_channel_id, month_offset`,
      );

      return rows.map((row) => ({
        cohortMonth: row.cohort_month,
        channelId: row.channel_id,
        monthOffset: countFromRow(row.month_offset, 'month_offset'),
        marginCents: marginFromRow(row.margin_cents),
        activeCustomers: countFromRow(row.active_customers, 'active_customers'),
      }));
    },
  };
}

/**
 * @param {unknown} value `count(*)::int` result.
 * @param {string} name
 * @returns {number}
 * @throws {TypeError} When the aggregate is not a non-negative integer.
 */
function countFromRow(value, name) {
  const count = Number(value ?? 0);
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${String(value)}`);
  }
  return count;
}

/**
 * @param {unknown} value `sum(...)::bigint::text` result.
 * @returns {bigint}
 * @throws {TypeError} When the sum is NULL or not integer kopecks.
 */
function marginFromRow(value) {
  const cents = centsFromDb(value);
  if (cents === null) {
    throw new TypeError('aggregated margin_cents must not be NULL: the query groups existing orders');
  }
  return cents;
}
