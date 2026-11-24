import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  BackupFormatError,
  BackupKeyError,
  BackupUsageError,
  MAGIC,
  TAG_LENGTH,
  assertBackupKey,
  assertRestoreTarget,
  decryptDump,
  encryptDump,
  loadBackupKey,
  parseBackupKey,
  pruneBackups,
  readHeader,
  validateDatabaseName,
} from '../../scripts/lib/backup-format.js';

/**
 * Format-level tests deliberately avoid PostgreSQL: they pin the on-disk contract (magic, header, trailer tag,
 * atomic writes) and the key/retention/target rules that must fail before any connection is opened.
 */
const ROOT = process.cwd();
const KEY = Buffer.alloc(32, 0x2a);

/** @type {string} */
let workDir;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'metrika-backup-format-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Yields a buffer in fixed-size chunks so the implementation is exercised through a real stream rather than a
 * single in-memory blob.
 * @param {Buffer} buffer
 * @param {number} [size]
 * @returns {AsyncGenerator<Buffer>}
 */
async function* chunked(buffer, size = 64 * 1024) {
  for (let offset = 0; offset < buffer.length; offset += size) {
    yield buffer.subarray(offset, offset + size);
  }
}

/** @param {string} name @returns {string} */
function path(name) {
  return join(workDir, name);
}

/**
 * Encrypts bytes into a fresh file in the shared temp directory.
 * @param {Buffer} plaintext
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<string>} Encrypted file path.
 */
async function encryptToFile(plaintext, options = {}) {
  const outputPath = options.outputPath ?? path(`backup-${randomBytes(6).toString('hex')}.dump.enc`);
  await encryptDump({
    input: Readable.from(chunked(plaintext)),
    outputPath,
    key: options.key ?? KEY,
    meta: { database: 'metrika_test', createdAt: new Date().toISOString() },
  });
  return outputPath;
}

/**
 * Applies an in-place byte edit to a copy of the file.
 * @param {string} filePath
 * @param {(raw: Buffer) => void} mutate
 */
async function tamper(filePath, mutate) {
  const raw = await readFile(filePath);
  const edited = Buffer.from(raw);
  mutate(edited);
  await writeFile(filePath, edited);
}

/**
 * Rewrites the JSON header while keeping its byte length unchanged, so only authentication can reject it.
 * @param {string} filePath
 * @param {(header: { v: number, alg: string, iv: string }) => void} mutate
 */
async function tamperHeader(filePath, mutate) {
  const raw = await readFile(filePath);
  const headerLength = raw.readUInt32BE(MAGIC.length);
  const headerStart = MAGIC.length + 4;
  const header = JSON.parse(raw.subarray(headerStart, headerStart + headerLength).toString('utf8'));
  mutate(header);
  const nextHeader = Buffer.from(JSON.stringify(header), 'utf8');
  expect(nextHeader.length).toBe(headerLength);
  await writeFile(filePath, Buffer.concat([raw.subarray(0, headerStart), nextHeader, raw.subarray(headerStart + headerLength)]));
}

describe('round trip', () => {
  it('encrypts and decrypts a streamed dump byte for byte with 0600 files', async () => {
    const plaintext = randomBytes(1024 * 1024 + 137);
    const encryptedPath = await encryptToFile(plaintext);
    const decryptedPath = path('restored.dump');

    const info = await readHeader(encryptedPath);
    expect(info.ciphertextLength).toBeGreaterThan(0);

    await decryptDump({ filePath: encryptedPath, key: KEY, outputPath: decryptedPath });

    expect(await readFile(decryptedPath)).toEqual(plaintext);
    expect((await stat(encryptedPath)).mode & 0o777).toBe(0o600);
    expect((await stat(decryptedPath)).mode & 0o777).toBe(0o600);

    const leftovers = (await readdir(workDir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('handles an empty plaintext dump', async () => {
    const encryptedPath = await encryptToFile(Buffer.alloc(0));
    const decryptedPath = path('empty.dump');
    await decryptDump({ filePath: encryptedPath, key: KEY, outputPath: decryptedPath });
    expect((await stat(decryptedPath)).size).toBe(0);
  });

  it('writes ciphertext before the input stream ends (streaming, not whole-file buffering)', async () => {
    const streamDir = await mkdtemp(join(workDir, 'streaming-'));
    const outputPath = join(streamDir, 'streamed.dump.enc');
    const input = new Readable({ read() {} });
    const pending = encryptDump({ input, outputPath, key: KEY });

    input.push(Buffer.alloc(8192, 0x11));

    // The encrypted temp file must grow while the source is still open. A whole-file buffer would leave the
    // directory empty until `input` ends, which is exactly the failure this test is here to catch.
    let tempSize = 0;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && tempSize < 1000) {
      const name = (await readdir(streamDir)).find((entry) => entry.endsWith('.tmp'));
      if (name) tempSize = (await stat(join(streamDir, name))).size;
      if (tempSize < 1000) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(tempSize).toBeGreaterThan(1000);

    input.push(Buffer.alloc(8192, 0x22));
    input.push(null);
    await pending;

    const decryptedPath = join(streamDir, 'streamed.dump');
    await decryptDump({ filePath: outputPath, key: KEY, outputPath: decryptedPath });
    expect((await stat(decryptedPath)).size).toBe(16384);
  });
});

describe('file format', () => {
  it('writes exactly magic, uint32 header length, {v,alg,iv} and a detached 16-byte tag', async () => {
    const plaintext = Buffer.from('custom-format-dump-placeholder');
    const encryptedPath = await encryptToFile(plaintext);
    const raw = await readFile(encryptedPath);

    expect(raw.subarray(0, MAGIC.length)).toEqual(MAGIC);
    const headerLength = raw.readUInt32BE(MAGIC.length);
    const headerStart = MAGIC.length + 4;
    const header = JSON.parse(raw.subarray(headerStart, headerStart + headerLength).toString('utf8'));

    expect(Object.keys(header).sort()).toEqual(['alg', 'iv', 'v']);
    expect(header.v).toBe(1);
    expect(header.alg).toBe('aes-256-gcm');
    expect(Buffer.from(header.iv, 'base64')).toHaveLength(12);

    // Header + ciphertext are followed by the tag only; there is no length trailer to confuse the reader.
    expect(raw.length).toBe(headerStart + headerLength + plaintext.length + TAG_LENGTH);
  });

  it('rejects a file with foreign magic', async () => {
    const filePath = path('foreign.enc');
    await writeFile(filePath, Buffer.concat([Buffer.from('NOTABK01'), Buffer.alloc(32)]));
    await expect(readHeader(filePath)).rejects.toThrow(BackupFormatError);
  });

  it('rejects a truncated header', async () => {
    const filePath = path('truncated-header.enc');
    await writeFile(filePath, Buffer.concat([MAGIC, Buffer.from([0, 0, 0, 50]), Buffer.from('{"v":1')]));
    await expect(readHeader(filePath)).rejects.toThrow(BackupFormatError);
  });

  it('rejects a header length larger than the file', async () => {
    const filePath = path('oversized-header.enc');
    const raw = Buffer.alloc(MAGIC.length + 4);
    MAGIC.copy(raw, 0);
    raw.writeUInt32BE(1_000_000, MAGIC.length);
    await writeFile(filePath, raw);
    await expect(readHeader(filePath)).rejects.toThrow(BackupFormatError);
  });

  it('rejects a file shorter than magic, length and tag', async () => {
    const filePath = path('too-small.enc');
    await writeFile(filePath, Buffer.from('short'));
    await expect(readHeader(filePath)).rejects.toThrow(BackupFormatError);
  });
});

describe('authentication', () => {
  it('rejects a wrong 32-byte key and removes the partial plaintext', async () => {
    const encryptedPath = await encryptToFile(Buffer.alloc(4096, 0x33));
    const decryptedPath = path('wrong-key.dump');

    await expect(
      decryptDump({ filePath: encryptedPath, key: Buffer.alloc(32, 0x99), outputPath: decryptedPath }),
    ).rejects.toThrow(BackupFormatError);
    await expect(stat(decryptedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a flipped ciphertext byte', async () => {
    const encryptedPath = await encryptToFile(Buffer.alloc(4096, 0x44));
    const info = await readHeader(encryptedPath);
    await tamper(encryptedPath, (raw) => {
      raw[info.ciphertextOffset + 17] ^= 0xff;
    });

    await expect(
      decryptDump({ filePath: encryptedPath, key: KEY, outputPath: path('flipped.dump') }),
    ).rejects.toThrow(BackupFormatError);
  });

  it('rejects a modified IV in the header through GCM authentication', async () => {
    const encryptedPath = await encryptToFile(Buffer.alloc(4096, 0x55));
    await tamperHeader(encryptedPath, (header) => {
      // Re-encoding a flipped IV byte keeps the base64 length identical, so only the AAD binding can notice.
      const iv = Buffer.from(header.iv, 'base64');
      iv[0] ^= 0x01;
      header.iv = iv.toString('base64');
    });

    await expect(
      decryptDump({ filePath: encryptedPath, key: KEY, outputPath: path('iv.dump') }),
    ).rejects.toThrow(BackupFormatError);
  });

  it('rejects a modified version field in the header', async () => {
    const encryptedPath = await encryptToFile(Buffer.alloc(4096, 0x66));
    await tamperHeader(encryptedPath, (header) => {
      header.v = 2;
    });

    await expect(readHeader(encryptedPath)).rejects.toThrow(BackupFormatError);
    await expect(
      decryptDump({ filePath: encryptedPath, key: KEY, outputPath: path('version.dump') }),
    ).rejects.toThrow(BackupFormatError);
  });

  it('rejects a modified trailer tag', async () => {
    const encryptedPath = await encryptToFile(Buffer.alloc(4096, 0x77));
    await tamper(encryptedPath, (raw) => {
      raw[raw.length - 1] ^= 0x01;
    });

    await expect(
      decryptDump({ filePath: encryptedPath, key: KEY, outputPath: path('tag.dump') }),
    ).rejects.toThrow(BackupFormatError);
  });

  it('rejects a truncated trailer tag', async () => {
    const encryptedPath = await encryptToFile(Buffer.alloc(4096, 0x88));
    const raw = await readFile(encryptedPath);
    await writeFile(encryptedPath, raw.subarray(0, raw.length - 1));

    await expect(
      decryptDump({ filePath: encryptedPath, key: KEY, outputPath: path('tag-truncated.dump') }),
    ).rejects.toThrow(BackupFormatError);
  });
});

describe('key handling', () => {
  it('accepts hex and base64 encodings and trims a trailing newline', () => {
    expect(parseBackupKey(KEY.toString('hex'))).toEqual(KEY);
    expect(parseBackupKey(`${KEY.toString('base64')}\n`)).toEqual(KEY);
  });

  it.each([0, 16, 31, 33, 64])('rejects a %i-byte key', async (length) => {
    const key = Buffer.alloc(length, 0x01);
    expect(() => assertBackupKey(key)).toThrow(BackupKeyError);
    await expect(
      encryptDump({ input: Readable.from([]), outputPath: path(`key-${length}.enc`), key }),
    ).rejects.toThrow(BackupKeyError);
  });

  it('rejects the .env placeholder and malformed text', () => {
    for (const value of [
      'replace-with-a-random-32-byte-hex-string',
      'short',
      'zzzz',
      KEY.toString('hex') + '00',
    ]) {
      expect(() => parseBackupKey(value), value).toThrow(BackupKeyError);
    }
  });

  it('loads a key from BACKUP_KEY_FILE and falls back to BACKUP_KEY', async () => {
    const keyFile = path('backup.key');
    await writeFile(keyFile, `${KEY.toString('hex')}\n`, { mode: 0o600 });

    await expect(loadBackupKey({ keyFile })).resolves.toEqual(KEY);
    await expect(loadBackupKey({ key: KEY.toString('base64') })).resolves.toEqual(KEY);
    await expect(loadBackupKey({ keyFile: path('missing.key') })).rejects.toThrow(BackupKeyError);
    await expect(loadBackupKey({})).rejects.toThrow(BackupKeyError);
  });
});

describe('retention', () => {
  const DAY = 24 * 60 * 60 * 1000;

  /**
   * Creates a backup file whose mtime is `ageDays` before a fixed reference instant.
   * @param {string} dir
   * @param {string} name
   * @param {Date} mtime
   */
  async function agedFile(dir, name, mtime) {
    const filePath = join(dir, name);
    await writeFile(filePath, 'encrypted');
    await utimes(filePath, mtime, mtime);
    return filePath;
  }

  it('removes only expired metrika-*.dump.enc files and keeps the newest', async () => {
    const dir = await mkdtemp(join(workDir, 'retention-'));
    const now = new Date('2026-11-24T12:00:00Z');
    const old = await agedFile(dir, 'metrika-2026-10-01T00-00-00Z.dump.enc', new Date(now - 30 * DAY));
    const middle = await agedFile(dir, 'metrika-2026-10-20T00-00-00Z.dump.enc', new Date(now - 20 * DAY));
    const fresh = await agedFile(dir, 'metrika-2026-11-23T00-00-00Z.dump.enc', new Date(now - 1 * DAY));
    const readme = await agedFile(dir, 'README.txt', new Date(now - 40 * DAY));
    const other = await agedFile(dir, 'other.dump.enc', new Date(now - 40 * DAY));

    const result = await pruneBackups({ dir, retentionDays: 7, keep: 1, now });

    expect(result.removed.sort()).toEqual([old, middle].sort());
    expect(result.kept).toContain(fresh);
    for (const kept of [fresh, readme, other]) {
      await expect(stat(kept)).resolves.toBeDefined();
    }
  });

  it('always keeps at least one file even when every backup is expired', async () => {
    const dir = await mkdtemp(join(workDir, 'retention-min-'));
    const now = new Date('2026-11-24T12:00:00Z');
    const newest = await agedFile(dir, 'metrika-2026-11-20T00-00-00Z.dump.enc', new Date(now - 4 * DAY));
    await agedFile(dir, 'metrika-2026-11-10T00-00-00Z.dump.enc', new Date(now - 14 * DAY));
    await agedFile(dir, 'metrika-2026-11-01T00-00-00Z.dump.enc', new Date(now - 24 * DAY));

    const result = await pruneBackups({ dir, retentionDays: 1, keep: 1, now });

    expect(result.removed).toHaveLength(2);
    expect(result.kept).toContain(newest);
    await expect(stat(newest)).resolves.toBeDefined();
  });

  it('honours --keep N as a floor above the age rule', async () => {
    const dir = await mkdtemp(join(workDir, 'retention-keep-'));
    const now = new Date('2026-11-24T12:00:00Z');
    const files = [];
    for (const [index, age] of [30, 20, 10, 5].entries()) {
      files.push(await agedFile(dir, `metrika-2026-10-0${index + 1}T00-00-00Z.dump.enc`, new Date(now - age * DAY)));
    }

    const result = await pruneBackups({ dir, retentionDays: 1, keep: 2, now });

    expect(result.removed).toHaveLength(2);
    expect(result.kept.sort()).toEqual(files.slice(2).sort());
  });
});

describe('restore target validation', () => {
  it.each(['bad;drop', 'Bad-Name', '1starts_with_digit', '', 'has space', 'quote"name', '../etc'])(
    'rejects %j before connecting',
    (name) => {
      expect(() => validateDatabaseName(name)).toThrow(BackupUsageError);
    },
  );

  it('accepts a plain lowercase identifier', () => {
    expect(validateDatabaseName('metrika_restore_check')).toBe('metrika_restore_check');
  });

  it('refuses to overwrite the DATABASE_URL database without --force', () => {
    const databaseUrl = 'postgres://user:secret@localhost:5432/metrika_test';
    expect(() =>
      assertRestoreTarget({ targetDatabase: 'metrika_test', databaseUrl, force: false }),
    ).toThrow(/--force/);
    expect(() =>
      assertRestoreTarget({ targetDatabase: 'metrika_test', databaseUrl, force: true }),
    ).not.toThrow();
    expect(() =>
      assertRestoreTarget({ targetDatabase: 'metrika_test_restore_check', databaseUrl, force: false }),
    ).not.toThrow();
  });

  it('rejects an invalid --database name before the script opens any connection', () => {
    const result = spawnSync(process.execPath, ['scripts/restore.js', '--file', '/nonexistent.dump.enc', '--database', 'bad;drop'], {
      cwd: ROOT,
      env: {
        ...process.env,
        // Deliberately unreachable: a connection attempt would surface as ECONNREFUSED instead of a name error.
        DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/none',
        ADMIN_DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:1/postgres',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/имя базы|database name/i);
    expect(output).not.toMatch(/ECONNREFUSED|connect/i);
  });
});
