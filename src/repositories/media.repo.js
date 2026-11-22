/** Metadata columns for lookups that never need the binary payload (profile avatar, OG cover status). */
const MEDIA_METADATA_COLUMNS = 'id::text AS id, slug, filename, mime_type, size_bytes, checksum';

/**
 * Maps a `media_assets` row. `id` is a BIGINT and stays a decimal string, like every other PostgreSQL id in the
 * codebase. `bytes` is included only when the caller selected it; the repository never invents an empty buffer,
 * because an empty image and a metadata-only read must stay distinguishable.
 * @param {Record<string, any>} row
 * @param {{ includeBytes?: boolean }} [options]
 * @returns {{
 *   id: string,
 *   slug: string | null,
 *   filename: string,
 *   mimeType: string,
 *   sizeBytes: number,
 *   checksum: string,
 *   bytes?: Buffer,
 * }}
 */
function mapMedia(row, { includeBytes = false } = {}) {
  const media = {
    id: row.id,
    slug: row.slug,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
  };
  if (includeBytes) media.bytes = row.bytes;
  return media;
}

/**
 * Data access for `media_assets`. Files live in PostgreSQL as BYTEA so the demo has one source of truth and no
 * orphaned upload directory; every query here is parameterized and returns raw columns, never HTTP shapes.
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 */
export function createMediaRepository(db) {
  return {
    /**
     * Inserts an asset or replaces the bytes of an existing one. The slug is the identity for profile avatars and
     * the OG cover: uploading a new picture updates the row in place, so `/media/slug/og-cover` keeps working and
     * the table does not accumulate one row per upload.
     * @param {{
     *   slug: string,
     *   filename: string,
     *   mimeType: string,
     *   sizeBytes: number,
     *   checksum: string,
     *   bytes: Buffer,
     * }} asset
     * @returns {Promise<ReturnType<typeof mapMedia>>} Row metadata, without the binary payload.
     */
    async upsertMediaAsset({ slug, filename, mimeType, sizeBytes, checksum, bytes }) {
      const { rows } = await db.query(
        `INSERT INTO media_assets (slug, filename, mime_type, size_bytes, checksum, bytes)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (slug) DO UPDATE
           SET filename = EXCLUDED.filename,
               mime_type = EXCLUDED.mime_type,
               size_bytes = EXCLUDED.size_bytes,
               checksum = EXCLUDED.checksum,
               bytes = EXCLUDED.bytes
         RETURNING ${MEDIA_METADATA_COLUMNS}`,
        [slug, filename, mimeType, sizeBytes, checksum, bytes],
      );
      return mapMedia(rows[0]);
    },

    /**
     * Full asset for the public route, bytes included.
     * @param {string} id Validated positive BIGINT decimal string.
     * @returns {Promise<ReturnType<typeof mapMedia> | null>}
     */
    async findMediaById(id) {
      const { rows } = await db.query(
        `SELECT ${MEDIA_METADATA_COLUMNS}, bytes FROM media_assets WHERE id = $1::bigint`,
        [id],
      );
      return rows[0] ? mapMedia(rows[0], { includeBytes: true }) : null;
    },

    /**
     * Looks an asset up by its stable slug. Serving needs the bytes; the profile and admin screens only need the id
     * to build a URL, so they pass `includeBytes: false` and avoid moving up to 1 MB per page render.
     * @param {string} slug
     * @param {{ includeBytes?: boolean }} [options]
     * @returns {Promise<ReturnType<typeof mapMedia> | null>}
     */
    async findMediaBySlug(slug, { includeBytes = true } = {}) {
      const columns = includeBytes ? `${MEDIA_METADATA_COLUMNS}, bytes` : MEDIA_METADATA_COLUMNS;
      const { rows } = await db.query(`SELECT ${columns} FROM media_assets WHERE slug = $1`, [slug]);
      return rows[0] ? mapMedia(rows[0], { includeBytes }) : null;
    },
  };
}
