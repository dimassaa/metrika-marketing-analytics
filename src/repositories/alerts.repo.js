import { ValidationError } from '../lib/errors.js';
import { parseBigIntId } from '../lib/ids.js';

/**
 * Alert columns shared by the list, the single-row reads and the lifecycle updates.
 *
 * `value` and `threshold` are selected as text: they are NUMERIC(14,4) traces written by the pure rule evaluator, and
 * a float round trip would destroy the fourth decimal that migration 006 exists to preserve. `period_start::text`
 * keeps a calendar date a plain `YYYY-MM-DD` string, matching the pure window model instead of attaching a timezone.
 */
const ALERT_SELECT = `
  SELECT a.id::text AS id,
         a.channel_id::text AS channel_id,
         ch.code AS channel_code,
         ch.name AS channel_name,
         a.rule,
         a.severity,
         a.period_start::text AS period_start,
         a.value::text AS value,
         a.threshold::text AS threshold,
         a.status,
         a.detected_at
    FROM alerts a
    JOIN channels ch ON ch.id = a.channel_id
`;

/** @param {Record<string, any>} row */
function mapAlertRow(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelCode: row.channel_code ?? null,
    channelName: row.channel_name ?? null,
    rule: row.rule,
    severity: row.severity,
    periodStart: row.period_start,
    value: row.value,
    threshold: row.threshold,
    status: row.status,
    detectedAt: row.detected_at,
  };
}

/**
 * @param {unknown} channelId
 * @returns {string | null} Normalised BIGINT id or null when no channel filter was supplied.
 * @throws {ValidationError} When the filter is present but is not a BIGINT id.
 */
function normaliseChannelFilter(channelId) {
  if (channelId === null || channelId === undefined || channelId === '') return null;
  const id = parseBigIntId(channelId);
  if (id === null) throw new ValidationError('Некорректный идентификатор канала');
  return id;
}

/**
 * @param {unknown} value
 * @returns {string | null} A known status or null for "all".
 */
function normaliseStatus(value) {
  if (value === null || value === undefined || value === '' || value === 'all') return null;
  if (value === 'active' || value === 'resolved' || value === 'dismissed') return value;
  throw new ValidationError('Некорректный статус алерта');
}

/**
 * @param {unknown} value
 * @returns {string | null} A known severity or null for "all".
 */
function normaliseSeverity(value) {
  if (value === null || value === undefined || value === '' || value === 'all') return null;
  if (value === 'warning' || value === 'critical') return value;
  throw new ValidationError('Некорректная важность алерта');
}

/**
 * Data access for `alerts` (metrics spec §7).
 *
 * The repository is a factory over any `query`-capable object: the production pool, a transaction client created by
 * `withTransaction`, or the test pool. It owns no global state, so the recalculation can put every write on one
 * client while the reads keep using the caller-provided repository.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 */
export function createAlertsRepository(db) {
  return {
    /**
     * One page of alerts with a stable order, plus the unfiltered summary the screen header shows.
     *
     * The summary deliberately ignores the row filters: the header answers "what is the overall state" while the
     * table answers "what matches the filter". Counting the filtered rows twice would make the header follow the
     * filter and hide the total picture.
     *
     * @param {{
     *   filters?: { status?: string | null, severity?: string | null, channelId?: string | null },
     *   page?: number,
     *   limit?: number,
     * }} [input]
     * @returns {Promise<{
     *   rows: ReturnType<typeof mapAlertRow>[],
     *   summary: {
     *     active: number, critical: number, warning: number, resolved: number, dismissed: number,
     *     lastDetectedAt: Date | null,
     *   },
     *   page: number,
     *   total: number,
     *   hasMore: boolean,
     * }>}
     * @throws {ValidationError} When a filter value is not recognised.
     */
    async listAlerts({ filters = {}, page = 1, limit = 50 } = {}) {
      const status = normaliseStatus(filters.status);
      const severity = normaliseSeverity(filters.severity);
      const channelId = normaliseChannelFilter(filters.channelId);

      const filterParams = [status, severity, channelId];
      const countResult = await db.query(
        `SELECT count(*)::int AS total
           FROM alerts a
          WHERE ($1::text IS NULL OR a.status = $1::text)
            AND ($2::text IS NULL OR a.severity = $2::text)
            AND ($3::bigint IS NULL OR a.channel_id = $3::bigint)`,
        filterParams,
      );
      const total = countResult.rows[0]?.total ?? 0;
      const pageCount = Math.max(1, Math.ceil(total / limit));
      const effectivePage = Math.min(Math.max(1, page), pageCount);

      const { rows } = await db.query(
        `${ALERT_SELECT}
          WHERE ($1::text IS NULL OR a.status = $1::text)
            AND ($2::text IS NULL OR a.severity = $2::text)
            AND ($3::bigint IS NULL OR a.channel_id = $3::bigint)
          ORDER BY a.detected_at DESC, a.id DESC
          LIMIT $4::int OFFSET $5::int`,
        [...filterParams, limit, (effectivePage - 1) * limit],
      );

      const summaryResult = await db.query(
        `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
                count(*) FILTER (WHERE status = 'active' AND severity = 'critical')::int AS critical,
                count(*) FILTER (WHERE status = 'active' AND severity = 'warning')::int AS warning,
                count(*) FILTER (WHERE status = 'resolved')::int AS resolved,
                count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed,
                max(detected_at) AS last_detected_at
           FROM alerts`,
      );
      const summaryRow = summaryResult.rows[0] ?? {};

      return {
        rows: rows.map(mapAlertRow),
        summary: {
          active: summaryRow.active ?? 0,
          critical: summaryRow.critical ?? 0,
          warning: summaryRow.warning ?? 0,
          resolved: summaryRow.resolved ?? 0,
          dismissed: summaryRow.dismissed ?? 0,
          lastDetectedAt: summaryRow.last_detected_at ?? null,
        },
        page: effectivePage,
        total,
        hasMore: effectivePage * limit < total,
      };
    },

    /**
     * @param {string} id BIGINT id as a digit string.
     * @returns {Promise<ReturnType<typeof mapAlertRow> | null>}
     */
    async findAlertById(id) {
      const { rows } = await db.query(`${ALERT_SELECT} WHERE a.id = $1::bigint`, [id]);
      return rows[0] ? mapAlertRow(rows[0]) : null;
    },

    /**
     * Active rows of exactly one stored period. The lifecycle calculation compares this set with the rules that fired
     * during the current recalculation; anything left over is stale and must be resolved.
     * @param {string} periodStart `YYYY-MM-DD` Monday.
     * @returns {Promise<ReturnType<typeof mapAlertRow>[]>}
     */
    async listCurrentPeriodActive(periodStart) {
      const { rows } = await db.query(
        `${ALERT_SELECT}
          WHERE a.period_start = $1::date
            AND a.status = 'active'
          ORDER BY a.id`,
        [periodStart],
      );
      return rows.map(mapAlertRow);
    },

    /**
     * One batch upsert for every candidate of the current period.
     *
     * `period_start` is part of the unnest tuple, the INSERT column list and the ON CONFLICT target. Omitting it from
     * any of the three would either move an alert into the wrong week or make PostgreSQL reject the statement because
     * no unique constraint matches — the dedupe key is exactly `(channel_id, rule, period_start)`.
     *
     * A dismissed row keeps its status while its measured value and severity are refreshed: the analyst said "this
     * alert does not matter", but the next recalculation must still show the current numbers if it is ever reopened.
     * `(xmax = 0)` distinguishes a fresh insert from a conflict update for the returned counts.
     *
     * @param {Array<{
     *   channelId: string, rule: string, periodStart: string, severity: string, value: string, threshold: string,
     * }>} rows
     * @returns {Promise<{ inserted: number, updated: number, dismissed: number }>}
     */
    async upsertAlerts(rows) {
      if (!Array.isArray(rows)) throw new TypeError('upsertAlerts expects an array');
      if (rows.length === 0) return { inserted: 0, updated: 0, dismissed: 0 };

      const result = await db.query(
        `INSERT INTO alerts (channel_id, rule, period_start, severity, value, threshold)
         SELECT *
           FROM unnest(
             $1::bigint[],
             $2::text[],
             $3::date[],
             $4::text[],
             $5::numeric[],
             $6::numeric[]
           )
         ON CONFLICT (channel_id, rule, period_start) DO UPDATE
            SET severity = EXCLUDED.severity,
                value = EXCLUDED.value,
                threshold = EXCLUDED.threshold,
                detected_at = now(),
                status = CASE WHEN alerts.status = 'dismissed' THEN 'dismissed' ELSE 'active' END
         RETURNING (xmax = 0) AS inserted, status`,
        [
          rows.map((row) => row.channelId),
          rows.map((row) => row.rule),
          rows.map((row) => row.periodStart),
          rows.map((row) => row.severity),
          rows.map((row) => row.value),
          rows.map((row) => row.threshold),
        ],
      );

      let inserted = 0;
      let dismissed = 0;
      for (const row of result.rows) {
        if (row.inserted) inserted += 1;
        if (row.status === 'dismissed') dismissed += 1;
      }
      return { inserted, updated: result.rows.length - inserted, dismissed };
    },

    /**
     * @param {string[]} ids Alert ids to resolve.
     * @returns {Promise<number>} Rows actually moved from `active` to `resolved`.
     */
    async resolveAlerts(ids) {
      if (!Array.isArray(ids)) throw new TypeError('resolveAlerts expects an array of ids');
      if (ids.length === 0) return 0;
      const { rows } = await db.query(
        `UPDATE alerts
            SET status = 'resolved'
          WHERE id = ANY($1::bigint[])
            AND status = 'active'
          RETURNING id`,
        [ids],
      );
      return rows.length;
    },

    /**
     * Resolves every still-active alert of an older period. Recalculated periods are complete windows, so an active
     * row from a previous window can never be repaired by the current run and must not stay on the screen.
     * @param {string} periodStart Current `YYYY-MM-DD` period key.
     * @returns {Promise<number>}
     */
    async resolveActiveBefore(periodStart) {
      const { rows } = await db.query(
        `UPDATE alerts
            SET status = 'resolved'
          WHERE status = 'active'
            AND period_start < $1::date
          RETURNING id`,
        [periodStart],
      );
      return rows.length;
    },

    /**
     * @param {string} id
     * @returns {Promise<ReturnType<typeof mapAlertRow> | null>} The dismissed row, or null when it was already
     *   closed or no longer exists.
     */
    async dismissAlert(id) {
      // A data-modifying CTE keeps the returned row and its channel labels in one statement; a subquery inside
      // RETURNING would have to reference the update target by name, which is easy to get wrong when the table is
      // aliased later.
      const { rows } = await db.query(
        `WITH dismissed AS (
           UPDATE alerts
              SET status = 'dismissed'
            WHERE id = $1::bigint
              AND status = 'active'
            RETURNING *
         )
         SELECT d.id::text AS id,
                d.channel_id::text AS channel_id,
                ch.code AS channel_code,
                ch.name AS channel_name,
                d.rule,
                d.severity,
                d.period_start::text AS period_start,
                d.value::text AS value,
                d.threshold::text AS threshold,
                d.status,
                d.detected_at
           FROM dismissed d
           JOIN channels ch ON ch.id = d.channel_id`,
        [id],
      );
      return rows[0] ? mapAlertRow(rows[0]) : null;
    },

    /**
     * Absolute last recalculation time, taken from the table rather than the system clock. An empty table is null,
     * which the screen renders as «ещё не проверяли».
     * @returns {Promise<Date | null>}
     */
    async lastDetectedAt() {
      const { rows } = await db.query('SELECT max(detected_at) AS last_detected_at FROM alerts');
      return rows[0]?.last_detected_at ?? null;
    },
  };
}
