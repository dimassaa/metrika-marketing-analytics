import { NotFoundError, ValidationError } from '../lib/errors.js';
import { parseBigIntId } from '../lib/ids.js';
import { mediaAssetUrl } from '../lib/mediaUrl.js';

const NOT_FOUND_MESSAGE = 'Изображение не найдено';

/**
 * Checks an `If-None-Match` header against the strong ETag. A client may send a comma-separated list, and the weak
 * `W/"…"` prefix still satisfies a GET: RFC 9110 uses the weak comparison function for conditional GETs.
 * @param {string | undefined} header
 * @param {string} etag Quoted strong ETag, for example `"<sha256>"`.
 * @returns {boolean}
 */
export function ifNoneMatchSatisfied(header, etag) {
  if (!header) return false;
  return header
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === '*' || value === etag || value === `W/${etag}`);
}

/**
 * Public media routes and the two upload endpoints. The controller only translates HTTP: the id parser lives in
 * `lib/ids.js`, the image rules in the service, and the cache headers are set here because they describe the wire
 * representation of an already validated asset.
 *
 * @param {{
 *   mediaService: ReturnType<typeof import('../services/media.service.js').createMediaService>,
 * }} deps
 */
export function createMediaController({ mediaService }) {
  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {{
   *   id: string, slug: string | null, filename: string, mimeType: string, sizeBytes: number, checksum: string,
   *   bytes: Buffer,
   * }} media
   */
  function sendMedia(req, res, media) {
    const etag = `"${media.checksum}"`;
    // The CSRF middleware publishes the session token on safe requests. A response that shared caches may keep for
    // a year must not carry it (or a refreshed cookie) to another visitor.
    res.removeHeader('X-CSRF-Token');
    res.removeHeader('Set-Cookie');
    res.set({
      'Content-Type': media.mimeType,
      ETag: etag,
      // Immutable content, addressed by `/media/<id>?v=<checksum>`: a changed upload gets a new checksum, hence a
      // new URL, so a year is safe for the demo and keeps social previews from re-downloading the cover on every
      // crawl. The bare id/slug URL stays valid for direct links and old shares.
      'Cache-Control': 'public, max-age=86400, immutable',
      // The stored type is checked against magic bytes, but nosniff keeps a legacy browser from guessing anyway.
      'X-Content-Type-Options': 'nosniff',
    });

    if (ifNoneMatchSatisfied(req.get('if-none-match'), etag)) {
      res.status(304).end();
      return;
    }

    res.set('Content-Length', String(media.bytes.length));
    res.send(media.bytes);
  }

  /**
   * @param {import('express').Request} req
   * @param {string} slug
   * @returns {Promise<object>} Stored asset metadata.
   */
  async function saveUpload(req, slug) {
    if (!req.file) {
      throw new ValidationError('Выберите файл для загрузки');
    }
    return mediaService.saveMedia({
      slug,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      buffer: req.file.buffer,
      actor: { id: req.session.user.id, ip: req.ip ?? null },
    });
  }

  /**
   * @param {import('express').Response} res
   * @param {object} media Saved asset metadata.
   * @param {string} media.id
   * @param {string | null} media.slug
   */
  function respondWithUpload(res, media) {
    res.status(200).json({
      // BIGINT ids stay decimal strings, matching every other id in the API and in PostgreSQL.
      mediaId: media.id,
      slug: media.slug,
      url: mediaAssetUrl(media, { bySlug: media.slug === 'og-cover' }),
    });
  }

  return {
    /**
     * `GET /media/:id`. A malformed or out-of-range id is indistinguishable from a missing one: both are 404, so
     * the route cannot be used to probe the id space. Leading zeros are acceptable and normalize (`/media/007` reads
     * the row with id 7), because the shared parser compares `BigInt` values rather than spelling.
     * @type {import('express').RequestHandler}
     */
    async byId(req, res) {
      const id = parseBigIntId(req.params.id);
      if (id === null) throw new NotFoundError(NOT_FOUND_MESSAGE);
      sendMedia(req, res, await mediaService.getMediaById(id));
    },

    /**
     * `GET /media/slug/:slug`. Needed for the stable OG cover URL, which must survive cover replacements.
     * @type {import('express').RequestHandler}
     */
    async bySlug(req, res) {
      sendMedia(req, res, await mediaService.getMediaBySlug(String(req.params.slug ?? '')));
    },

    /**
     * `POST /api/v1/profile/avatar`: the caller replaces their own avatar. The slug embeds the user id, so one
     * account can never overwrite another account's picture.
     * @type {import('express').RequestHandler}
     */
    async uploadAvatar(req, res) {
      const media = await saveUpload(req, `avatar-user-${req.session.user.id}`);
      respondWithUpload(res, media);
    },

    /**
     * `POST /api/v1/admin/media/og-cover`: admin-only by route permission, the slug is constant by design.
     * @type {import('express').RequestHandler}
     */
    async uploadOgCover(req, res) {
      const media = await saveUpload(req, 'og-cover');
      respondWithUpload(res, media);
    },
  };
}
