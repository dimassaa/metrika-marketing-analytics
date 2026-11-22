import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Shared connection pool. Tests never import it: `createApp` takes the database as an argument, and integration
 * tests build their own pool against TEST_DATABASE_URL (Task 2).
 * An idle client losing its connection emits an error; without a listener Node would crash the process.
 */
export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10 });

pool.on('error', (error) => {
  logger.error({ err: error }, 'idle database client failed');
});

/**
 * Runs a parameterized query on the shared pool.
 * @param {string} text SQL with `$1`-style placeholders.
 * @param {unknown[]} [params]
 */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Runs `fn` inside a single transaction on the given pool, passing it the checked-out client so every statement
 * shares one connection. The database is injected rather than the module-level pool: integration tests pass their
 * own pool, and production passes the shared one.
 *
 * Rolls back when `fn` throws. A rollback failure is attached as `cause` instead of replacing the original error,
 * because the statement that broke the transaction is the useful diagnostic.
 *
 * @template T
 * @param {{ connect: () => Promise<import('pg').PoolClient> }} db
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(db, fn) {
  if (!db || typeof db.connect !== 'function') {
    throw new TypeError('withTransaction requires a pool-like db with a connect() method');
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Keep the original failure in front; the rollback failure is context, not the story.
      error.cause ??= rollbackError;
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Cheap liveness probe for the database.
 * @returns {Promise<true>}
 * @throws When the database is unreachable.
 */
export async function pingDb() {
  await pool.query('SELECT 1');
  return true;
}

/** Closes the pool so the process can exit gracefully. */
export async function closeDb() {
  await pool.end();
}
