/**
 * Base class for expected application failures. The central error handler answers with `statusCode` and `code`
 * instead of a generic 500; unexpected errors stay non-operational and their message is never sent to the client.
 */
export class AppError extends Error {
  /**
   * @param {string} message Human-readable reason; safe to expose for 4xx errors.
   * @param {{ statusCode?: number, code?: string, isOperational?: boolean, cause?: unknown }} [options]
   */
  constructor(message, { statusCode = 500, code = 'INTERNAL_ERROR', isOperational = true, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Некорректные данные', options = {}) {
    super(message, { ...options, statusCode: 400, code: 'VALIDATION_ERROR' });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Требуется вход', options = {}) {
    super(message, { ...options, statusCode: 401, code: 'UNAUTHORIZED' });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Недостаточно прав', options = {}) {
    super(message, { ...options, statusCode: 403, code: 'FORBIDDEN' });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Не найдено', options = {}) {
    super(message, { ...options, statusCode: 404, code: 'NOT_FOUND' });
  }
}
