import 'dotenv/config';
import { z } from 'zod';

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/.+/, 'must be a postgres:// connection string');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: postgresUrl,
  // Only integration tests need it, so a development-only .env may omit it. Task 2 uses it for the test pool.
  TEST_DATABASE_URL: postgresUrl.optional(),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  APP_URL: z.url('must be a valid URL'),
  COOKIE_SECURE: z.enum(['true', 'false']).transform((value) => value === 'true'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
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
 *   logLevel: string,
 * }}
 * @throws {Error} When a variable is missing or invalid; the message names every offending key.
 */
export function parseEnv(source) {
  const result = envSchema.safeParse(source);
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
    logLevel: data.LOG_LEVEL,
  };
}

export const env = parseEnv(process.env);
