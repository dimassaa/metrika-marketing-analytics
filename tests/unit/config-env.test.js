import { describe, it, expect } from 'vitest';
import { isLoopbackUrl, parseEnv } from '../../src/config/env.js';

const base = {
  NODE_ENV: 'test', PORT: '3000', DATABASE_URL: 'postgres://u@localhost/db',
  SESSION_SECRET: 'x'.repeat(32), APP_URL: 'http://localhost:3000',
  COOKIE_SECURE: 'false', LOG_LEVEL: 'info',
};

/**
 * A valid production source with the placeholder secret already replaced. The demo cookie exception is opt-in, so
 * each case names exactly the variable it exercises instead of inheriting a permissive default.
 * @param {Record<string, string>} overrides
 */
function production(overrides = {}) {
  return {
    ...base,
    NODE_ENV: 'production',
    SESSION_SECRET: 's'.repeat(32),
    ...overrides,
  };
}

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
  it('defaults trust proxy to false', () => {
    expect(parseEnv(base).trustProxy).toBe(false);
  });
  it('parses TRUST_PROXY as a boolean, hop count or subnet list', () => {
    expect(parseEnv({ ...base, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(parseEnv({ ...base, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(parseEnv({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(parseEnv({ ...base, TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
  });
});

describe('boolean flags', () => {
  it('defaults DEMO_INSECURE_COOKIES, AUTO_SEED_DEMO and RUN_MIGRATIONS to false', () => {
    expect(parseEnv(base)).toMatchObject({
      demoInsecureCookies: false,
      autoSeedDemo: false,
      runMigrations: false,
    });
  });

  it('accepts only the exact strings true and false', () => {
    expect(
      parseEnv({
        ...base,
        COOKIE_SECURE: 'true',
        DEMO_INSECURE_COOKIES: 'true',
        AUTO_SEED_DEMO: 'false',
        RUN_MIGRATIONS: 'true',
      }),
    ).toMatchObject({
      cookieSecure: true,
      demoInsecureCookies: true,
      autoSeedDemo: false,
      runMigrations: true,
    });
  });

  it.each([
    ['DEMO_INSECURE_COOKIES', '0'],
    ['DEMO_INSECURE_COOKIES', '1'],
    ['DEMO_INSECURE_COOKIES', 'yes'],
    ['COOKIE_SECURE', '0'],
    ['COOKIE_SECURE', '1'],
    ['AUTO_SEED_DEMO', '1'],
    ['RUN_MIGRATIONS', '0'],
  ])('rejects %s=%s with a Russian message', (key, value) => {
    expect(() => parseEnv({ ...base, [key]: value })).toThrow(/только true или false/);
  });
});

describe('isLoopbackUrl', () => {
  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])(
    'accepts the exact loopback host in %s',
    (url) => {
      expect(isLoopbackUrl(url)).toBe(true);
    },
  );

  it.each([
    'http://localhost.evil.com',
    'http://127.0.0.1.evil.com',
    'http://[::1].evil.com',
    'http://192.168.1.10:3000',
    'not a url',
  ])('rejects the non-loopback host in %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });
});

describe('production demo cookie guard', () => {
  it('rejects COOKIE_SECURE=false without the demo flag', () => {
    expect(() => parseEnv(production({ COOKIE_SECURE: 'false' }))).toThrow(/COOKIE_SECURE/);
  });

  it('rejects the demo flag on a private network address', () => {
    expect(() =>
      parseEnv(
        production({
          COOKIE_SECURE: 'false',
          DEMO_INSECURE_COOKIES: 'true',
          APP_URL: 'http://192.168.1.10:3000',
        }),
      ),
    ).toThrow(/COOKIE_SECURE/);
  });

  it.each([
    'http://localhost.evil.com',
    'http://127.0.0.1.evil.com',
    'http://[::1].evil.com',
  ])('rejects the demo flag on the look-alike host %s', (appUrl) => {
    expect(() =>
      parseEnv(production({ COOKIE_SECURE: 'false', DEMO_INSECURE_COOKIES: 'true', APP_URL: appUrl })),
    ).toThrow(/COOKIE_SECURE/);
  });

  it.each([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
    'http://localhost:3000/app/dashboard',
  ])('accepts the demo flag on the exact loopback host %s', (appUrl) => {
    expect(
      parseEnv(production({ COOKIE_SECURE: 'false', DEMO_INSECURE_COOKIES: 'true', APP_URL: appUrl })),
    ).toMatchObject({ cookieSecure: false, demoInsecureCookies: true });
  });

  it('ignores the demo flag when the cookie is secure', () => {
    expect(
      parseEnv(
        production({
          COOKIE_SECURE: 'true',
          DEMO_INSECURE_COOKIES: 'true',
          APP_URL: 'https://metrika.example',
        }),
      ),
    ).toMatchObject({ cookieSecure: true });
  });

  it('accepts HTTPS with secure cookies without the demo flag', () => {
    expect(
      parseEnv(production({ COOKIE_SECURE: 'true', APP_URL: 'https://metrika.example' })),
    ).toMatchObject({ cookieSecure: true, demoInsecureCookies: false });
  });
});
