import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform, pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { escapeIdentifier } from 'pg';

/**
 * Password-free, self-describing envelope around a `pg_dump -Fc` stream.
 *
 * Layout: `MAGIC` (8 bytes) + `uint32BE headerLength` + JSON header + ciphertext + 16-byte GCM tag.
 * The header is authenticated as AAD exactly as it is stored, so an attacker cannot swap the IV or algorithm
 * without failing authentication. It intentionally carries no database name, timestamp or tool version: those
 * are operational metadata, not something a dumped file should leak.
 */
export const MAGIC = Buffer.from([0x4d, 0x54, 0x52, 0x4b, 0x42, 0x4b, 0x31, 0x00]); // "MTRKBK1\0"
export const HEADER_VERSION = 1;
export const ALGORITHM = 'aes-256-gcm';
export const KEY_LENGTH = 32;
export const IV_LENGTH = 12;
export const TAG_LENGTH = 16;

const HEADER_FIELDS = ['alg', 'iv', 'v'];
const FILE_NAME_PATTERN = /^metrika-.*\.dump\.enc$/;
const SAFE_DATABASE_NAME = /^[a-z][a-z0-9_]*$/;
const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
const BASE64_KEY_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const PLACEHOLDER_KEY_PATTERN = /^replace-with-/i;
const DAY_MS = 24 * 60 * 60 * 1000;

const streamPipeline = promisify(pipeline);

/** Base class so callers can catch every backup-specific failure without matching message text. */
export class BackupError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The file is not a valid encrypted Metrika backup, or authentication failed. */
export class BackupFormatError extends BackupError {}

/** The key is missing, malformed, a placeholder or not exactly 32 bytes. */
export class BackupKeyError extends BackupError {}

/** The invocation would write somewhere unsafe or uses invalid arguments. */
export class BackupUsageError extends BackupError {}

/**
 * @param {Buffer} key
 * @throws {BackupKeyError} When the key is not exactly 32 bytes.
 */
export function assertBackupKey(key) {
  if (!Buffer.isBuffer(key)) {
    throw new BackupKeyError('Ключ бэкапа должен быть буфером из 32 байт.');
  }
  if (key.length !== KEY_LENGTH) {
    throw new BackupKeyError(`Ключ бэкапа должен быть ровно 32 байта, получено ${key.length}.`);
  }
}

/**
 * Parses the textual key format accepted by `BACKUP_KEY_FILE` and `BACKUP_KEY`: 64 hex characters or base64 of
 * exactly 32 bytes. The `.env.example` placeholder is rejected explicitly so a copied configuration cannot silently
 * encrypt backups with a well-known string.
 *
 * @param {string} text
 * @returns {Buffer}
 * @throws {BackupKeyError}
 */
export function parseBackupKey(text) {
  if (typeof text !== 'string') {
    throw new BackupKeyError('Ключ бэкапа должен быть строкой в hex или base64.');
  }
  const value = text.trim();
  if (value === '') {
    throw new BackupKeyError('Ключ бэкапа пуст.');
  }
  if (PLACEHOLDER_KEY_PATTERN.test(value)) {
    throw new BackupKeyError('Ключ бэкапа — плейсхолдер из .env.example. Сгенерируйте настоящий ключ.');
  }

  let bytes;
  if (HEX_KEY_PATTERN.test(value)) {
    bytes = Buffer.from(value, 'hex');
  } else if (BASE64_KEY_PATTERN.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    // Buffer.from is forgiving; compare canonical encodings so malformed padding cannot slip through as 32 bytes.
    if (decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
      throw new BackupKeyError('Ключ бэкапа не является корректным base64.');
    }
    bytes = decoded;
  } else {
    throw new BackupKeyError('Ключ бэкапа должен быть 64 hex-символа или base64 32 байт.');
  }

  assertBackupKey(bytes);
  return bytes;
}

/**
 * Loads the backup key from `BACKUP_KEY_FILE`, or from `BACKUP_KEY` for native runs where no file is available.
 * A key file wins over the environment variable so a stale shell export cannot override the mounted secret.
 *
 * The file mode is checked by the CLIs, not here: unit tests and Windows checkouts do not have meaningful POSIX
 * permission bits and should not fail on that alone.
 *
 * @param {{
 *   keyFile?: string,
 *   key?: string,
 *   source?: Record<string, string | undefined>,
 * }} [options]
 * @returns {Promise<Buffer>}
 * @throws {BackupKeyError}
 */
export async function loadBackupKey({ keyFile, key, source = process.env } = {}) {
  const file = keyFile ?? source.BACKUP_KEY_FILE;
  if (file) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      throw new BackupKeyError(`Не удалось прочитать файл ключа бэкапа "${file}": ${error.message}`, {
        cause: error,
      });
    }
    return parseBackupKey(text);
  }

  const inline = key ?? source.BACKUP_KEY;
  if (inline) return parseBackupKey(inline);

  throw new BackupKeyError(
    'Ключ бэкапа не задан: укажите BACKUP_KEY_FILE (рекомендуется) или BACKUP_KEY.',
  );
}

/**
 * Builds the UTC file name used by `npm run backup`. Colons are replaced because the same name must be valid on
 * Windows; the timestamp stays sortable.
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function backupFileName(date = new Date()) {
  const stamp = date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `metrika-${stamp}.dump.enc`;
}

/**
 * Enforces the key-file permission contract.
 *
 * POSIX: a key readable by group or others is refused, because the whole point of a key file is that only the
 * service account can read it. `--allow-loose-key` is the explicit override for a platform that cannot express
 * 0600. Windows has no meaningful POSIX mode bits, so the check degrades to a warning and the ACL must be verified
 * with `icacls` (docs/deployment.md §5.2).
 *
 * @param {string | undefined} keyFile
 * @param {{ allowLooseKey?: boolean, platform?: NodeJS.Platform }} [options] `platform` is injectable for tests.
 * @returns {Promise<void>}
 * @throws {BackupKeyError} On POSIX when the file is group/other accessible and the override is absent.
 */
export async function assertKeyFileMode(keyFile, { allowLooseKey = false, platform = process.platform } = {}) {
  if (!keyFile) return;

  let info;
  try {
    info = await stat(keyFile);
  } catch {
    // The caller reads the key next and reports a missing/unreadable file with a proper error.
    return;
  }

  if (platform === 'win32') {
    if (!allowLooseKey) {
      console.warn(
        `Внимание: на Windows права POSIX для "${keyFile}" не проверяются; ACL задайте через icacls ` +
          '(docs/deployment.md §5.2).',
      );
    }
    return;
  }

  const mode = info.mode & 0o777;
  if ((info.mode & 0o077) === 0) return;

  if (allowLooseKey) {
    console.warn(
      `Внимание: файл ключа "${keyFile}" доступен группе или остальным (${mode.toString(8)}), ` +
        'продолжаю из-за --allow-loose-key.',
    );
    return;
  }

  throw new BackupKeyError(
    `Файл ключа "${keyFile}" доступен группе или остальным (режим ${mode.toString(8)}). ` +
      'Выполните chmod 600 или передайте --allow-loose-key, если это осознанное решение.',
  );
}

/**
 * Splits a PostgreSQL URL into the password-free form safe for `argv`/`ps` and the decoded password for
 * `PGPASSWORD`. Child processes therefore never receive the password as a command-line argument.
 *
 * @param {string} connectionString
 * @returns {{ connectionString: string, password: string | null }}
 * @throws {BackupUsageError}
 */
export function childConnection(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new BackupUsageError('Строка подключения не является корректным URL.');
  }

  const encodedPassword = url.password;
  let password = null;
  if (encodedPassword) {
    try {
      password = decodeURIComponent(encodedPassword);
    } catch {
      // A malformed escape is still usable by libpq verbatim; it is better than dropping the credential.
      password = encodedPassword;
    }
  }
  url.password = '';
  return { connectionString: url.toString(), password };
}

/**
 * Builds the environment for `pg_dump`/`pg_restore`. The connection URLs and application secrets are removed so the
 * child cannot inherit the same password (or the backup key) through its environment; the credential it needs is
 * supplied only as `PGPASSWORD`.
 *
 * @param {string | null} password
 * @param {Record<string, string | undefined>} [source]
 * @returns {Record<string, string | undefined>}
 */
export function childEnvironment(password, source = process.env) {
  const environment = { ...source };
  for (const name of ['DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_DATABASE_URL', 'BACKUP_KEY', 'SESSION_SECRET']) {
    delete environment[name];
  }
  if (password) environment.PGPASSWORD = password;
  else delete environment.PGPASSWORD;
  return environment;
}

/**
 * Removes the password from a connection string before it can reach stdout or a log line.
 *
 * @param {string} text
 * @param {string} connectionString
 * @returns {string}
 */
export function redactConnectionString(text, connectionString) {
  try {
    const { password } = new URL(connectionString);
    return password ? text.split(password).join('***') : text;
  } catch {
    return text;
  }
}

/**
 * Validates a database identifier before it is interpolated anywhere. PostgreSQL folds unquoted names, so only
 * lowercase names that can be quoted verbatim are accepted; this also rejects URLs or SQL fragments.
 *
 * @param {string} name
 * @returns {string}
 * @throws {BackupUsageError}
 */
export function validateDatabaseName(name) {
  if (typeof name !== 'string' || !SAFE_DATABASE_NAME.test(name)) {
    throw new BackupUsageError(
      `Недопустимое имя базы данных "${String(name)}": разрешены только строчные латинские буквы, цифры и ` +
        'подчёркивания, первый символ — буква.',
    );
  }
  return name;
}

/**
 * Quotes an already validated identifier for SQL. Uses the driver's own `escapeIdentifier` so the backup scripts
 * follow the same quoting rules as the rest of the application.
 *
 * @param {string} name
 * @returns {string}
 */
export function quoteIdentifier(name) {
  validateDatabaseName(name);
  return escapeIdentifier(name);
}

/**
 * Refuses to restore into the database named by `DATABASE_URL` unless the operator explicitly passes `--force`.
 * The check runs before any connection is opened.
 *
 * @param {{ targetDatabase: string, databaseUrl: string, force?: boolean }} options
 * @returns {{ targetDatabase: string, sourceDatabase: string }}
 * @throws {BackupUsageError}
 */
export function assertRestoreTarget({ targetDatabase, databaseUrl, force = false }) {
  validateDatabaseName(targetDatabase);

  let sourceDatabase;
  try {
    sourceDatabase = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  } catch {
    throw new BackupUsageError('DATABASE_URL не является корректным URL или содержит неверное имя базы.');
  }
  if (!sourceDatabase) {
    throw new BackupUsageError('DATABASE_URL не содержит имя базы данных.');
  }

  if (targetDatabase === sourceDatabase && !force) {
    throw new BackupUsageError(
      `Цель восстановления совпадает с базой из DATABASE_URL ("${sourceDatabase}"). ` +
        'Восстановление с --clean удалит текущие объекты; повторите с --force, если это осознанное решение.',
    );
  }
  return { targetDatabase, sourceDatabase };
}

/**
 * Reads and validates the envelope header without decrypting the payload.
 *
 * @param {string} filePath
 * @returns {Promise<{
 *   header: { v: number, alg: string, iv: string },
 *   headerLength: number,
 *   headerBytes: Buffer,
 *   ciphertextOffset: number,
 *   ciphertextLength: number,
 *   fileSize: number,
 * }>}
 * @throws {BackupFormatError}
 */
export async function readHeader(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch (error) {
    throw new BackupFormatError(`Не удалось открыть файл бэкапа "${filePath}": ${error.message}`, { cause: error });
  }

  try {
    const { size } = await handle.stat();
    if (size < MAGIC.length + 4 + TAG_LENGTH) {
      throw new BackupFormatError('Файл слишком мал, чтобы быть резервной копией «Метрики».');
    }

    const prefix = Buffer.alloc(MAGIC.length + 4);
    const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
    if (prefixRead.bytesRead !== prefix.length || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new BackupFormatError('Файл не является резервной копией «Метрики»: неверная сигнатура.');
    }

    const headerLength = prefix.readUInt32BE(MAGIC.length);
    const payloadStart = MAGIC.length + 4;
    if (headerLength === 0) {
      throw new BackupFormatError('Повреждён заголовок бэкапа: пустая длина заголовка.');
    }
    if (headerLength > size - payloadStart - TAG_LENGTH) {
      throw new BackupFormatError('Повреждён заголовок бэкапа: длина заголовка больше размера файла.');
    }

    const headerBytes = Buffer.alloc(headerLength);
    const headerRead = await handle.read(headerBytes, 0, headerLength, payloadStart);
    if (headerRead.bytesRead !== headerLength) {
      throw new BackupFormatError('Повреждён заголовок бэкапа: прочитано меньше байт, чем заявлено.');
    }

    let header;
    try {
      header = JSON.parse(headerBytes.toString('utf8'));
    } catch {
      throw new BackupFormatError('Повреждён заголовок бэкапа: это не корректный JSON.');
    }
    if (header === null || typeof header !== 'object' || Array.isArray(header)) {
      throw new BackupFormatError('Повреждён заголовок бэкапа: ожидался JSON-объект.');
    }

    const fields = Object.keys(header).sort();
    if (fields.length !== HEADER_FIELDS.length || fields.some((field, index) => field !== HEADER_FIELDS[index])) {
      throw new BackupFormatError(
        `Повреждён заголовок бэкапа: ожидались поля ${HEADER_FIELDS.join(', ')}, получены ${fields.join(', ') || '—'}.`,
      );
    }
    if (header.v !== HEADER_VERSION) {
      throw new BackupFormatError(`Неподдерживаемая версия формата бэкапа: ${String(header.v)}.`);
    }
    if (header.alg !== ALGORITHM) {
      throw new BackupFormatError(`Неподдерживаемый алгоритм шифрования бэкапа: ${String(header.alg)}.`);
    }
    if (typeof header.iv !== 'string' || !BASE64_KEY_PATTERN.test(header.iv)) {
      throw new BackupFormatError('Повреждён заголовок бэкапа: IV не является base64.');
    }
    const iv = Buffer.from(header.iv, 'base64');
    if (iv.length !== IV_LENGTH || iv.toString('base64') !== header.iv) {
      throw new BackupFormatError('Повреждён заголовок бэкапа: IV должен быть 12 байт в base64.');
    }

    return {
      header,
      headerLength,
      headerBytes,
      ciphertextOffset: payloadStart + headerLength,
      ciphertextLength: size - payloadStart - headerLength - TAG_LENGTH,
      fileSize: size,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Normalises the three accepted `input` forms so the public API works both from a CLI pipe and from tests:
 * a Readable, a filesystem path, or a Buffer.
 *
 * @param {Readable | string | Buffer | Uint8Array} input
 * @returns {Readable}
 */
function toReadable(input) {
  if (input instanceof Readable) return input;
  if (typeof input === 'string') return createReadStream(input);
  if (input instanceof Uint8Array) {
    return Readable.from([Buffer.from(input)]);
  }
  throw new BackupUsageError('Входные данные бэкапа должны быть потоком, путём к файлу или буфером.');
}

/** @param {string} outputPath @returns {string} A sibling temp path that still ends in `.tmp`. */
function temporaryPath(outputPath) {
  const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`;
  return `${outputPath}.${suffix}.tmp`;
}

/**
 * Encrypts a dump stream into `outputPath` atomically. The plaintext is never buffered in full: bytes flow through
 * the cipher as they arrive, the header is written first and the GCM tag is appended last. On any failure the
 * temp file is removed and the previous `outputPath` (if it existed) is left untouched.
 *
 * @param {{
 *   input: Readable | string | Buffer | Uint8Array,
 *   outputPath: string,
 *   key: Buffer,
 *   meta?: Record<string, unknown>,
 * }} options `meta` is returned to the caller for logging; it is deliberately not stored in the file.
 * @returns {Promise<{ outputPath: string, bytesWritten: number, bytesPlaintext: number, iv: string, meta: Record<string, unknown> }>}
 * @throws {BackupKeyError | BackupFormatError | BackupUsageError}
 */
export async function encryptDump({ input, outputPath, key, meta = {} }) {
  assertBackupKey(key);
  if (typeof outputPath !== 'string' || outputPath === '') {
    throw new BackupUsageError('Не указан путь для зашифрованного бэкапа.');
  }

  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  const tempPath = temporaryPath(target);
  const source = toReadable(input);

  const iv = randomBytes(IV_LENGTH);
  const header = { v: HEADER_VERSION, alg: ALGORITHM, iv: iv.toString('base64') };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(MAGIC.length + 4);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt32BE(headerBytes.length, MAGIC.length);

  let plaintextBytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      plaintextBytes += chunk.length;
      callback(null, chunk);
    },
  });

  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(headerBytes);

  // A transform whose flush runs after the cipher has produced its final block, so `getAuthTag()` is complete and
  // the tag is literally the last 16 bytes of the file.
  const trailer = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
    flush(callback) {
      try {
        this.push(cipher.getAuthTag());
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });

  const sink = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
  sink.write(prefix);
  sink.write(headerBytes);

  try {
    await streamPipeline(source, counter, cipher, trailer, sink);
    await rename(tempPath, target);
    return {
      outputPath: target,
      bytesWritten: (await stat(target)).size,
      bytesPlaintext: plaintextBytes,
      iv: header.iv,
      meta,
    };
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    if (error instanceof BackupError) throw error;
    throw new BackupFormatError(`Не удалось зашифровать бэкап: ${error.message}`, { cause: error });
  }
}

/** @param {Error} error @returns {boolean} */
function isAuthenticationError(error) {
  return (
    error.code === 'ERR_OSSL_BAD_DECRYPT' ||
    error.code === 'ERR_CRYPTO_INVALID_AUTH_TAG' ||
    /authenticate|Unsupported state/i.test(error.message ?? '')
  );
}

/**
 * Decrypts a backup into `outputPath`, verifying the trailer tag after the whole ciphertext has been consumed.
 * The plaintext is written to a sibling `.tmp` file and renamed only after authentication succeeds, so a wrong key
 * or a tampered file never leaves a plausible-looking partial dump behind.
 *
 * @param {{ filePath: string, key: Buffer, outputPath: string }} options
 * @returns {Promise<{ outputPath: string, bytesWritten: number }>}
 * @throws {BackupKeyError | BackupFormatError}
 */
export async function decryptDump({ filePath, key, outputPath }) {
  assertBackupKey(key);
  if (typeof outputPath !== 'string' || outputPath === '') {
    throw new BackupUsageError('Не указан путь для расшифрованного бэкапа.');
  }

  const info = await readHeader(filePath);
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  const tempPath = temporaryPath(target);

  let tag;
  try {
    const handle = await open(filePath, 'r');
    try {
      tag = Buffer.alloc(TAG_LENGTH);
      const tagRead = await handle.read(tag, 0, TAG_LENGTH, info.fileSize - TAG_LENGTH);
      if (tagRead.bytesRead !== TAG_LENGTH) {
        throw new BackupFormatError('Повреждён трейлер бэкапа: тег GCM обрезан.');
      }
    } finally {
      await handle.close();
    }

    const iv = Buffer.from(info.header.iv, 'base64');
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(info.headerBytes);
    decipher.setAuthTag(tag);

    const ciphertext =
      info.ciphertextLength === 0
        ? Readable.from([])
        : createReadStream(filePath, {
            start: info.ciphertextOffset,
            end: info.ciphertextOffset + info.ciphertextLength - 1,
          });

    const sink = createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
    await streamPipeline(ciphertext, decipher, sink);
    await rename(tempPath, target);
    return { outputPath: target, bytesWritten: (await stat(target)).size };
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    if (error instanceof BackupError) throw error;
    if (isAuthenticationError(error)) {
      throw new BackupFormatError(
        'Не удалось расшифровать бэкап: неверный ключ или файл повреждён (не совпал тег GCM).',
        { cause: error },
      );
    }
    throw new BackupFormatError(`Не удалось расшифровать бэкап: ${error.message}`, { cause: error });
  }
}

/**
 * Applies the retention policy to a backup directory.
 *
 * Only regular files matching `metrika-*.dump.enc` are candidates; `README.txt`, manual copies and any other file
 * are never touched. A file is kept when it is among the `keep` newest entries or younger than `retentionDays`;
 * at least one backup always survives, even when every file is already expired.
 *
 * @param {{ dir: string, retentionDays?: number, keep?: number, now?: Date }} options
 * @returns {Promise<{ removed: string[], kept: string[] }>}
 * @throws {BackupUsageError}
 */
export async function pruneBackups({ dir, retentionDays = 7, keep = 1, now = new Date() }) {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new BackupUsageError('BACKUP_RETENTION_DAYS должен быть неотрицательным числом.');
  }
  if (!Number.isInteger(keep) || keep < 1) {
    throw new BackupUsageError('--keep должен быть целым числом не меньше 1.');
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: [], kept: [] };
    throw error;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !FILE_NAME_PATTERN.test(entry.name)) continue;
    const filePath = join(dir, entry.name);
    try {
      const info = await stat(filePath);
      candidates.push({ path: filePath, mtimeMs: info.mtimeMs, name: entry.name });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
  const cutoff = now.getTime() - retentionDays * DAY_MS;

  const removed = [];
  const kept = [];
  for (const [index, candidate] of candidates.entries()) {
    if (index < keep || candidate.mtimeMs >= cutoff) {
      kept.push(candidate.path);
      continue;
    }
    await unlink(candidate.path);
    removed.push(candidate.path);
  }

  return { removed, kept };
}
