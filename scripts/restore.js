#!/usr/bin/env node
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import {
  BackupError,
  BackupUsageError,
  assertKeyFileMode,
  assertRestoreTarget,
  childConnection,
  childEnvironment,
  decryptDump,
  loadBackupKey,
  quoteIdentifier,
  redactConnectionString,
  validateDatabaseName,
} from './lib/backup-format.js';

/**
 * Restores an encrypted backup into a scratch database.
 *
 * Safety order matters: the target identifier is validated and the target is compared with `DATABASE_URL` before
 * any socket is opened; the archive is authenticated before a scratch database is created; and the decrypted dump
 * lives in a 0700 temp directory that is removed in `finally`.
 */

const DEFAULT_ADMIN_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/postgres';
const DEFAULT_RESTORE_DATABASE = 'metrika_restore_check';
const VERIFIED_TABLES = [
  'users',
  'channels',
  'campaigns',
  'customers',
  'orders',
  'daily_stats',
  'audit_log',
];
const MAX_CHILD_OUTPUT = 64 * 1024;
const STALE_RESTORE_DIR_MS = 24 * 60 * 60 * 1000;

const USAGE = [
  'Использование: node scripts/restore.js --file PATH [--database NAME] [--create] [--verify] [--force] [--allow-loose-key]',
  '',
  '  --file PATH        зашифрованный файл metrika-*.dump.enc (обязательно)',
  `  --database NAME    целевая база, по умолчанию ${DEFAULT_RESTORE_DATABASE}`,
  '  --create           создать базу через ADMIN_DATABASE_URL, если её нет',
  '  --verify           сравнить row-count + key checksum с DATABASE_URL',
  '  --force            разрешить восстановление в базу из DATABASE_URL (разрушительно)',
  '  --allow-loose-key  разрешить файл ключа с правами шире 0600 (POSIX)',
  '',
  'Переменные: DATABASE_URL, BACKUP_KEY_FILE или BACKUP_KEY, ADMIN_DATABASE_URL,',
  'RESTORE_TMP_DIR, PG_RESTORE.',
].join('\n');

/**
 * @param {string[]} argv
 * @returns {{
 *   file: string | null, database: string, create: boolean, verify: boolean, force: boolean,
 *   allowLooseKey: boolean, help: boolean,
 * }}
 * @throws {BackupUsageError}
 */
function parseArgs(argv) {
  const result = {
    file: null,
    database: DEFAULT_RESTORE_DATABASE,
    create: false,
    verify: false,
    force: false,
    allowLooseKey: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }
    if (argument === '--create' || argument === '--verify' || argument === '--force') {
      result[argument.slice(2)] = true;
      continue;
    }
    if (argument === '--allow-loose-key') {
      result.allowLooseKey = true;
      continue;
    }

    let name = argument;
    let inlineValue;
    if (argument.startsWith('--') && argument.includes('=')) {
      [name, inlineValue] = argument.split(/=(.*)/s);
    }
    if (name !== '--file' && name !== '--database') {
      throw new BackupUsageError(`Неизвестный аргумент: ${argument}\n\n${USAGE}`);
    }
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) index += 1;
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new BackupUsageError(`Для ${name} требуется значение.\n\n${USAGE}`);
    }

    if (name === '--file') result.file = value;
    else result.database = value;
  }

  return result;
}

/**
 * @param {string} connectionString
 * @param {string} databaseName
 * @returns {string} Same connection options with the database part replaced.
 */
function withDatabase(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/**
 * Removes `metrika-restore-*` directories older than a day. A killed restore or a power loss can leave the
 * decrypted dump behind; the `finally` cleanup cannot run in those cases. The age threshold prevents deleting a
 * concurrent restore's working directory, and only the exact prefix under `RESTORE_TMP_DIR` is touched.
 *
 * @param {string} root
 * @param {{ now?: number, maxAgeMs?: number }} [options]
 * @returns {Promise<void>}
 */
async function cleanStaleRestoreDirs(root, { now = Date.now(), maxAgeMs = STALE_RESTORE_DIR_MS } = {}) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Внимание: не удалось проверить ${root}: ${error.message}`);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('metrika-restore-')) continue;
    const directory = join(root, entry.name);
    try {
      const info = await stat(directory);
      if (now - info.mtimeMs < maxAgeMs) continue;
      await rm(directory, { recursive: true, force: true });
      console.log(`Удалён устаревший временный каталог: ${directory}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Внимание: не удалось удалить ${directory}: ${error.message}`);
      }
    }
  }
}

/**
 * Creates the scratch database when `--create` was passed. An existing database is reused: `pg_restore --clean`
 * removes the objects it is about to recreate, but it never drops the database itself.
 *
 * @param {{ name: string, adminUrl: string }} options
 * @throws {BackupUsageError | BackupError}
 */
async function ensureScratchDatabase({ name, adminUrl }) {
  const connection = childConnection(adminUrl);
  const client = new pg.Client({
    connectionString: connection.connectionString,
    ...(connection.password ? { password: connection.password } : {}),
  });
  try {
    await client.connect();
  } catch (error) {
    throw new BackupError(
      'Не удалось подключиться к ADMIN_DATABASE_URL: ' +
        `${redactConnectionString(error.message, adminUrl)}. Для --create нужна роль с правом CREATEDB.`,
      { cause: error },
    );
  }

  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (existing.rowCount === 1) {
      console.log(`База "${name}" уже существует — восстанавливаем в неё.`);
      return;
    }

    try {
      await client.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
      console.log(`Создана scratch-база "${name}".`);
    } catch (error) {
      if (error.code === '42P04') {
        console.log(`База "${name}" уже существует — восстанавливаем в неё.`);
        return;
      }
      if (error.code === '42501') {
        throw new BackupUsageError(
          `Роль из ADMIN_DATABASE_URL не может создать базу "${name}" (нет CREATEDB). ` +
            'Выдайте право или создайте базу вручную и запустите без --create.',
          { cause: error },
        );
      }
      throw new BackupError(
        `Не удалось создать базу "${name}": ${redactConnectionString(error.message, adminUrl)}`,
        { cause: error },
      );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Runs `pg_restore --clean --if-exists` with an argument array (no shell). Both streams are captured so a failure
 * can name the child's own error without echoing the password.
 *
 * @param {{ binary: string, dumpPath: string, targetConnection: { connectionString: string, password: string | null }, databaseUrl: string }} options
 * @returns {Promise<void>}
 * @throws {BackupError}
 */
function runPgRestore({ binary, dumpPath, targetConnection, databaseUrl }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      binary,
      [
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-acl',
        '--dbname',
        targetConnection.connectionString,
        dumpPath,
      ],
      {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnvironment(targetConnection.password),
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_CHILD_OUTPUT) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_CHILD_OUTPUT) stderr += chunk;
    });

    child.once('error', (error) => {
      reject(
        new BackupError(
          `Не удалось запустить "${binary}": ${error.code ?? error.message}. Проверьте PG_RESTORE.`,
          { cause: error },
        ),
      );
    });
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const details = redactConnectionString(
        [stderr.trim(), stdout.trim()].filter(Boolean).join('\n'),
        databaseUrl,
      );
      reject(
        new BackupError(
          `pg_restore завершился с кодом ${code ?? '—'}${signal ? ` (${signal})` : ''}` +
            `${details ? `:\n${details}` : '.'}`,
        ),
      );
    });
  });
}

/**
 * Compares row counts and an order-independent id checksum for the tables that make the demo meaningful.
 *
 * @param {pg.Client} client
 * @param {string} table Already validated against the shared identifier regex.
 * @returns {Promise<{ rows: string, checksum: string }>}
 */
async function tableFingerprint(client, table) {
  const { rows } = await client.query(
    `SELECT count(*)::bigint AS rows,
            md5(coalesce(string_agg(id::text, ',' ORDER BY id), '')) AS checksum
       FROM ${quoteIdentifier(table)}`,
  );
  return { rows: rows[0].rows, checksum: rows[0].checksum };
}

/**
 * Prints a per-table table and throws when any count or checksum differs. This is a "row-count + key checksum"
 * check, not a byte-for-byte comparison of the whole database.
 *
 * @param {{
 *   sourceConnection: { connectionString: string, password: string | null },
 *   targetConnection: { connectionString: string, password: string | null },
 *   databaseUrl: string,
 * }} options
 * @returns {Promise<void>}
 * @throws {BackupError}
 */
async function verifyRestore({ sourceConnection, targetConnection, databaseUrl }) {
  const source = new pg.Client({
    connectionString: sourceConnection.connectionString,
    ...(sourceConnection.password ? { password: sourceConnection.password } : {}),
  });
  const target = new pg.Client({
    connectionString: targetConnection.connectionString,
    ...(targetConnection.password ? { password: targetConnection.password } : {}),
  });

  try {
    try {
      await source.connect();
      await target.connect();
    } catch (error) {
      throw new BackupError(
        'Не удалось подключиться для проверки: ' + redactConnectionString(error.message, databaseUrl),
        { cause: error },
      );
    }

    const report = [];
    for (const table of VERIFIED_TABLES) {
      const sourceFingerprint = await tableFingerprint(source, table);
      let targetFingerprint;
      try {
        targetFingerprint = await tableFingerprint(target, table);
      } catch (error) {
        if (error.code !== '42P01') throw error;
        targetFingerprint = { rows: '—', checksum: 'нет таблицы' };
      }
      report.push({ table, source: sourceFingerprint, target: targetFingerprint });
    }

    console.log('Таблица        строк   восстановлено   md5 (первые 12)');
    let ok = true;
    for (const row of report) {
      const rowsMatch = String(row.source.rows) === String(row.target.rows);
      const checksumMatch = row.source.checksum === row.target.checksum;
      if (!rowsMatch || !checksumMatch) ok = false;
      const short = row.source.checksum.slice(0, 12);
      console.log(
        `${row.table.padEnd(14)} ${String(row.source.rows).padStart(5)} ${String(row.target.rows).padStart(14)}   ` +
          `${short} ${rowsMatch && checksumMatch ? 'ok' : 'РАСХОЖДЕНИЕ'}`,
      );
    }

    if (!ok) {
      throw new BackupError(
        'Проверка row-count + key checksum не прошла: восстановленная база отличается от источника.',
      );
    }
    console.log(`Проверка row-count + key checksum: совпадает (${report.length} таблиц).`);
  } finally {
    await source.end().catch(() => {});
    await target.end().catch(() => {});
  }
}

/** @returns {Promise<void>} */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  // Validate before reading any connection setting: `bad;drop` and `Bad-Name` must fail without touching a socket.
  validateDatabaseName(args.database);

  if (!args.file) {
    throw new BackupUsageError(`Не указан --file.\n\n${USAGE}`);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new BackupUsageError('DATABASE_URL не задан. Заполните .env или переменные окружения.');
  }
  const { targetDatabase, sourceDatabase } = assertRestoreTarget({
    targetDatabase: args.database,
    databaseUrl,
    force: args.force,
  });

  const filePath = resolve(args.file);
  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch (error) {
    throw new BackupUsageError(`Файл бэкапа не найден: ${filePath}`, { cause: error });
  }
  if (!fileInfo.isFile()) {
    throw new BackupUsageError(`Указанный путь не является файлом: ${filePath}`);
  }

  const keyFile = process.env.BACKUP_KEY_FILE;
  await assertKeyFileMode(keyFile, { allowLooseKey: args.allowLooseKey });
  const key = await loadBackupKey({ source: process.env });

  const pgRestore = process.env.PG_RESTORE || 'pg_restore';
  const adminUrl = process.env.ADMIN_DATABASE_URL || DEFAULT_ADMIN_DATABASE_URL;
  const targetUrl = withDatabase(databaseUrl, targetDatabase);
  const sourceConnection = childConnection(databaseUrl);
  const targetConnection = childConnection(targetUrl);
  const tempRoot = process.env.RESTORE_TMP_DIR || tmpdir();

  if (args.verify && targetDatabase === sourceDatabase) {
    console.warn(
      'Внимание: --force с целью, совпадающей с DATABASE_URL, и --verify сравнивает живую базу с самой собой; ' +
        'такая проверка всегда зелёная и не подтверждает корректность восстановления.',
    );
  }

  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  await cleanStaleRestoreDirs(tempRoot);
  const workDir = await mkdtemp(join(tempRoot, 'metrika-restore-'));
  try {
    const dumpPath = join(workDir, 'backup.dump');
    console.log(`Расшифровка ${filePath} → временный файл 0600 в ${workDir}`);
    await decryptDump({ filePath, key, outputPath: dumpPath });

    if (args.create) {
      await ensureScratchDatabase({ name: targetDatabase, adminUrl });
    }

    console.log(
      `pg_restore → база "${targetDatabase}" (${targetDatabase === sourceDatabase ? 'источник DATABASE_URL' : `источник ${sourceDatabase}`})`,
    );
    await runPgRestore({ binary: pgRestore, dumpPath, targetConnection, databaseUrl });

    if (args.verify) {
      await verifyRestore({ sourceConnection, targetConnection, databaseUrl });
    }

    console.log(`Восстановление завершено: база "${targetDatabase}".`);
    if (args.create) {
      console.log(`Scratch-база оставлена для проверки; удалить: dropdb ${targetDatabase}`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch((error) => {
      // The decrypted dump is the one artefact that must not survive; say so loudly if cleanup fails.
      console.warn(`Внимание: не удалось удалить временный каталог ${workDir}: ${error.message}`);
    });
  }
}

try {
  await main();
} catch (error) {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const adminUrl = process.env.ADMIN_DATABASE_URL ?? '';
  const message = redactConnectionString(
    redactConnectionString(error.message, databaseUrl),
    adminUrl,
  );
  console.error(`Восстановление не выполнено: ${message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exitCode = 1;
}
