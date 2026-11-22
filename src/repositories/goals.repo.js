/**
 * Goal columns plus the channel label. `target_value` is a NUMERIC and is selected as text so the mixed unit
 * (BYN, percent, ratio, months, count) reaches the service as the exact stored decimal without a float round trip.
 */
const GOAL_SELECT = `
  SELECT g.id::text AS id,
         g.metric,
         g.channel_id::text AS channel_id,
         g.target_value::text AS target_value,
         g.period_start::text AS period_start,
         g.period_end::text AS period_end,
         g.created_by::text AS created_by,
         g.created_at,
         ch.name AS channel_name,
         ch.code AS channel_code,
         ch.is_active AS channel_is_active
    FROM goals g
    LEFT JOIN channels ch ON ch.id = g.channel_id
`;

/**
 * @param {Record<string, any>} row
 * @returns {{
 *   id: string,
 *   metric: string,
 *   channelId: string | null,
 *   targetValue: string,
 *   periodStart: string,
 *   periodEnd: string,
 *   createdBy: string | null,
 *   createdAt: Date | null,
 *   channelName: string | null,
 *   channelCode: string | null,
 *   channelIsActive: boolean | null,
 * }}
 */
function mapGoalRow(row) {
  return {
    id: row.id,
    metric: row.metric,
    channelId: row.channel_id ?? null,
    targetValue: row.target_value,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at ?? null,
    channelName: row.channel_name ?? null,
    channelCode: row.channel_code ?? null,
    channelIsActive: row.channel_is_active ?? null,
  };
}

/**
 * Data access for `goals`. Every statement is parameterized; ids arrive as strings because `pg` returns BIGINT as
 * a string, and explicit casts keep the round trip lossless.
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 */
export function createGoalsRepository(db) {
  return {
    /**
     * Serialises creates and edits of the same metric/channel scope inside a transaction. The unique index only
     * catches identical periods; an advisory lock closes the window in which two different overlapping periods
     * could both pass the service check. `hashtext` collisions merely serialise unrelated scopes, which is safe.
     * @param {string} metric
     * @param {string | null} channelId
     * @returns {Promise<void>}
     */
    async lockGoalScope(metric, channelId) {
      // Normalise through BigInt so `007` and `7` name the same scope. Two spellings would otherwise take different
      // advisory locks and let an overlapping write through.
      const scope = channelId === null ? 'global' : BigInt(channelId).toString();
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`goal:${metric}:${scope}`]);
    },

    /**
     * @param {{ channelId?: string | null, metric?: string | null }} [filters] NULL disables the condition.
     * @returns {Promise<ReturnType<typeof mapGoalRow>[]>} Newest period first, with a stable tie-break order.
     */
    async listGoals({ channelId = null, metric = null } = {}) {
      const { rows } = await db.query(
        `${GOAL_SELECT}
          WHERE ($1::bigint IS NULL OR g.channel_id = $1::bigint)
            AND ($2::text IS NULL OR g.metric = $2::text)
          ORDER BY g.period_end DESC, g.period_start DESC, g.metric, g.channel_id NULLS FIRST, g.id`,
        [channelId, metric],
      );
      return rows.map(mapGoalRow);
    },

    /**
     * @param {string} id BIGINT id as a validated digit string.
     * @returns {Promise<ReturnType<typeof mapGoalRow> | null>}
     */
    async findGoalById(id) {
      const { rows } = await db.query(`${GOAL_SELECT} WHERE g.id = $1::bigint`, [id]);
      return rows[0] ? mapGoalRow(rows[0]) : null;
    },

    /**
     * Overlap rule: for one `(metric, COALESCE(channel_id, 0))` interval `[period_start, period_end]` is inclusive,
     * so two goals conflict when `existing.start <= new.end AND existing.end >= new.start`.
     * `IS NOT DISTINCT FROM` treats a global goal (NULL channel) as one scope instead of dropping it.
     * @param {{
     *   metric: string,
     *   channelId: string | null,
     *   periodStart: string,
     *   periodEnd: string,
     *   excludeId?: string | null,
     * }} goal `excludeId` keeps the row being edited out of its own check.
     * @returns {Promise<ReturnType<typeof mapGoalRow> | null>}
     */
    async findOverlappingGoal({ metric, channelId, periodStart, periodEnd, excludeId = null }) {
      const { rows } = await db.query(
        `${GOAL_SELECT}
          WHERE g.metric = $1::text
            AND g.channel_id IS NOT DISTINCT FROM $2::bigint
            AND g.period_start <= $4::date
            AND g.period_end >= $3::date
            AND ($5::bigint IS NULL OR g.id <> $5::bigint)
          ORDER BY g.id
          LIMIT 1`,
        [metric, channelId, periodStart, periodEnd, excludeId],
      );
      return rows[0] ? mapGoalRow(rows[0]) : null;
    },

    /**
     * Channel existence pre-check for a friendly Russian message; the foreign key still covers the race.
     * @param {string} id
     * @returns {Promise<boolean>}
     */
    async channelExists(id) {
      const { rows } = await db.query('SELECT 1 FROM channels WHERE id = $1::bigint', [id]);
      return rows.length > 0;
    },

    /**
     * @param {{
     *   metric: string,
     *   channelId: string | null,
     *   targetValue: string,
     *   periodStart: string,
     *   periodEnd: string,
     *   createdBy: string | null,
     * }} goal
     * @returns {Promise<string>} Id of the new row.
     */
    async createGoal({ metric, channelId, targetValue, periodStart, periodEnd, createdBy }) {
      const { rows } = await db.query(
        `INSERT INTO goals (metric, channel_id, target_value, period_start, period_end, created_by)
         VALUES ($1, $2::bigint, $3::numeric, $4::date, $5::date, $6::bigint)
         RETURNING id::text AS id`,
        [metric, channelId, targetValue, periodStart, periodEnd, createdBy],
      );
      return rows[0].id;
    },

    /**
     * Metric and channel are part of the goal identity for the overlap rule and are not editable.
     * @param {string} id
     * @param {{ targetValue: string, periodStart: string, periodEnd: string }} fields
     * @returns {Promise<boolean>} False when the row disappeared between the service read and this UPDATE.
     */
    async updateGoal(id, { targetValue, periodStart, periodEnd }) {
      const { rows } = await db.query(
        `UPDATE goals
            SET target_value = $2::numeric,
                period_start = $3::date,
                period_end = $4::date
          WHERE id = $1::bigint
          RETURNING id::text AS id`,
        [id, targetValue, periodStart, periodEnd],
      );
      return rows.length > 0;
    },

    /**
     * @param {string} id
     * @returns {Promise<boolean>} False when the row was already gone.
     */
    async deleteGoal(id) {
      const { rows } = await db.query('DELETE FROM goals WHERE id = $1::bigint RETURNING id::text AS id', [id]);
      return rows.length > 0;
    },
  };
}
