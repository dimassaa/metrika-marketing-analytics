/**
 * Data access for CSV import.
 *
 * The repository is created with whatever executor the caller has: a pooled `db` for read-only screens, or the
 * transaction client inside `withTransaction` for writes. That is why the factory takes any `query`-capable object
 * instead of importing the shared pool: a write must never escape the transaction that carries the batch and the
 * audit row.
 */

/** Joins shared by the batch list and the single-batch read. */
const BATCH_FROM = `
    FROM import_batches b
    LEFT JOIN users u ON u.id = b.created_by
`;

/**
 * Batch columns without the `errors` array. The list only needs the number of entries, so
 * `jsonb_array_length(errors)` keeps a 10 000-row report from being materialised just to draw a table row.
 */
const BATCH_LIST_SELECT = `
  SELECT b.id::text AS id,
         b.kind,
         b.filename,
         b.created_by::text AS created_by,
         u.email AS created_by_email,
         b.rows_total,
         b.rows_ok,
         b.rows_duplicate,
         b.rows_failed,
         b.committed,
         jsonb_array_length(b.errors) AS error_count,
         b.created_at
`;

const BATCH_DETAIL_SELECT = `
  SELECT b.id::text AS id,
         b.kind,
         b.filename,
         b.created_by::text AS created_by,
         u.email AS created_by_email,
         b.rows_total,
         b.rows_ok,
         b.rows_duplicate,
         b.rows_failed,
         b.committed,
         b.errors,
         b.created_at
`;

/**
 * @param {Record<string, any>} row
 * @returns {{
 *   id: string,
 *   kind: string,
 *   filename: string,
 *   createdBy: string | null,
 *   createdByEmail: string | null,
 *   rowsTotal: number,
 *   rowsOk: number,
 *   rowsDuplicate: number,
 *   rowsFailed: number,
 *   committed: boolean,
 *   errorCount: number,
 *   errors: Array<{ row: number, field: string | null, message: string }>,
 *   createdAt: Date,
 * }}
 */
function mapBatchRow(row) {
  const errors = row.errors ?? [];
  return {
    id: row.id,
    kind: row.kind,
    filename: row.filename,
    createdBy: row.created_by ?? null,
    createdByEmail: row.created_by_email ?? null,
    rowsTotal: row.rows_total,
    rowsOk: row.rows_ok,
    rowsDuplicate: row.rows_duplicate,
    rowsFailed: row.rows_failed,
    committed: row.committed,
    errorCount: row.error_count ?? errors.length,
    errors,
    createdAt: row.created_at,
  };
}

/**
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} db
 */
export function createImportRepository(db) {
  return {
    /**
     * @param {{
     *   kind: string,
     *   filename: string,
     *   createdBy: string | null,
     *   rowsTotal: number,
     *   rowsOk: number,
     *   rowsDuplicate: number,
     *   rowsFailed: number,
     *   committed: boolean,
     *   errors: Array<{ row: number, field: string | null, message: string }>,
     * }} batch
     * @returns {Promise<string>} New batch id.
     */
    async insertBatch({ kind, filename, createdBy, rowsTotal, rowsOk, rowsDuplicate, rowsFailed, committed, errors }) {
      const { rows } = await db.query(
        `INSERT INTO import_batches
           (kind, filename, created_by, rows_total, rows_ok, rows_duplicate, rows_failed, committed, errors)
         VALUES ($1, $2, $3::bigint, $4::int, $5::int, $6::int, $7::int, $8::boolean, $9::jsonb)
         RETURNING id::text AS id`,
        [kind, filename, createdBy, rowsTotal, rowsOk, rowsDuplicate, rowsFailed, committed, JSON.stringify(errors)],
      );
      return rows[0].id;
    },

    /**
     * @param {number} limit
     * @returns {Promise<ReturnType<typeof mapBatchRow>[]>} Newest first; `errors` is empty, `errorCount` is set.
     */
    async listRecentBatches(limit) {
      const { rows } = await db.query(
        `${BATCH_LIST_SELECT} ${BATCH_FROM} ORDER BY b.created_at DESC, b.id DESC LIMIT $1::int`,
        [limit],
      );
      return rows.map(mapBatchRow);
    },

    /**
     * @param {string} id BIGINT id as a validated digit string.
     * @returns {Promise<ReturnType<typeof mapBatchRow> | null>}
     */
    async findBatchById(id) {
      const { rows } = await db.query(`${BATCH_DETAIL_SELECT} ${BATCH_FROM} WHERE b.id = $1::bigint`, [id]);
      return rows[0] ? mapBatchRow(rows[0]) : null;
    },

    /**
     * Upserts a daily aggregate. A repeated `(campaign_id, stat_date)` is an update, not a duplicate, so `rowCount`
     * is always one and the service counts the row as applied.
     * @param {{
     *   campaignId: string,
     *   statDate: string,
     *   impressions: number,
     *   clicks: number,
     *   leads: number,
     *   spendCents: bigint,
     * }} row
     * @returns {Promise<void>}
     */
    async insertDailyStatsRow({ campaignId, statDate, impressions, clicks, leads, spendCents }) {
      await db.query(
        `INSERT INTO daily_stats (campaign_id, stat_date, impressions, clicks, leads, spend_cents)
         VALUES ($1::bigint, $2::date, $3::int, $4::int, $5::int, $6::bigint)
         ON CONFLICT (campaign_id, stat_date) DO UPDATE
         SET impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
             leads = EXCLUDED.leads, spend_cents = EXCLUDED.spend_cents
         RETURNING id`,
        [campaignId, statDate, impressions, clicks, leads, spendCents.toString()],
      );
    },

    /**
     * @param {{
     *   externalId: string,
     *   firstChannelId: string,
     *   firstCampaignId: string | null,
     *   firstOrderAt: string | null,
     * }} row
     * @returns {Promise<boolean>} True when inserted, false when the external id already exists (a duplicate).
     */
    async insertCustomerRow({ externalId, firstChannelId, firstCampaignId, firstOrderAt }) {
      const { rowCount } = await db.query(
        `INSERT INTO customers (external_id, first_channel_id, first_campaign_id, acquired_at, first_order_at)
         VALUES ($1, $2::bigint, $3::bigint, COALESCE($4::timestamptz, now()), $4::timestamptz)
         ON CONFLICT (external_id) DO NOTHING
         RETURNING id`,
        [externalId, firstChannelId, firstCampaignId, firstOrderAt],
      );
      return rowCount === 1;
    },

    /**
     * @param {{
     *   customerId: string,
     *   channelId: string,
     *   campaignId: string | null,
     *   occurredAt: string,
     *   kind: string,
     * }} row
     * @returns {Promise<boolean>} False when `(customer_id, occurred_at, channel_id)` already exists.
     */
    async insertTouchpointRow({ customerId, channelId, campaignId, occurredAt, kind }) {
      const { rowCount } = await db.query(
        `INSERT INTO touchpoints (customer_id, channel_id, campaign_id, occurred_at, kind)
         VALUES ($1::bigint, $2::bigint, $3::bigint, $4::timestamptz, $5)
         ON CONFLICT (customer_id, occurred_at, channel_id) DO NOTHING
         RETURNING id`,
        [customerId, channelId, campaignId, occurredAt, kind],
      );
      return rowCount === 1;
    },

    /**
     * @param {{
     *   externalId: string,
     *   customerId: string,
     *   campaignId: string | null,
     *   occurredAt: string,
     *   revenueCents: bigint,
     *   marginCents: bigint,
     * }} row
     * @returns {Promise<boolean>} False when the order external id already exists.
     */
    async insertOrderRow({ externalId, customerId, campaignId, occurredAt, revenueCents, marginCents }) {
      const { rowCount } = await db.query(
        `INSERT INTO orders (external_id, customer_id, campaign_id, occurred_at, revenue_cents, margin_cents)
         VALUES ($1, $2::bigint, $3::bigint, $4::timestamptz, $5::bigint, $6::bigint)
         ON CONFLICT (external_id) DO NOTHING
         RETURNING id`,
        [externalId, customerId, campaignId, occurredAt, revenueCents.toString(), marginCents.toString()],
      );
      return rowCount === 1;
    },

    /**
     * Moves acquisition back in time for a customer without a known first order. The SQL re-checks the condition so
     * a stale snapshot from the row loop cannot overwrite a value that an earlier row already corrected.
     * @param {string} customerId
     * @param {string} occurredAt ISO instant.
     * @returns {Promise<void>}
     */
    async moveCustomerAcquiredAt(customerId, occurredAt) {
      await db.query(
        `UPDATE customers
            SET acquired_at = LEAST(acquired_at, $2::timestamptz)
          WHERE id = $1::bigint
            AND first_order_at IS NULL`,
        [customerId, occurredAt],
      );
    },

    /**
     * @param {string} customerId
     * @param {string} occurredAt ISO instant.
     * @returns {Promise<void>}
     */
    async setCustomerFirstOrderAt(customerId, occurredAt) {
      await db.query(
        `UPDATE customers
            SET first_order_at = $2::timestamptz
          WHERE id = $1::bigint
            AND (first_order_at IS NULL OR first_order_at > $2::timestamptz)`,
        [customerId, occurredAt],
      );
    },

    /**
     * Channels keyed by code, used once per import instead of a query per row.
     * @returns {Promise<Array<{ id: string, code: string }>>}
     */
    async listChannelRefs() {
      const { rows } = await db.query('SELECT id::text AS id, code FROM channels ORDER BY id');
      return rows;
    },

    /**
     * Campaigns with their owning channel, for both existence and the "campaign belongs to this channel" rule.
     * @returns {Promise<Array<{ id: string, code: string, channelId: string }>>}
     */
    async listCampaignRefs() {
      const { rows } = await db.query(
        'SELECT id::text AS id, code, channel_id::text AS channel_id FROM campaigns ORDER BY id',
      );
      return rows.map((row) => ({ id: row.id, code: row.code, channelId: row.channel_id }));
    },

    /**
     * @param {string[]} externalIds
     * @returns {Promise<Array<{
     *   id: string,
     *   externalId: string,
     *   acquiredAt: Date,
     *   firstOrderAt: Date | null,
     * }>>} Empty array for an empty input, so callers need no branch.
     */
    async findCustomersByExternalIds(externalIds) {
      if (externalIds.length === 0) return [];
      const { rows } = await db.query(
        `SELECT id::text AS id,
                external_id,
                acquired_at,
                first_order_at
           FROM customers
          WHERE external_id = ANY($1::text[])`,
        [externalIds],
      );
      return rows.map((row) => ({
        id: row.id,
        externalId: row.external_id,
        acquiredAt: row.acquired_at,
        firstOrderAt: row.first_order_at,
      }));
    },

    /**
     * Dry-run duplicate check: which of these customer external ids already exist.
     * @param {string[]} externalIds
     * @returns {Promise<string[]>}
     */
    async listExistingCustomerIds(externalIds) {
      if (externalIds.length === 0) return [];
      const { rows } = await db.query(
        'SELECT external_id FROM customers WHERE external_id = ANY($1::text[])',
        [externalIds],
      );
      return rows.map((row) => row.external_id);
    },

    /**
     * Dry-run duplicate check for orders.
     * @param {string[]} externalIds
     * @returns {Promise<string[]>}
     */
    async listExistingOrderIds(externalIds) {
      if (externalIds.length === 0) return [];
      const { rows } = await db.query('SELECT external_id FROM orders WHERE external_id = ANY($1::text[])', [
        externalIds,
      ]);
      return rows.map((row) => row.external_id);
    },

    /**
     * Dry-run duplicate check for touchpoints: every stored key of the affected customers. Only imported customers
     * are queried, so a history-heavy demo stand does not load the whole table.
     * @param {string[]} customerIds
     * @returns {Promise<Array<{ customerId: string, occurredAt: Date, channelId: string }>>}
     */
    async listTouchpointKeysForCustomers(customerIds) {
      if (customerIds.length === 0) return [];
      const { rows } = await db.query(
        `SELECT customer_id::text AS customer_id, occurred_at, channel_id::text AS channel_id
           FROM touchpoints
          WHERE customer_id = ANY($1::bigint[])`,
        [customerIds],
      );
      return rows.map((row) => ({
        customerId: row.customer_id,
        occurredAt: row.occurred_at,
        channelId: row.channel_id,
      }));
    },
  };
}
