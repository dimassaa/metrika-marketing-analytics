import { addDays, minskDayEnd, minskDayStart } from '../lib/dates.js';
import { METRICS_CONFIG } from '../config/metrics.js';
import { centsFromDb } from '../lib/money.js';

/**
 * Orders and touchpoints for revenue attribution (metrics spec §3.1).
 *
 * The period is two inclusive Minsk calendar days, so both bounds are built with `minskDayStart`/`minskDayEnd`
 * and passed as `timestamptz`. Comparing against `$1::date` would let the session timezone move the first three
 * hours of the day: an order at 00:30 Minsk would land on the previous UTC day and disappear from the report.
 *
 * Attribution itself needs a wider touchpoint horizon: an order on the period start can have a touchpoint up to
 * `attribution.windowDays` earlier. The touchpoint query therefore starts at the Minsk day that contains
 * `from - windowDays`, which is a superset of every per-order window; the service narrows each order exactly.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 */
export function createAttributionRepository(db) {
  return {
    /**
     * Orders inside the reporting period, with the acquisition channel of their customer as the fallback.
     *
     * @param {{ from: string, to: string }} period Inclusive Minsk calendar dates.
     * @returns {Promise<Array<{
     *   orderId: string, customerId: string, firstChannelId: string,
     *   occurredAt: Date, revenueCents: bigint,
     * }>>} Ordered by instant and id, so equal-instant orders stay stable across calls.
     */
    async listOrdersInPeriod({ from, to }) {
      const { rows } = await db.query(
        `SELECT o.id::text AS order_id,
                o.customer_id::text AS customer_id,
                c.first_channel_id::text AS first_channel_id,
                o.occurred_at,
                o.revenue_cents::bigint::text AS revenue_cents
           FROM orders o
           JOIN customers c ON c.id = o.customer_id
          WHERE o.occurred_at >= $1::timestamptz
            AND o.occurred_at <= $2::timestamptz
          ORDER BY o.occurred_at, o.id`,
        [minskDayStart(from), minskDayEnd(to)],
      );

      return rows.map((row) => {
        const revenueCents = centsFromDb(row.revenue_cents);
        if (revenueCents === null) {
          throw new TypeError('orders.revenue_cents must not be NULL: the column is NOT NULL');
        }
        return {
          orderId: row.order_id,
          customerId: row.customer_id,
          firstChannelId: row.first_channel_id,
          occurredAt: row.occurred_at,
          revenueCents,
        };
      });
    },

    /**
     * Touchpoints that can affect any order of the period, in one query.
     *
     * The correlated `EXISTS` keeps customers who have no order in the period out of the result and lets PostgreSQL
     * use `orders_customer_idx`, so the scan does not grow with unrelated history. The returned set is deliberately
     * a superset of the per-order windows: an order earlier in the period needs older touches than a later order.
     *
     * @param {{ from: string, to: string }} period Inclusive Minsk calendar dates.
     * @returns {Promise<Array<{
     *   touchpointId: string, customerId: string, channelId: string, occurredAt: Date,
     * }>>}
     */
    async listTouchpointsForOrders({ from, to }) {
      const windowStart = minskDayStart(addDays(from, -METRICS_CONFIG.attribution.windowDays));

      const { rows } = await db.query(
        `SELECT t.id::text AS touchpoint_id,
                t.customer_id::text AS customer_id,
                t.channel_id::text AS channel_id,
                t.occurred_at
           FROM touchpoints t
          WHERE t.occurred_at >= $3::timestamptz
            AND t.occurred_at <= $4::timestamptz
            AND EXISTS (
                  SELECT 1
                    FROM orders o
                   WHERE o.customer_id = t.customer_id
                     AND o.occurred_at >= $1::timestamptz
                     AND o.occurred_at <= $2::timestamptz
                )
          ORDER BY t.customer_id, t.occurred_at, t.id`,
        [minskDayStart(from), minskDayEnd(to), windowStart, minskDayEnd(to)],
      );

      return rows.map((row) => ({
        touchpointId: row.touchpoint_id,
        customerId: row.customer_id,
        channelId: row.channel_id,
        occurredAt: row.occurred_at,
      }));
    },
  };
}
