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
  it('rejects the example placeholder session secret in production', () => {
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: 'production',
        SESSION_SECRET: `replace-with-${'x'.repeat(32)}`,
        COOKIE_SECURE: 'true',
      }),
    ).toThrow(/SESSION_SECRET/);
  });
  it('rejects COOKIE_SECURE=false in production', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(
      /COOKIE_SECURE/,
    );
  });
  it('accepts a real production configuration', () => {
    expect(
      parseEnv({ ...base, NODE_ENV: 'production', SESSION_SECRET: 's'.repeat(32), COOKIE_SECURE: 'true' }),
    ).toMatchObject({ nodeEnv: 'production', cookieSecure: true });
  });
});
