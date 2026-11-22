import multer from 'multer';
import { AppError, ValidationError } from '../lib/errors.js';

/** Upload cap fixed by the spec: 2 MB. A CSV above that is a data export, not a form upload. */
export const MAX_CSV_FILE_BYTES = 2 * 1024 * 1024;

/** Field name the import form and the island use for the file. */
export const CSV_FILE_FIELD = 'file';

/**
 * Translates multer's own error codes into the application contract. Without this mapper an oversized file would
 * surface as a 500 and an unexpected field name as an unstyled Express error.
 *
 * Shared with the image uploader in T7 so both upload families answer with the same status codes.
 * @type {import('express').ErrorRequestHandler}
 */
export function mapMulterErrors(err, req, res, next) {
  if (!(err instanceof multer.MulterError)) {
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
    limits: { fileSize: MAX_CSV_FILE_BYTES, files: 1 },
  });

  return [uploader.single(CSV_FILE_FIELD), mapMulterErrors];
}
