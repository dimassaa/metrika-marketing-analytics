import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Defense-in-depth redaction. The HTTP serializers below already omit headers, so these paths never match in normal
 * operation; they stay in the config because a future `logger.info({ req })` call outside pino-http would otherwise
 * print a session cookie or a CSRF token verbatim.
 */
export const LOG_REDACT = {
  paths: [
    'req.headers.cookie',
    'req.headers.authorization',
    'req.headers["x-csrf-token"]',
    'res.headers["set-cookie"]',
    'res.headers["x-csrf-token"]',
    'password',
    '*.password',
  ],
  censor: '[redacted]',
};

/**
 * Serializers for `pino-http`.
 *
 * pino-http's defaults log every request and response header, which put the live `metrika.sid` cookie from
 * `set-cookie` and the `x-csrf-token` value into the log stream on every login. These serializers keep only the
 * fields needed for tracing a request and deliberately drop the whole header bag. pino-http wraps them, so the
 * request argument arrives pre-normalized by pino-std-serializers; the fallbacks cover plain pino and raw Node
 * objects too, which keeps the serializers testable without a server.
 */
export const HTTP_LOG_SERIALIZERS = {
  req(request) {
    return {
      id: request.id,
      method: request.method,
      url: request.url,
      remoteAddress: request.remoteAddress ?? request.socket?.remoteAddress,
      userAgent: request.headers?.['user-agent'],
    };
  },
  res(response) {
    return {
      statusCode: response.statusCode,
      ...(response.responseTime === undefined ? {} : { responseTime: response.responseTime }),
    };
  },
  err(error) {
    return {
      type: error.type ?? error.name,
      message: error.message,
      stack: error.stack,
    };
  },
};

/**
 * Application logger. Tests are silent so that assertion failures stay readable; every other environment uses
 * LOG_LEVEL. Cookies and credentials never reach the log stream.
 */
export const logger = pino({
  level: env.nodeEnv === 'test' ? 'silent' : env.logLevel,
  redact: LOG_REDACT,
});
