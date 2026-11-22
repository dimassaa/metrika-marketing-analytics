import { ValidationError } from './errors.js';

/**
 * Request validation for controllers. One place turns a Zod failure into the app's 400 contract, so a controller
 * never leaks `ZodError` (whose `issues` and English default messages are implementation details) and never has to
 * repeat the status mapping.
 */

/** Shown when a schema falls back to Zod's default English message; the UI never displays English validation text. */
const FALLBACK_MESSAGE = 'Некорректный параметр запроса';

/**
 * @param {string} message Zod's first issue message.
 * @returns {boolean} True when the message is already localised for a person.
 */
function isRussian(message) {
  return /[А-Яа-яЁё]/.test(message);
}

/**
 * Parses a query object with a Zod schema, strict about the values the schema names.
 *
 * Only the first issue is surfaced: a person fills one field at a time, and a list of six Zod paths is noise in a
 * toast or a plain-text 400. The original `ZodError` travels as `cause` for logs and tests, but it is never the
 * thrown object, so callers cannot accidentally depend on Zod's shape.
 *
 * @template T
 * @param {import('zod').ZodType<T>} schema
 * @param {unknown} query `req.query` or a plain object in a unit test.
 * @returns {T} Parsed, transformed data.
 * @throws {ValidationError} 400 with a Russian message; `cause` is the `ZodError`.
 */
export function parseQuery(schema, query) {
  const result = schema.safeParse(query ?? {});
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const message = issue && isRussian(issue.message) ? issue.message : FALLBACK_MESSAGE;
  throw new ValidationError(message, { cause: result.error });
}
