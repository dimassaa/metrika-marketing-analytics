import { describe, it, expect } from 'vitest';
import { parseEnv } from '../../src/config/env.js';

const base = {
  NODE_ENV: 'test', PORT: '3000', DATABASE_URL: 'postgres://u@localhost/db',
  SESSION_SECRET: 'x'.repeat(32), APP_URL: 'http://localhost:3000',
  COOKIE_SECURE: 'false', LOG_LEVEL: 'info',
};

describe('parseEnv', () => {
  it('returns typed config', () => {
    expect(parseEnv(base)).toMatchObject({ port: 3000, cookieSecure: false, nodeEnv: 'test' });
  });
  it('rejects short session secret', () => {
    expect(() => parseEnv({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });
  it('rejects non-numeric port', () => {
    expect(() => parseEnv({ ...base, PORT: 'abc' })).toThrow(/PORT/);
  });
});
