import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { HTTP_LOG_SERIALIZERS, LOG_REDACT } from '../../src/lib/logger.js';

/** Collects parsed JSON lines so assertions read the object pino actually emitted, not a truncated string. */
function makeLogSink() {
  /** @type {Array<Record<string, any>>} */
  const entries = [];
  return {
    entries,
    destination: {
      write(line) {
        entries.push(JSON.parse(line));
      },
    },
  };
}

describe('HTTP log serializers', () => {
  it('keeps the session cookie, CSRF token and credentials out of the log line', () => {
    const { entries, destination } = makeLogSink();
    const logger = pino({ level: 'info', redact: LOG_REDACT, serializers: HTTP_LOG_SERIALIZERS }, destination);

    logger.info(
      {
        req: {
          id: 'req-1',
          method: 'POST',
          url: '/login',
          remoteAddress: '127.0.0.1',
          headers: {
            cookie: 'metrika.sid=s%3Asecret',
            authorization: 'Bearer super-secret-token',
            'x-csrf-token': 'csrf-secret-value',
            'user-agent': 'vitest',
          },
        },
        res: {
          statusCode: 302,
          headers: {
            'set-cookie': ['metrika.sid=s%3Asecret; Path=/; HttpOnly; SameSite=Lax'],
            'x-csrf-token': 'csrf-secret-value',
          },
        },
      },
      'request completed',
    );

    // Proof that redaction did not disable logging: the tracing fields survive. Everything a cookie or token
    // could hide in must be absent, including whole header names so a future default serializer change is caught.
    expect(entries).toHaveLength(1);
    const line = JSON.stringify(entries[0]);
    for (const secret of [
      'metrika.sid',
      'set-cookie',
      's%3Asecret',
      'super-secret-token',
      'csrf-secret-value',
      'authorization',
      'cookie',
    ]) {
      expect(line).not.toContain(secret);
    }

    expect(entries[0].req).toMatchObject({
      id: 'req-1',
      method: 'POST',
      url: '/login',
      remoteAddress: '127.0.0.1',
    });
    expect(entries[0].res).toEqual({ statusCode: 302 });
  });
});
