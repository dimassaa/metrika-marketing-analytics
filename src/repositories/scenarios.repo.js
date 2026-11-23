/**
 * Scenario columns plus the author label. `created_by` is `ON DELETE RESTRICT`, so a LEFT JOIN is only defensive;
 * the list still reads `authorLabel` as «Система» when a row somehow has no author.
 */
const SCENARIO_SELECT = `
  SELECT s.id::text AS id,
         s.name,
         s.created_by::text AS created_by,
         coalesce(u.full_name, u.email) AS author_label,
         s.params,
         s.result,
         s.created_at
    FROM scenarios s
    LEFT JOIN users u ON u.id = s.created_by
`;

/**
 * @param {Record<string, any>} row
 * @returns {{
 *   id: string,
 *   name: string,
 *   createdBy: string | null,
 *   authorLabel: string,
 *   params: Record<string, unknown>,
 *   result: Record<string, unknown>,
 *   createdAt: Date,
 * }}
 */
function mapScenarioRow(row) {
  return {
    id: row.id,
    name: row.name,
    createdBy: row.created_by ?? null,
    authorLabel: row.author_label ?? 'Система',
    // pg parses JSONB into plain objects. The service validates the shape; the repository must not guess.
    params: row.params ?? {},
    result: row.result ?? {},
    createdAt: row.created_at,
  };
}

/**
 * Data access for `scenarios`.
 *
 * The factory accepts either the pool or a transaction client. `saveScenario` uses the client so the scenario row and
 * its `scenario.create` audit row commit or roll back together.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 */
export function createScenariosRepository(db) {
  return {
    /**
     * Newest first, 50 rows per page. `created_at DESC, id DESC` keeps paging stable when two saves share a timestamp.
     * @param {{ page?: number, limit?: number }} [input]
     * @returns {Promise<{
     *   rows: ReturnType<typeof mapScenarioRow>[],
     *   page: number,
     *   total: number,
     *   hasMore: boolean,
     * }>}
     */
    async listScenarios({ page = 1, limit = 50 } = {}) {
      const countResult = await db.query('SELECT count(*)::int AS total FROM scenarios');
      const total = countResult.rows[0]?.total ?? 0;
      const pageCount = Math.max(1, Math.ceil(total / limit));
      const effectivePage = Math.min(Math.max(1, page), pageCount);

      const { rows } = await db.query(
        `${SCENARIO_SELECT}
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT $1::int OFFSET $2::int`,
        [limit, (effectivePage - 1) * limit],
      );

      return {
        rows: rows.map(mapScenarioRow),
        page: effectivePage,
        total,
        hasMore: effectivePage * limit < total,
      };
    },

    /**
     * @param {string} id BIGINT id as a digit string.
     * @returns {Promise<ReturnType<typeof mapScenarioRow> | null>}
     */
    async findScenarioById(id) {
      const { rows } = await db.query(`${SCENARIO_SELECT} WHERE s.id = $1::bigint`, [id]);
      return rows[0] ? mapScenarioRow(rows[0]) : null;
    },

    /**
     * Inserts one immutable snapshot. `params` and `result` are serialised here because a JSONB parameter must be a
     * string (or a value `pg` can stringify); doing it at the SQL boundary keeps the service working with plain
     * objects.
     * @param {{
     *   name: string,
     *   createdBy: string,
     *   params: Record<string, unknown>,
     *   result: Record<string, unknown>,
     * }} scenario
     * @returns {Promise<{ id: string }>}
     */
    async createScenario({ name, createdBy, params, result }) {
      const { rows } = await db.query(
        `INSERT INTO scenarios (name, created_by, params, result)
         VALUES ($1, $2::bigint, $3::jsonb, $4::jsonb)
         RETURNING id::text AS id`,
        [name, createdBy, JSON.stringify(params), JSON.stringify(result)],
      );
      return { id: rows[0].id };
    },
  };
}
