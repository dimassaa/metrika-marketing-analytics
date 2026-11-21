import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { env } from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Advisory lock key shared by every process that runs migrations. Two concurrent deploys must not apply the
 * same file twice, so the whole run holds one session-level lock on a dedicated connection.
 */
const MIGRATION_LOCK_KEY = 742001;

/**
 * Applies pending SQL migrations from `db/migrations` in filename order.
 *
 * Each file runs inside its own transaction together with its `schema_migrations` row, so a failed migration
 * leaves neither partial schema nor a recorded version and can be retried after a fix. The runner is
 * idempotent: already applied versions are skipped and returned as an empty array.
 *
 * @param {{ connectionString: string }} options Target database; callers pass `env.databaseUrl` (CLI) or
 *   `env.testDatabaseUrl` (integration test helper).
 * @returns {Promise<string[]>} Filenames applied by this call, in application order.
 * @throws {Error} When the database is unreachable or a migration fails; the failing file's name is attached
 *   as the error message prefix.
 */
export async function runMigrations({ connectionString } = {}) {
  if (!connectionString) {
    throw new Error('runMigrations requires a connectionString');
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const alreadyApplied = new Set(rows.map((row) => row.version));

    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

    for (const file of files) {
      if (alreadyApplied.has(file)) continue;

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        error.message = `migration ${file} failed: ${error.message}`;
        throw error;
      }
      applied.push(file);
    }
  } finally {
    // The lock would also disappear with the connection, but an explicit unlock keeps the intent obvious
    // and lets a pooled caller reuse the client if this ever moves off a dedicated connection.
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch (error) {
      logger.error({ err: error }, 'failed to release migration advisory lock');
    }
    await client.end();
  }

  return applied;
}

// CLI entry point (`npm run migrate`). Guarded so importing the module in tests does not touch the dev database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const applied = await runMigrations({ connectionString: env.databaseUrl });
    if (applied.length === 0) {
      logger.info('database is up to date, nothing to apply');
    } else {
      for (const version of applied) logger.info(`applied ${version}`);
    }
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'migration run failed');
    process.exit(1);
  }
}
