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
 * `timestamptz` bounds built from Minsk dates — a naked `date + interval` compared to `timestamptz` would be read in
 * the session timezone and shift the first three hours of every month.
 *
 * The data anchor bounds the report on the upper side as well. The seed ends at the anchor, but an import can write
 * orders later than `daily_stats`; without the bound those future orders would inflate an incomplete cohort and its
 * retention cells. Both the customer cohort assignment and the order rows therefore stop at the start of the day
 * after the anchor in Minsk.
 *
 * The repository returns raw aggregate rows only. Sums stay `bigint` (through `::bigint::text`, the shape `pg`
 * gives for BIGINT) and the service does the per-horizon arithmetic; that keeps the number of queries independent
 * of the number of cohorts.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>, connect?: Function }} db
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
   * @param {unknown} value
   * @returns {string}
   * @throws {ValidationError} When the data anchor is missing or malformed.
   */
  function requiredAnchor(value) {
    if (value === null || value === undefined || value === '') {
      throw new ValidationError('Не указана отчётная дата когорт');
    }
    try {
      return toDateOnly(value);
    } catch {
      throw new ValidationError('Некорректная отчётная дата когорт');
    }
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
   * expression stays index-friendly and neither the month upper bound nor the anchor can be interpreted in the
   * session timezone.
   *
   * @param {unknown[]} params `[$1 from month, $2 to month, $3 channel id, $4 anchor]`.
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
            AND c.first_order_at < ((($4::date + 1))::timestamp AT TIME ZONE 'Europe/Minsk')
       )
       ${tail}`,
      params,
    );
  }

  /**
   * Normalises the filters into the positional parameters of the cohort CTE.
   * @param {{ fromCohortMonth?: string | null, toCohortMonth: string, channelId?: string | null, anchor: string }} filters
   * @returns {unknown[]} `[$1 from month, $2 to month, $3 channel id, $4 anchor]`.
   */
  function cohortParams({ fromCohortMonth = null, toCohortMonth, channelId = null, anchor }) {
    return [
      optionalMonth(fromCohortMonth, 'начало'),
      requiredMonth(toCohortMonth),
      optionalChannelId(channelId),
      requiredAnchor(anchor),
    ];
  }

  return {
    /**
     * Number of customers in every month × channel cohort. The row count is the batch size, not one query per
     * cohort: the service joins these sizes with the monthly margins in memory.
     *
     * @param {{
     *   fromCohortMonth?: string | null, toCohortMonth: string, channelId?: string | null, anchor: string,
     * }} filters
     * @returns {Promise<Array<{
     *   cohortMonth: string, channelId: string, channelCode: string, cohortSize: number,
     * }>>}
     * @throws {ValidationError} When a bound, the anchor or the channel filter is malformed.
     */
    async listCohortSizes(filters) {
      const { rows } = await queryCohort(
        cohortParams(filters),
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
     * month are excluded with the explicit Minsk lower bound, and orders after the anchor day are excluded with the
     * explicit upper bound, so neither a negative offset nor a future one can appear.
     *
     * @param {{
     *   fromCohortMonth?: string | null, toCohortMonth: string, channelId?: string | null, anchor: string,
     * }} filters
     * @returns {Promise<Array<{
     *   cohortMonth: string, channelId: string, monthOffset: number,
     *   marginCents: bigint, activeCustomers: number,
     * }>>}
     * @throws {ValidationError} When a bound, the anchor or the channel filter is malformed.
     */
    async listCohortMonthlyMargins(filters) {
      const { rows } = await queryCohort(
        cohortParams(filters),
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
            AND o.occurred_at < ((($4::date + 1))::timestamp AT TIME ZONE 'Europe/Minsk')
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

    /**
     * Channel dimension for LTV reports. Returns every channel, active and archived, so a consumer can left-join
     * CAC rows instead of silently dropping a channel that has spend but no customers yet.
     *
     * @param {{ channelId?: string | null }} [filters]
     * @returns {Promise<Array<{ channelId: string, channelCode: string, channelName: string, isActive: boolean }>>}
     * @throws {ValidationError} When the channel filter is malformed.
     */
    async listChannels({ channelId = null } = {}) {
      const { rows } = await db.query(
        `SELECT c.id::text AS channel_id,
                c.code AS channel_code,
                c.name AS channel_name,
                c.is_active
           FROM channels c
          WHERE ($1::bigint IS NULL OR c.id = $1::bigint)
          ORDER BY c.code`,
        [optionalChannelId(channelId)],
      );

      return rows.map((row) => ({
        channelId: row.channel_id,
        channelCode: row.channel_code,
        channelName: row.channel_name,
        isActive: Boolean(row.is_active),
      }));
    },

    /**
     * Runs a multi-query read inside one repeatable-read snapshot.
     *
     * The sizes, margins and channel reads must describe the same moment. Without a snapshot an import committing
     * between them can produce a margin row for a cohort that the sizes read did not see, which would either throw
     * the consistency guard or report a channel list that disagrees with its own totals. A `REPEATABLE READ`
     * transaction removes that race; the service never has to guess.
     *
     * A `pg` Client (the integration test's scoped repository) has no `connect`; it is already inside its caller's
     * transaction, so it is used directly.
     *
     * @template T
     * @param {(repository: ReturnType<typeof createCohortsRepository>) => Promise<T>} read
     * @returns {Promise<T>}
     */
    async withSnapshot(read) {
      // A pg.Pool exposes live connection counters; a checked-out Client does not. A client is already inside its
      // caller's transaction, so it must not open (or nest) one.
      if (typeof db.totalCount !== 'number' || typeof db.connect !== 'function') {
        return read(createCohortsRepository(db));
      }

      const client = await db.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const result = await read(createCohortsRepository(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The original failure is the actionable one; a broken rollback must not mask it.
        }
        throw error;
      } finally {
        client.release();
      }
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
