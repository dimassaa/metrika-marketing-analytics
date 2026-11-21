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
 * Runs `fn` inside a single transaction, passing it the checked-out client so every statement shares one
 * connection. Rolls back when `fn` throws and always returns the client to the pool.
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
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
