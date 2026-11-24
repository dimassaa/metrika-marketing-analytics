import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { resetTestDatabase } from '../helpers/db.js';
import { env } from '../../src/config/env.js';

/**
 * End-to-end backup/restore against the real test database. The test is skipped with an explicit console warning
 * when PostgreSQL client binaries or the admin role are unavailable, so a missing dependency is never reported as a
 * silent green run.
 */
const ROOT = process.cwd();
const PG_DUMP = process.env.PG_DUMP || 'pg_dump';
const PG_RESTORE = process.env.PG_RESTORE || 'pg_restore';
const DEFAULT_ADMIN_URL = 'postgres://postgres:postgres@localhost:5432/postgres';
const ADMIN_URL = process.env.ADMIN_DATABASE_URL || DEFAULT_ADMIN_URL;
const SAFE_DATABASE_NAME = /^[a-z][a-z0-9_]*$/;

/** @type {string | null} */
let skipReason = null;

/**
 * The database name from a `postgres://` URL.
 * @param {string} connectionString
 * @returns {string}
 */
function databaseName(connectionString) {
  return new URL(connectionString).pathname.replace(/^\//, '');
}

for (const [label, binary] of [
  ['pg_dump', PG_DUMP],
  ['pg_restore', PG_RESTORE],
]) {
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    skipReason = `${label} is not available (${probe.error?.code ?? probe.status})`;
  }
}

if (!env.testDatabaseUrl) {
  skipReason = 'TEST_DATABASE_URL is not set';
}

if (!skipReason) {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await client.connect();
    const { rows } = await client.query(
      'SELECT rolsuper OR rolcreatedb AS can_create FROM pg_roles WHERE rolname = current_user',
    );
    if (!rows[0]?.can_create) {
      skipReason = `admin role from ADMIN_DATABASE_URL lacks CREATEDB (${ADMIN_URL.replace(/:[^:@/]*@/, ':***@')})`;
    }
  } catch (error) {
    skipReason = `ADMIN_DATABASE_URL is unreachable: ${error.message.replace(/:[^:@/]*@/, ':***@')}`;
  } finally {
    await client.end().catch(() => {});
  }
}

if (skipReason) {
  console.warn(`backup-restore integration: пропуск — ${skipReason}`);
}

/**
 * Runs a repository script with an isolated environment.
 * @param {string} script Repository-relative path.
 * @param {string[]} args
 * @param {Record<string, string>} environment
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runScript(script, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, script), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...environment },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Drops a scratch database and disconnects any leftover clients.
 * @param {string} name
 */
async function dropScratch(name) {
  if (!SAFE_DATABASE_NAME.test(name)) throw new Error(`unsafe scratch name: ${name}`);
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [name],
    );
    await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)}`);
  } finally {
    await client.end();
  }
}

/**
 * @param {string} name
 * @returns {Promise<boolean>}
 */
async function databaseExists(name) {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return rowCount === 1;
  } finally {
    await client.end();
  }
}

/** @param {string} dir @returns {Promise<string>} Key file path. */
async function writeKeyFile(dir) {
  const keyFile = join(dir, 'backup.key');
  await writeFile(keyFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  return keyFile;
}

/** @param {string} name @returns {string} */
function backupFile(dir, name) {
  return join(dir, name);
}

/**
 * Adds a password to the child URL when the local test URL has none. Local `trust`/peer auth ignores the value,
 * but it makes the argv assertion meaningful: the secret must appear only in `PGPASSWORD`, never in `ps`.
 *
 * @param {string} connectionString
 * @returns {string}
 */
function withReviewPassword(connectionString) {
  const url = new URL(connectionString);
  if (!url.password) url.password = 'review-secret';
  return url.toString();
}

/**
 * Writes a POSIX wrapper that records the argument list and whether PGPASSWORD was set, then execs the real binary.
 * The log contains only the argv and a boolean, never the password value.
 *
 * @param {string} filePath
 * @returns {Promise<void>}
 */
async function writeArgvWrapper(filePath) {
  const script = [
    '#!/bin/sh',
    'if [ -n "$PGPASSWORD" ]; then printf "PGPASSWORD_SET\\n" >> "$ARGV_LOG"; else printf "PGPASSWORD_UNSET\\n" >> "$ARGV_LOG"; fi',
    'printf "%s\\n" "$*" >> "$ARGV_LOG"',
    'exec "$REAL_BINARY" "$@"',
    '',
  ].join('\n');
  await writeFile(filePath, script, { mode: 0o755 });
}

const canTraceArgv = process.platform !== 'win32';
const testDatabase = env.testDatabaseUrl ? databaseName(env.testDatabaseUrl) : '';
const childDatabaseUrl = env.testDatabaseUrl ? withReviewPassword(env.testDatabaseUrl) : '';
const childPassword = childDatabaseUrl
  ? (() => {
      try {
        return decodeURIComponent(new URL(childDatabaseUrl).password);
      } catch {
        return new URL(childDatabaseUrl).password;
      }
    })()
  : '';
const restoreDatabase = `${testDatabase}_restore_check`;
const emptyRestoreDatabase = `${testDatabase}_restore_empty_check`;

let workDir = '';
let backupDir = '';
let keyFile = '';
let restoreTmpRoot = '';
let backupPath = '';
let dumpWrapper = '';
let restoreWrapper = '';
let dumpArgvLog = '';
let restoreArgvLog = '';

describe.skipIf(Boolean(skipReason))('backup and restore', () => {
  beforeAll(async () => {
    await resetTestDatabase();

    const seed = new pg.Client({ connectionString: env.testDatabaseUrl });
    await seed.connect();
    try {
      const user = await seed.query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ('backup-check@example.test', 'not-a-real-hash', 'Backup Check', 'admin')
         RETURNING id`,
      );
      const channel = await seed.query(
        `INSERT INTO channels (code, name, kind, target_cac_cents)
         VALUES ('backup_check', 'Проверка бэкапа', 'paid', 12345)
         RETURNING id`,
      );
      const campaign = await seed.query(
        `INSERT INTO campaigns (channel_id, code, name, status, started_on, budget_cents)
         VALUES ($1, 'backup_check', 'Проверка бэкапа', 'active', '2026-01-01', 500000)
         RETURNING id`,
        [channel.rows[0].id],
      );
      await seed.query(
        `INSERT INTO daily_stats (campaign_id, stat_date, impressions, clicks, leads, spend_cents)
         VALUES ($1, '2026-01-02', 1000, 50, 5, 12345)`,
        [campaign.rows[0].id],
      );
      const customer = await seed.query(
        `INSERT INTO customers (external_id, first_channel_id, first_campaign_id, acquired_at)
         VALUES ('backup-check-customer', $1, $2, '2026-01-02T10:00:00Z')
         RETURNING id`,
        [channel.rows[0].id, campaign.rows[0].id],
      );
      await seed.query(
        `INSERT INTO orders (external_id, customer_id, campaign_id, occurred_at, revenue_cents, margin_cents)
         VALUES ('backup-check-order', $1, $2, '2026-01-03T11:00:00Z', 25000, 9000)`,
        [customer.rows[0].id, campaign.rows[0].id],
      );
      await seed.query(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, payload)
         VALUES ($1, 'backup.check', 'system', 'backup', '{"test":true}'::jsonb)`,
        [user.rows[0].id],
      );
    } finally {
      await seed.end();
    }

    workDir = await mkdtemp(join(tmpdir(), 'metrika-backup-restore-'));
    backupDir = join(workDir, 'backups');
    restoreTmpRoot = join(workDir, 'restore-tmp');
    await writeFile(join(workDir, '.keep'), '');

    if (canTraceArgv) {
      dumpWrapper = join(workDir, 'pg_dump-wrapper.sh');
      restoreWrapper = join(workDir, 'pg_restore-wrapper.sh');
      dumpArgvLog = join(workDir, 'pg_dump-argv.log');
      restoreArgvLog = join(workDir, 'pg_restore-argv.log');
      await writeArgvWrapper(dumpWrapper);
      await writeArgvWrapper(restoreWrapper);
    }

    // backup.js creates BACKUP_DIR; restore.js creates RESTORE_TMP_DIR.
    keyFile = await writeKeyFile(workDir);

    const backup = await runScript('scripts/backup.js', [], {
      NODE_ENV: 'test',
      DATABASE_URL: childDatabaseUrl,
      BACKUP_KEY_FILE: keyFile,
      BACKUP_DIR: backupDir,
      BACKUP_RETENTION_DAYS: '30',
      PG_DUMP: dumpWrapper || PG_DUMP,
      REAL_BINARY: PG_DUMP,
      ARGV_LOG: dumpArgvLog,
    });
    if (backup.code !== 0) throw new Error(`backup failed:\n${backup.stdout}\n${backup.stderr}`);

    const files = (await readdir(backupDir)).filter((name) => name.endsWith('.dump.enc'));
    expect(files).toHaveLength(1);
    backupPath = join(backupDir, files[0]);
  }, 60_000);

  afterAll(async () => {
    await dropScratch(restoreDatabase).catch(() => {});
    await dropScratch(emptyRestoreDatabase).catch(() => {});
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it('restores the encrypted dump into a scratch database and passes row-count + key checksum', async () => {
    await dropScratch(restoreDatabase);

    const restore = await runScript(
      'scripts/restore.js',
      ['--file', backupPath, '--database', restoreDatabase, '--create', '--verify'],
      {
        NODE_ENV: 'test',
        DATABASE_URL: childDatabaseUrl,
        BACKUP_KEY_FILE: keyFile,
        ADMIN_DATABASE_URL: ADMIN_URL,
        RESTORE_TMP_DIR: restoreTmpRoot,
        PG_RESTORE: restoreWrapper || PG_RESTORE,
        REAL_BINARY: PG_RESTORE,
        ARGV_LOG: restoreArgvLog,
      },
    );

    expect(restore.code, `${restore.stdout}\n${restore.stderr}`).toBe(0);
    expect(restore.stdout).toMatch(/row-count \+ key checksum/);
    expect(restore.stdout).toMatch(/совпада/);

    if (canTraceArgv) {
      const logged = [await readFile(dumpArgvLog, 'utf8'), await readFile(restoreArgvLog, 'utf8')];
      for (const argv of logged) {
        expect(argv).toContain('PGPASSWORD_SET');
        expect(argv).toContain('--dbname');
        expect(argv).not.toContain(childPassword);
        expect(argv).not.toContain(encodeURIComponent(childPassword));
      }
    }

    const target = new pg.Client({
      connectionString: (() => {
        const url = new URL(env.testDatabaseUrl);
        url.pathname = `/${restoreDatabase}`;
        return url.toString();
      })(),
    });
    await target.connect();
    try {
      const { rows } = await target.query(
        `SELECT
           (SELECT count(*)::int FROM users) AS users,
           (SELECT count(*)::int FROM orders) AS orders,
           (SELECT revenue_cents FROM orders WHERE external_id = 'backup-check-order') AS revenue`,
      );
      expect(rows[0]).toEqual({ users: 1, orders: 1, revenue: '25000' });
    } finally {
      await target.end();
    }

    // The decrypted dump must not survive the run.
    expect(await readdir(restoreTmpRoot)).toEqual([]);

    await dropScratch(restoreDatabase);
    expect(await databaseExists(restoreDatabase)).toBe(false);
  }, 60_000);

  it('backs up and verifies an empty migrated database', async () => {
    await resetTestDatabase();
    await dropScratch(emptyRestoreDatabase);

    const emptyBackupPath = backupFile(backupDir, 'empty.dump.enc');
    const backup = await runScript('scripts/backup.js', ['--out', emptyBackupPath], {
      NODE_ENV: 'test',
      DATABASE_URL: childDatabaseUrl,
      BACKUP_KEY_FILE: keyFile,
      BACKUP_RETENTION_DAYS: '30',
      PG_DUMP,
    });
    expect(backup.code, `${backup.stdout}\n${backup.stderr}`).toBe(0);
    expect((await stat(emptyBackupPath)).size).toBeGreaterThan(0);

    const restore = await runScript(
      'scripts/restore.js',
      ['--file', emptyBackupPath, '--database', emptyRestoreDatabase, '--create', '--verify'],
      {
        NODE_ENV: 'test',
        DATABASE_URL: childDatabaseUrl,
        BACKUP_KEY_FILE: keyFile,
        ADMIN_DATABASE_URL: ADMIN_URL,
        RESTORE_TMP_DIR: restoreTmpRoot,
        PG_RESTORE,
      },
    );

    expect(restore.code, `${restore.stdout}\n${restore.stderr}`).toBe(0);
    expect(restore.stdout).toMatch(/row-count \+ key checksum/);

    await dropScratch(emptyRestoreDatabase);
    expect(await databaseExists(emptyRestoreDatabase)).toBe(false);
  }, 60_000);

  it('fails with exit code 1 when the encrypted copy is corrupted', async () => {
    const damagedPath = backupFile(backupDir, 'damaged.dump.enc');
    const raw = await readFile(backupPath);
    const damaged = Buffer.from(raw);
    // Flip a byte in the ciphertext region, leaving magic and header intact.
    damaged[damaged.length - 32] ^= 0xff;
    await writeFile(damagedPath, damaged);

    const restore = await runScript(
      'scripts/restore.js',
      ['--file', damagedPath, '--database', `${testDatabase}_tamper_check`, '--verify'],
      {
        NODE_ENV: 'test',
        DATABASE_URL: childDatabaseUrl,
        BACKUP_KEY_FILE: keyFile,
        ADMIN_DATABASE_URL: ADMIN_URL,
        RESTORE_TMP_DIR: restoreTmpRoot,
        PG_RESTORE,
      },
    );

    expect(restore.code).toBe(1);
    expect(`${restore.stdout}${restore.stderr}`).toMatch(/расшифр|повреж|ключ/i);
    expect(await databaseExists(`${testDatabase}_tamper_check`)).toBe(false);
  }, 30_000);
});
