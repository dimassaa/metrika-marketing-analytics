/**
 * Builds a cache-safe public URL for a media asset.
 *
 * The row id (and the stable slug) do not change when an upload is replaced, so an immutable cached URL would keep
 * serving the previous bytes. Appending the checksum as `v` makes the URL content-addressed: a new upload produces a
 * new URL, and the browser fetches the new bytes even though `/media/:id` itself is cached forever.
 *
 * @param {{ id: string, slug: string | null, checksum: string }} media
 * @param {{ bySlug?: boolean }} [options] Use the stable slug form, required for the OG cover.
 * @returns {string} For example `/media/42?v=<sha256>` or `/media/slug/og-cover?v=<sha256>`.
 */
export function mediaAssetUrl({ id, slug, checksum }, { bySlug = false } = {}) {
  const path = bySlug && slug ? `/media/slug/${slug}` : `/media/${id}`;
  return `${path}?v=${encodeURIComponent(checksum)}`;
}
