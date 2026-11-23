import 'dotenv/config';
import { z } from 'zod';

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/.+/, 'must be a postgres:// connection string');

/**
 * Booleans are parsed from exactly `true` or `false`.
 *
 * `0`/`1`/`yes` are rejected on purpose: the container entrypoint compares the same variables as strings, so a
 * value it reads as "not false" must mean the same thing as a value `env.js` reads as `true`. Accepting both
 * spellings would let the two layers disagree about whether migrations or seeding run.
 * @param {string} name Variable name used in the error message.
 */
function booleanFlag(name) {
  return z
    .enum(['true', 'false'], { error: `${name}: допустимо только true или false` })
    .default('false')
    .transform((value) => value === 'true');
}

/**
 * Maps the `TRUST_PROXY` string to the value Express accepts.
 *
 * `false` is the safe default: a directly reachable instance must ignore `X-Forwarded-For`, otherwise a client can
 * forge `req.ip` for the rate limiter and the audit journal. Behind a reverse proxy the operator opts in with a hop
 * count (`1`) or a subnet list; `true` trusts the whole chain and is only correct when the app is unreachable
 * directly.
 *
 * @param {string} value Raw environment value.
 * @returns {false | true | number | string} Value for `app.set('trust proxy', …)`.
 */
function parseTrustProxy(value) {
  const normalized = value.trim();
  const lowered = normalized.toLowerCase();
  if (lowered === '' || lowered === 'false') return false;
  if (lowered === 'true') return true;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return normalized;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: postgresUrl,
  // Only integration tests need it, so a development-only .env may omit it. Task 2 uses it for the test pool.
  TEST_DATABASE_URL: postgresUrl.optional(),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  APP_URL: z.url('must be a valid URL'),
  COOKIE_SECURE: booleanFlag('COOKIE_SECURE'),
  DEMO_INSECURE_COOKIES: booleanFlag('DEMO_INSECURE_COOKIES'),
  AUTO_SEED_DEMO: booleanFlag('AUTO_SEED_DEMO'),
  RUN_MIGRATIONS: booleanFlag('RUN_MIGRATIONS'),
  TRUST_PROXY: z.string().default('false').transform(parseTrustProxy),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

/** Hostnames that can only be reached from the machine itself. Exact equality, never a suffix test. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * True only when `APP_URL` names a loopback host exactly.
 *
 * `includes`/`endsWith` would accept `localhost.evil.com`, which resolves to a public address and would let the
 * demo-cookie exception reach a real deployment. `URL#hostname` keeps IPv6 brackets (`[::1]`) and strips the port.
 *
 * @param {string} value Absolute URL from `APP_URL`.
 * @returns {boolean}
 */
export function isLoopbackUrl(value) {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Production-only guards. `.env.example` is copied verbatim by most deploys, and its placeholder secret plus
 * `COOKIE_SECURE=false` would silently ship a guessable session key and a cookie that travels over plain HTTP.
 * Both are configuration mistakes rather than runtime warnings, so they stop the boot with a message naming the key.
 *
 * The one exception is the zero-edit Docker demo: `DEMO_INSECURE_COOKIES=true` is accepted only together with a
 * loopback `APP_URL`. A real deployment on HTTPS keeps `COOKIE_SECURE=true`; anything else fails closed.
 */
const PLACEHOLDER_SESSION_SECRET = /^replace-with-/;

const productionSchema = envSchema.superRefine((data, context) => {
  if (data.NODE_ENV !== 'production') return;
  if (PLACEHOLDER_SESSION_SECRET.test(data.SESSION_SECRET)) {
    context.addIssue({
      code: 'custom',
      path: ['SESSION_SECRET'],
      message: 'must be replaced with a real secret in production',
    });
  }
  if (data.COOKIE_SECURE === false && !(data.DEMO_INSECURE_COOKIES && isLoopbackUrl(data.APP_URL))) {
    context.addIssue({
      code: 'custom',
      path: ['COOKIE_SECURE'],
      message:
        'must be true in production unless DEMO_INSECURE_COOKIES=true is paired with a loopback APP_URL',
    });
  }
});

/**
 * Validates raw environment variables and maps them to the camelCase config object.
 *
 * Pure on purpose: module import has one side effect (`dotenv/config`), while tests pass their own source.
 *
 * @param {Record<string, string | undefined>} source Environment-like object, usually `process.env`.
 * @returns {{
 *   nodeEnv: 'development' | 'test' | 'production',
 *   port: number,
 *   databaseUrl: string,
 *   testDatabaseUrl: string | undefined,
 *   sessionSecret: string,
 *   appUrl: string,
 *   cookieSecure: boolean,
 *   demoInsecureCookies: boolean,
 *   autoSeedDemo: boolean,
 *   runMigrations: boolean,
 *   trustProxy: false | true | number | string,
 *   logLevel: string,
 * }}
 * @throws {Error} When a variable is missing or invalid; the message names every offending key.
 */
export function parseEnv(source) {
  const result = productionSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const data = result.data;
  return {
    nodeEnv: data.NODE_ENV,
    port: data.PORT,
    databaseUrl: data.DATABASE_URL,
    testDatabaseUrl: data.TEST_DATABASE_URL,
    sessionSecret: data.SESSION_SECRET,
    appUrl: data.APP_URL,
    cookieSecure: data.COOKIE_SECURE,
    demoInsecureCookies: data.DEMO_INSECURE_COOKIES,
    autoSeedDemo: data.AUTO_SEED_DEMO,
    runMigrations: data.RUN_MIGRATIONS,
    trustProxy: data.TRUST_PROXY,
    logLevel: data.LOG_LEVEL,
  };
}

export const env = parseEnv(process.env);
