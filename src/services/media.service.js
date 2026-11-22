import { createHash } from 'node:crypto';
import { AUDIT_ACTIONS } from '../config/audit-actions.js';
import { AppError, NotFoundError, ValidationError } from '../lib/errors.js';

/** Size cap fixed by the media task. The uploader enforces it too; this guard protects direct service callers. */
export const MEDIA_MAX_BYTES = 1024 * 1024;

/** Declared MIME types the service accepts. Every one must also pass its magic-byte check below. */
export const MEDIA_ALLOWED_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);

const INVALID_IMAGE = 'Допустимы только изображения PNG, JPEG или WebP';
const NOT_FOUND_MESSAGE = 'Изображение не найдено';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Stable slugs are lowercase ASCII; anything else is rejected before it reaches SQL. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;

const DEFAULT_FILENAMES = Object.freeze({
  'image/png': 'image.png',
  'image/jpeg': 'image.jpg',
  'image/webp': 'image.webp',
});

/**
 * Reads the file signature, not the declared Content-Type. A browser or a crafted request can label any bytes as
 * `image/png`; the four/magic bytes are what decides whether the buffer really is an image.
 * @param {Buffer} buffer
 * @returns {'image/png' | 'image/jpeg' | 'image/webp' | null}
 */
export function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;

  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Strips any directory component and control characters from the uploaded name. The name is display-only and never
 * used as a path, but hostile text is cheaper to remove at the boundary than to trust in the journal.
 * @param {unknown} raw
 * @param {string} mimeType Validated image type, used for the fallback name.
 * @returns {string}
 */
export function sanitizeMediaFilename(raw, mimeType) {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120).trim();
  return cleaned === '' ? (DEFAULT_FILENAMES[mimeType] ?? 'image') : cleaned;
}

/**
 * Media rules: signature validation, checksum calculation, filename sanitising and the audit entry.
 *
 * The service owns the "what is a valid image" decision so the HTTP layer cannot widen the whitelist by accident.
 * SVG is deliberately absent: an SVG can carry scripts and would become stored XSS when served from this origin.
 *
 * @param {{
 *   mediaRepository: ReturnType<typeof import('../repositories/media.repo.js').createMediaRepository>,
 *   auditService: ReturnType<typeof import('./audit.service.js').createAuditService>,
 * }} deps
 */
export function createMediaService({ mediaRepository, auditService }) {
  /**
   * Validates the buffer and the declared type together. A file whose bytes do not match its declared type is
   * rejected even when both are individually on the whitelist, so a JPEG cannot be stored under `image/png`.
   * @param {unknown} mimeType
   * @param {Buffer} buffer
   * @returns {string} The validated MIME type.
   * @throws {ValidationError} When the type is outside the whitelist or the bytes do not match it.
   * @throws {AppError} 413 when a caller bypasses the multipart limit.
   */
  function validateImage(mimeType, buffer) {
    if (typeof mimeType !== 'string' || !MEDIA_ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new ValidationError(INVALID_IMAGE);
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new ValidationError('Выберите файл для загрузки');
    }
    if (buffer.length > MEDIA_MAX_BYTES) {
      throw new AppError('Файл превышает допустимый размер 1 МБ', {
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
      });
    }
    if (detectImageMime(buffer) !== mimeType) {
      throw new ValidationError(INVALID_IMAGE);
    }
    return mimeType;
  }

  return {
    /**
     * Stores or replaces one image and records the upload.
     *
     * The audit payload names the asset and its size but never includes the bytes: the journal is read by admins and
     * is not an image store.
     *
     * @param {{
     *   slug: string,
     *   originalName: unknown,
     *   mimeType: string,
     *   buffer: Buffer,
     *   actor?: { id?: string, ip?: string | null } | null,
     * }} input
     * @returns {Promise<{
     *   id: string, slug: string | null, filename: string, mimeType: string, sizeBytes: number, checksum: string,
     * }>}
     * @throws {ValidationError} When the file is missing, too large or not a whitelisted image.
     */
    async saveMedia({ slug, originalName, mimeType, buffer, actor = null }) {
      const validatedMime = validateImage(mimeType, buffer);
      const filename = sanitizeMediaFilename(originalName, validatedMime);
      const checksum = createHash('sha256').update(buffer).digest('hex');

      const media = await mediaRepository.upsertMediaAsset({
        slug,
        filename,
        mimeType: validatedMime,
        sizeBytes: buffer.length,
        checksum,
        bytes: buffer,
      });

      await auditService.record({
        userId: actor?.id ?? null,
        action: AUDIT_ACTIONS.MEDIA_UPLOAD,
        entity: 'media',
        entityId: media.id,
        payload: {
          slug: media.slug,
          filename: media.filename,
          mimeType: media.mimeType,
          sizeBytes: media.sizeBytes,
        },
        ip: actor?.ip ?? null,
      });

      return media;
    },

    /**
     * @param {string} id Validated positive BIGINT decimal string.
     * @returns {Promise<object>} Asset including `bytes`.
     * @throws {NotFoundError} When no row has that id.
     */
    async getMediaById(id) {
      const media = await mediaRepository.findMediaById(id);
      if (!media) throw new NotFoundError(NOT_FOUND_MESSAGE);
      return media;
    },

    /**
     * @param {string} slug
     * @returns {Promise<object>} Asset including `bytes`.
     * @throws {NotFoundError} When the slug is malformed or absent.
     */
    async getMediaBySlug(slug) {
      if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
        throw new NotFoundError(NOT_FOUND_MESSAGE);
      }
      const media = await mediaRepository.findMediaBySlug(slug);
      if (!media) throw new NotFoundError(NOT_FOUND_MESSAGE);
      return media;
    },
  };
}
