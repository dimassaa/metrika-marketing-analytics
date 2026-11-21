import pg from 'pg';
import { env } from '../../src/config/env.js';
import { logger } from '../../src/lib/logger.js';
import { runMigrations } from '../../db/migrate.js';

/** @type {pg.Pool | null} */
let testPool = null;

/**
 * Resolves the database name from a connection string.
 * @param {string} connectionString
 * @returns {string} Database name without the leading slash.
 */
function databaseName(connectionString) {
  return new URL(connectionString).pathname.replace(/^\//, '');
}

/**
 * Refuses to wipe anything that is not the dedicated test database.
 *
 * `resetTestDatabase` drops the whole `public` schema, so a mis-set TEST_DATABASE_URL would destroy real data.
 * Both the environment and the database name must look like test, otherwise the helper aborts before touching
 * the database at all.
 *
 * @param {string | undefined} connectionString
 * @throws {Error} When NODE_ENV is not `test` or the target database is not a test database.
 */
function assertTestDatabase(connectionString) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`resetTestDatabase is only allowed with NODE_ENV=test, got "${process.env.NODE_ENV}"`);
  }
  if (!connectionString) {
    throw new Error('TEST_DATABASE_URL is not set');
  }
  const name = databaseName(connectionString);
  if (name !== 'metrika_test' && !name.endsWith('_test')) {
    throw new Error(`refusing to reset database "${name}": name must be metrika_test or end with _test`);
  }
}

/**
 * Lazily created pool for the test database. One pool per test process keeps connections cheap while
 * `fileParallelism: false` guarantees no two files mutate the schema at the same time.
 * @returns {pg.Pool}
 */
export function getTestPool() {
  if (!env.testDatabaseUrl) {
    throw new Error('TEST_DATABASE_URL is not set');
  }
  if (!testPool) {
    // Error text is part of the test contract (`/violates/`), and this host initialised PostgreSQL with
    // ru_RU.UTF-8. Pinning lc_messages per session keeps assertions identical on every developer machine.
    testPool = new pg.Pool({
      connectionString: env.testDatabaseUrl,
      max: 4,
      options: '-c lc_messages=C',
    });
    testPool.on('error', (error) => {
      logger.error({ err: error }, 'idle test database client failed');
    });
  }
  return testPool;
}

/**
 * Drops and recreates the `public` schema of the test database, then applies every migration.
 * This is the only supported way to get a known-empty database: TRUNCATE would leave schema drift behind
 * after a migration change.
 * @returns {Promise<string[]>} Migrations applied while recreating the schema.
 * @throws {Error} When the caller is not running tests or the target is not a test database.
 */
export async function resetTestDatabase() {
  assertTestDatabase(env.testDatabaseUrl);

  const pool = getTestPool();
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  return runMigrations({ connectionString: env.testDatabaseUrl });
}

/** Closes the test pool so Vitest can exit; the next `getTestPool()` call creates a fresh one. */
export async function closeTestPool() {
  if (!testPool) return;
  const pool = testPool;
  testPool = null;
  await pool.end();
}
