import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Application logger. Tests are silent so that assertion failures stay readable; every other environment uses
 * LOG_LEVEL. Cookies and credentials never reach the log stream.
 */
export const logger = pino({
  level: env.nodeEnv === 'test' ? 'silent' : env.logLevel,
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'password', '*.password'],
    censor: '[redacted]',
  },
});
