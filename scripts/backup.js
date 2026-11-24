#!/usr/bin/env node
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import {
  BackupError,
  BackupUsageError,
  backupFileName,
  encryptDump,
  loadBackupKey,
  pruneBackups,
  redactConnectionString,
  warnIfKeyFileIsLoose,
} from './lib/backup-format.js';

/**
 * Creates one encrypted backup of `DATABASE_URL` and applies the retention policy.
 *
 * Everything is passed to child processes as an argument array with `shell: false`; no redirection or shell
 * expansion is involved, which is what makes the same code safe on Linux and Windows. The password never appears
 * in output because every embedded child stderr is redacted with the connection string's own password.
 */

const USAGE = [
  'Использование: node scripts/backup.js [--keep N] [--out PATH]',
  '',
  '  --keep N   сколько последних бэкапов сохранять независимо от возраста (по умолчанию 1)',
  '  --out PATH записать в конкретный файл и не применять retention',
  '',
  'Переменные: DATABASE_URL, BACKUP_KEY_FILE или BACKUP_KEY, BACKUP_DIR,',
  'BACKUP_RETENTION_DAYS, PG_DUMP.',
].join('\n');

/**
 * @param {string[]} argv
 * @returns {{ keep: number, out: string | null, help: boolean }}
 * @throws {BackupUsageError}
 */
function parseArgs(argv) {
  const result = { keep: 1, out: null, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }

    let name = argument;
    let inlineValue;
    if (argument.startsWith('--') && argument.includes('=')) {
      [name, inlineValue] = argument.split(/=(.*)/s);
    }

    if (name !== '--keep' && name !== '--out') {
      throw new BackupUsageError(`Неизвестный аргумент: ${argument}\n\n${USAGE}`);
    }
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) index += 1;
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new BackupUsageError(`Для ${name} требуется значение.\n\n${USAGE}`);
    }

    if (name === '--keep') {
      const keep = Number(value);
      if (!Number.isInteger(keep) || keep < 1) {
        throw new BackupUsageError('--keep должен быть целым числом не меньше 1.');
      }
      result.keep = keep;
    } else {
      result.out = value;
    }
  }

  return result;
}

/**
 * Runs a small command and returns its output.
 * @param {string} binary
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function capture(binary, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
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
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/**
 * @param {string} binary
 * @returns {Promise<{ version: string, major: number }>}
 * @throws {BackupError}
 */
async function binaryVersion(binary) {
  let result;
  try {
    result = await capture(binary, ['--version']);
  } catch (error) {
    throw new BackupError(
      `Не удалось запустить "${binary}": ${error.code ?? error.message}. Укажите путь в PG_DUMP.`,
      { cause: error },
    );
  }
  if (result.code !== 0) {
    throw new BackupError(`"${binary} --version" завершился с кодом ${result.code}: ${result.stderr.trim()}`);
  }
  const version = result.stdout.trim().split('\n')[0];
  const match = version.match(/(\d+)\./);
  if (!match) throw new BackupError(`Не удалось разобрать версию "${binary}": ${version}`);
  return { version, major: Number(match[1]) };
}

/**
 * @param {string} databaseUrl
 * @returns {Promise<{ version: string, major: number }>}
 * @throws {BackupError}
 */
async function serverVersion(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT current_setting('server_version') AS version,
              current_setting('server_version_num') AS number`,
    );
    return { version: rows[0].version, major: Math.floor(Number(rows[0].number) / 10000) };
  } catch (error) {
    throw new BackupError(
      `Не удалось подключиться к базе из DATABASE_URL: ${redactConnectionString(error.message, databaseUrl)}`,
      { cause: error },
    );
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Refuses to dump a server newer than the client: the resulting archive could use features the local pg_restore
 * cannot read. The reverse direction is only a warning because a newer client writes an archive the server's own
 * pg_restore can usually still read.
 *
 * @param {{ version: string, major: number }} dump
 * @param {{ version: string, major: number }} server
 */
function assertDumpDirection(dump, server) {
  if (dump.major < server.major) {
    throw new BackupError(
      `pg_dump ${dump.version} старше сервера PostgreSQL ${server.version}. Дамп может быть несовместим; ` +
        'установите клиент той же или более новой мажорной версии и повторите запуск.',
    );
  }
  if (dump.major > server.major) {
    console.warn(
      `Внимание: pg_dump ${dump.version} новее сервера PostgreSQL ${server.version}. ` +
        'Архив будет создан; для восстановления понадобится pg_restore не старше клиента.',
    );
  }
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КиБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МиБ`;
}

/**
 * @param {string | undefined} raw
 * @returns {number}
 * @throws {BackupUsageError}
 */
function parseRetentionDays(raw) {
  const days = Number(raw ?? 7);
  if (!Number.isFinite(days) || days < 0) {
    throw new BackupUsageError(`BACKUP_RETENTION_DAYS должен быть неотрицательным числом, получено "${raw}".`);
  }
  return days;
}

/**
 * @param {string} connectionString
 * @returns {string}
 */
function databaseName(connectionString) {
  return new URL(connectionString).pathname.replace(/^\//, '');
}

/** @returns {Promise<void>} */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new BackupUsageError('DATABASE_URL не задан. Заполните .env или переменные окружения.');
  }

  // Validate retention before touching the database or spawning pg_dump: a typo must fail the run, not leave a
  // fresh file behind with only a warning.
  const retentionDays = args.out ? null : parseRetentionDays(process.env.BACKUP_RETENTION_DAYS);

  const keyFile = process.env.BACKUP_KEY_FILE;
  const key = await loadBackupKey({ source: process.env });
  await warnIfKeyFileIsLoose(keyFile);

  const pgDump = process.env.PG_DUMP || 'pg_dump';
  const dumpVersion = await binaryVersion(pgDump);
  const database = await serverVersion(databaseUrl);
  assertDumpDirection(dumpVersion, database);
  console.log(`pg_dump ${dumpVersion.version}; сервер PostgreSQL ${database.version}; БД ${databaseName(databaseUrl)}`);

  const backupDir = resolve(process.env.BACKUP_DIR || './backups');
  const outputPath = args.out
    ? resolve(args.out)
    : join(backupDir, backupFileName(new Date()));

  // Encrypt into a staging name and publish it only after pg_dump exits cleanly, so a failed dump can never
  // replace an existing manual `--out` file with a partial archive.
  const stagedPath = `${outputPath}.staged`;

  const child = spawn(
    pgDump,
    ['--format=custom', '--no-owner', '--no-acl', '--dbname', databaseUrl],
    { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const closed = new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
  });

  const encryption = encryptDump({
    input: child.stdout,
    outputPath: stagedPath,
    key,
    meta: { database: databaseName(databaseUrl), pgDump: dumpVersion.version },
  });
  const outcome = encryption.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );

  let closeResult;
  try {
    closeResult = await closed;
  } catch (error) {
    child.stdout.destroy();
    await outcome;
    await rm(stagedPath, { force: true }).catch(() => {});
    throw new BackupError(
      `Не удалось запустить "${pgDump}": ${error.code ?? error.message}. Проверьте PG_DUMP.`,
      { cause: error },
    );
  }

  const encrypted = await outcome;
  if (closeResult.code !== 0) {
    child.stdout.destroy();
    await rm(stagedPath, { force: true }).catch(() => {});
    const details = redactConnectionString(stderr.trim(), databaseUrl);
    throw new BackupError(
      `pg_dump завершился с кодом ${closeResult.code ?? '—'}${closeResult.signal ? ` (${closeResult.signal})` : ''}` +
        `${details ? `:\n${details}` : '.'}`,
    );
  }
  if (!encrypted.ok) {
    await rm(stagedPath, { force: true }).catch(() => {});
    throw encrypted.error;
  }

  await rename(stagedPath, outputPath);
  console.log(`Бэкап создан: ${outputPath}`);
  console.log(
    `  размер: ${formatBytes(encrypted.value.bytesWritten)} (${encrypted.value.bytesPlaintext} байт дампа), ` +
      'AES-256-GCM, ключ из ' +
      (keyFile ? `файла ${keyFile}` : 'BACKUP_KEY'),
  );

  if (args.out) {
    console.log('Retention пропущен: указан --out.');
    return;
  }

  try {
    const { removed, kept } = await pruneBackups({
      dir: backupDir,
      retentionDays,
      keep: args.keep,
    });
    for (const file of removed) console.log(`Удалён старый бэкап: ${file}`);
    console.log(`Бэкапов в ${backupDir}: ${kept.length} (retention ${retentionDays} дн.)`);
  } catch (error) {
    // The backup itself is already safe on disk; a retention failure must not turn a good run into a failed one.
    console.warn(`Внимание: не удалось применить retention: ${error.message}`);
  }
}

try {
  await main();
} catch (error) {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const message = redactConnectionString(error.message, databaseUrl);
  console.error(`Бэкап не создан: ${message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exitCode = 1;
}
