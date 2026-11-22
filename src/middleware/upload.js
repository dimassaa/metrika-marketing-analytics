import multer from 'multer';
import { AppError, ValidationError } from '../lib/errors.js';

/** Upload cap fixed by the spec: 2 MB. A CSV above that is a data export, not a form upload. */
export const MAX_CSV_FILE_BYTES = 2 * 1024 * 1024;

/** Multipart envelope cap: a 2 MB file plus text fields and boundaries must still fit under 3 MB. */
export const MAX_MULTIPART_BODY_BYTES = 3 * 1024 * 1024;

/** Field name the import form and the island use for the file. */
export const CSV_FILE_FIELD = 'file';

/** Busboy's wording for a truncated or malformed multipart body; these are client errors, not server failures. */
const MALFORMED_MULTIPART = /unexpected end of form|unexpected end of multipart|malformed part header|boundary not found/i;

/**
 * Rejects a request whose declared body is larger than the multipart envelope before multer reads it.
 *
 * `Content-Length` is advisory (a chunked request omits it), so multer's own `fileSize` limit stays the hard guard;
 * this middleware only spares the server from buffering a clearly oversized body. The message matches the file limit
 * because that is the only part of the envelope a person controls.
 * @type {import('express').RequestHandler}
 */
export function rejectOversizedBody(req, res, next) {
  const declared = Number(req.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_MULTIPART_BODY_BYTES) {
    next(
      new AppError('Файл превышает допустимый размер 2 МБ', {
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
      }),
    );
    return;
  }
  next();
}

/**
 * Translates multer's own error codes into the application contract. Without this mapper an oversized file would
 * surface as a 500 and an unexpected field name as an unstyled Express error.
 *
 * Shared with the image uploader in T7 so both upload families answer with the same status codes.
 * @type {import('express').ErrorRequestHandler}
 */
export function mapMulterErrors(err, req, res, next) {
  if (!(err instanceof multer.MulterError)) {
    // Busboy reports a cut-off body (`Unexpected end of form`) as a plain Error. Left unmapped it would become an
    // opaque 500 for what is a broken client request.
    if (err instanceof Error && MALFORMED_MULTIPART.test(err.message)) {
      next(new ValidationError('Не удалось прочитать форму загрузки: файл повреждён или обрезан'));
      return;
    }
    next(err);
    return;
  }

  if (err.code === 'LIMIT_FILE_SIZE') {
    next(
      new AppError('Файл превышает допустимый размер 2 МБ', {
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
      }),
    );
    return;
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    next(new ValidationError('Неожиданное поле файла: ожидается «file»'));
    return;
  }

  if (err.code === 'LIMIT_FIELD_COUNT' || err.code === 'LIMIT_PART_COUNT') {
    next(new ValidationError('Слишком много полей в форме загрузки'));
    return;
  }

  if (err.code === 'LIMIT_FIELD_VALUE') {
    next(new ValidationError('Поле формы слишком длинное'));
    return;
  }

  if (err.code === 'LIMIT_FILE_COUNT') {
    next(new ValidationError('Можно загрузить только один файл'));
    return;
  }

  next(new ValidationError('Не удалось загрузить файл'));
}

/**
 * Builds the CSV upload chain for one route.
 *
 * Memory storage is intentional: the file is at most 2 MB, is parsed once and never stored on disk, so there is no
 * temporary file to clean up on a validation failure. The chain is returned as an array because the mapper must run
 * immediately after multer, before the controller.
 *
 * @returns {Array<import('express').RequestHandler | import('express').ErrorRequestHandler>}
 */
export function createCsvUploader() {
  const uploader = multer({
    storage: multer.memoryStorage(),
    // Every dimension is bounded: without explicit part/field limits a multipart body with thousands of tiny fields
    // can pin memory even though the file itself is small. `defParamCharset` decodes Cyrillic filenames that arrive
    // as raw UTF-8 bytes in the part header.
    limits: {
      fileSize: MAX_CSV_FILE_BYTES,
      files: 1,
      fields: 8,
      parts: 12,
      fieldSize: 8 * 1024,
    },
    defParamCharset: 'utf8',
  });

  return [rejectOversizedBody, uploader.single(CSV_FILE_FIELD), mapMulterErrors];
}
