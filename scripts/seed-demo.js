/**
 * Demo seeding for the container entrypoint.
 *
 * `seed()` truncates every demo table, including sessions and uploaded media, so it must never run against a stand
 * that already contains data. The guard checks the three tables that a real import fills first: `users`,
 * `channels` and `daily_stats`. Checking only `users` would erase imported channels and statistics on the next
 * container start; checking only one of them is not enough, because an import can populate any of the three first.
 */

import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { env } from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';
import { seed } from '../db/seed/seed.js';

/**
 * Counts the three tables that decide whether the stand is empty.
 *
 * `count(*)::int` keeps the driver's result a JavaScript number; the raw `bigint` would arrive as a string and force
 * a conversion at the comparison site. Table names are module constants, never input.
 *
 * @param {{ query: (text: string) => Promise<{ rows: Array<Record<string, number>> }> }} pool
 * @returns {Promise<{ users: number, channels: number, daily_stats: number }>}
 */
export async function countDemoRows(pool) {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM channels) AS channels,
      (SELECT count(*)::int FROM daily_stats) AS daily_stats
  `);
  return rows[0];
}

/**
 * Seeds only when all three guard tables are empty.
 *
 * `seedFn` is injected so unit tests never connect to a database; the CLI passes the real `seed`. A failure from the
 * count query or from the seed is propagated unchanged: the entrypoint then exits non-zero and Docker never marks a
 * half-seeded container healthy.
 *
 * @param {object} options
 * @param {{ query: Function }} options.pool Open pool owned by the caller.
 * @param {(args: { pool: object }) => Promise<unknown>} [options.seedFn]
 * @returns {Promise<{ seeded: boolean, counts: { users: number, channels: number, daily_stats: number } }>}
 */
export async function seedDemoIfEmpty({ pool, seedFn = seed } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('seedDemoIfEmpty requires a pool with a query() method');
  }

  const counts = await countDemoRows(pool);
  const empty = counts.users === 0 && counts.channels === 0 && counts.daily_stats === 0;
  if (!empty) return { seeded: false, counts };

  await seedFn({ pool });
  return { seeded: true, counts };
}

/**
 * CLI entry point used by `docker/entrypoint.sh`.
 *
 * The pool is created and closed here, so the guard and the seed share one connection budget and the process exits
 * with a clean handle even when the seed fails.
 */
async function main() {
  const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 1 });
  pool.on('error', (error) => logger.error({ err: error }, 'idle seed guard database client failed'));

  try {
    const { seeded, counts } = await seedDemoIfEmpty({ pool });
    if (seeded) {
      logger.info('demo stand was empty: seeded users, channels and daily stats');
    } else {
      logger.info(
        `demo stand already has data (users=${counts.users}, channels=${counts.channels}, ` +
          `daily_stats=${counts.daily_stats}); seeding skipped`,
      );
    }
  } finally {
    await pool.end();
  }
}

// Guarded so importing the module in tests never opens a pool or touches the database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    // No credentials or connection strings are logged: the error object carries the SQLSTATE and message only.
    logger.error({ err: error }, 'demo seed guard failed');
    process.exit(1);
  }
}
