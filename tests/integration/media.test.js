import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
import { getAppCsrf, getCsrf } from '../helpers/csrf.js';

const ADMIN = 'admin@metrika.by';
const ANALYST = 'analyst@metrika.by';
const VIEWER = 'viewer@metrika.by';

/**
 * A real 1×1 RGBA PNG. The magic bytes alone would be enough for the validator, but a decodable image keeps the
 * fixture honest when someone opens the response in a browser.
 */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A different 1×1 transparent PNG, so the admin upload is visibly not the seeded cover. */
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/** @type {import('pg').Pool} */
let pool;
/** @type {import('express').Express} */
let app;
/** @type {{ bytes: Buffer, checksum: string }} */
let seededCover;

beforeAll(async () => {
  await resetTestDatabase();
  await seed();
  pool = getTestPool();
  const { rows } = await pool.query(
    "SELECT bytes, checksum FROM media_assets WHERE slug = 'og-cover'",
  );
  seededCover = { bytes: rows[0].bytes, checksum: rows[0].checksum };
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  // Sessions and journal rows are per-test. Uploaded avatars are removed too, but the seeded cover is restored so
  // the public-route assertions never depend on a test that changed it.
  await pool.query('DELETE FROM sessions');
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM media_assets');
  await pool.query(
    `INSERT INTO media_assets (slug, filename, mime_type, size_bytes, checksum, bytes)
     VALUES ('og-cover', 'og-cover.png', 'image/png', $1, $2, $3)`,
    [seededCover.bytes.length, seededCover.checksum, seededCover.bytes],
  );
  app = makeApp();
});

/**
 * Logs an agent in and verifies the redirect, so a broken login cannot masquerade as an upload failure.
 * @param {string} email
 * @returns {Promise<import('supertest').SuperAgentTest>}
 */
async function signedIn(email) {
  const agent = request.agent(app);
  const login = await loginAs(agent, email);
  expect(login.status).toBe(302);
  return agent;
}

/**
 * Buffers a binary response. Superagent only parses known textual types by default, so image assertions read the
 * raw bytes through an explicit parser instead of relying on `res.body` heuristics.
 * @param {import('http').IncomingMessage} res
 * @param {(error: Error | null, body?: Buffer) => void} callback
 */
function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

/**
 * @param {import('supertest').SuperAgentTest} agent
 * @param {string} path
 * @param {Record<string, string>} [headers]
 * @returns {Promise<import('supertest').Response>}
 */
async function getBinary(agent, path, headers = {}) {
  let req = agent.get(path).buffer(true).parse(binaryParser);
  for (const [name, value] of Object.entries(headers)) {
    req = req.set(name, value);
  }
  return req;
}

/**
 * Sends one multipart image upload, the same shape the browser form produces.
 * @param {import('supertest').SuperAgentTest} agent
 * @param {string} path
 * @param {string} field
 * @param {Buffer} buffer
 * @param {{ token?: string, filename?: string, contentType?: string }} [options]
 * @returns {Promise<import('supertest').Response>}
 */
async function postImage(agent, path, field, buffer, { token, filename = 'avatar.png', contentType = 'image/png' } = {}) {
  let req = agent.post(path);
  if (token !== undefined) req = req.set('X-CSRF-Token', token);
  return req.attach(field, buffer, { filename, contentType });
}

/**
 * @param {string} sql
 * @param {unknown[]} [params]
 * @returns {Promise<any[]>}
 */
async function queryRows(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

describe('public media route', () => {
  it('serves the seeded og cover with type, strong etag and immutable cache', async () => {
    const res = await getBinary(request(app), '/media/slug/og-cover');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=86400, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-length']).toBe(String(seededCover.bytes.length));
    expect(res.headers.etag).toBe(`"${seededCover.checksum}"`);
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.equals(seededCover.bytes)).toBe(true);
  });

  it('answers If-None-Match with 304 and an empty body', async () => {
    const first = await getBinary(request(app), '/media/slug/og-cover');
    const second = await getBinary(request(app), '/media/slug/og-cover', {
      'If-None-Match': first.headers.etag,
    });

    expect(second.status).toBe(304);
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(second.body.length).toBe(0);
  });

  it.each(['0', '-1', 'abc', '1.5', '999999', '9223372036854775808'])(
    'answers 404 for the invalid or unknown id %s',
    async (id) => {
      const res = await request(app).get(`/media/${id}`);
      expect(res.status).toBe(404);
    },
  );
});

describe('avatar upload', () => {
  it('stores the PNG, serves the same bytes and records an audit row without bytes', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent, '/app/profile');

    const upload = await postImage(agent, '/api/v1/profile/avatar', 'avatar', ONE_PIXEL_PNG, { token });

    expect(upload.status).toBe(200);
    expect(upload.headers['content-type']).toMatch(/application\/json/);
    expect(upload.body.slug).toMatch(/^avatar-user-\d+$/);
    expect(Number.isInteger(upload.body.mediaId)).toBe(true);
    expect(upload.body.url).toBe(`/media/${upload.body.mediaId}`);

    const stored = await queryRows(
      'SELECT checksum, size_bytes, octet_length(bytes)::int AS bytes_length, mime_type, filename FROM media_assets WHERE id = $1',
      [upload.body.mediaId],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].checksum).toBe(createHash('sha256').update(ONE_PIXEL_PNG).digest('hex'));
    expect(stored[0].size_bytes).toBe(ONE_PIXEL_PNG.length);
    expect(stored[0].bytes_length).toBe(ONE_PIXEL_PNG.length);
    expect(stored[0].mime_type).toBe('image/png');
    // The multipart filename is kept as a display name, not trusted as a path.
    expect(stored[0].filename).toBe('avatar.png');

    const served = await getBinary(agent, upload.body.url);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers.etag).toBe(`"${stored[0].checksum}"`);
    expect(Buffer.isBuffer(served.body)).toBe(true);
    expect(served.body.equals(ONE_PIXEL_PNG)).toBe(true);

    const audit = await queryRows(
      "SELECT entity, entity_id, payload FROM audit_log WHERE action = 'media.upload' ORDER BY id DESC LIMIT 1",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].entity).toBe('media');
    expect(audit[0].entity_id).toBe(String(upload.body.mediaId));
    expect(audit[0].payload).toMatchObject({
      slug: upload.body.slug,
      filename: 'avatar.png',
      mimeType: 'image/png',
      sizeBytes: ONE_PIXEL_PNG.length,
    });
    // No file bytes, no base64 copy and no checksum-shaped secret in the journal payload.
    expect(audit[0].payload).not.toHaveProperty('bytes');
    expect(JSON.stringify(audit[0].payload)).not.toContain(ONE_PIXEL_PNG.toString('base64'));
  });

  it('lets any authenticated role replace their avatar', async () => {
    const viewer = await signedIn(VIEWER);
    const token = await getAppCsrf(viewer, '/app/profile');

    const res = await postImage(viewer, '/api/v1/profile/avatar', 'avatar', ONE_PIXEL_PNG, { token });

    expect(res.status).toBe(200);
    expect(res.body.slug).toMatch(/^avatar-user-\d+$/);
  });

  it('rejects an anonymous upload with a JSON 401 or 403', async () => {
    const anonymous = request.agent(app);

    const withoutToken = await postImage(anonymous, '/api/v1/profile/avatar', 'avatar', ONE_PIXEL_PNG);
    expect([401, 403]).toContain(withoutToken.status);
    expect(withoutToken.headers['content-type']).toMatch(/application\/json/);

    const token = await getCsrf(anonymous, '/login');
    const withToken = await postImage(anonymous, '/api/v1/profile/avatar', 'avatar', ONE_PIXEL_PNG, { token });
    expect(withToken.status).toBe(401);
    expect(withToken.headers['content-type']).toMatch(/application\/json/);
  });

  it('rejects an upload without the CSRF header with a JSON 403', async () => {
    const agent = await signedIn(ANALYST);

    const res = await postImage(agent, '/api/v1/profile/avatar', 'avatar', ONE_PIXEL_PNG);

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(await queryRows("SELECT id FROM media_assets WHERE slug LIKE 'avatar-user-%'")).toHaveLength(0);
  });

  it('rejects SVG and a text file disguised as PNG', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent, '/app/profile');
    const svg = Buffer.from('<svg onload="alert(1)"></svg>', 'utf8');

    const cases = [
      { buffer: svg, contentType: 'image/svg+xml', filename: 'x.svg' },
      { buffer: svg, contentType: 'image/png', filename: 'x.png' },
      { buffer: Buffer.from('not an image at all', 'utf8'), contentType: 'image/png', filename: 'x.png' },
    ];

    for (const testCase of cases) {
      const res = await postImage(agent, '/api/v1/profile/avatar', 'avatar', testCase.buffer, {
        token,
        filename: testCase.filename,
        contentType: testCase.contentType,
      });

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.error).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'Допустимы только изображения PNG, JPEG или WebP',
      });
    }
    expect(await queryRows("SELECT id FROM media_assets WHERE slug LIKE 'avatar-user-%'")).toHaveLength(0);
  });

  it('rejects a file above the 1 MB image limit with a JSON 413', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent, '/app/profile');
    const oversized = Buffer.concat([ONE_PIXEL_PNG, Buffer.alloc(1_100_000)]);

    const res = await postImage(agent, '/api/v1/profile/avatar', 'avatar', oversized, { token });

    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });
});

describe('og cover upload', () => {
  it('refuses an analyst and a viewer with a JSON 403', async () => {
    for (const email of [ANALYST, VIEWER]) {
      const agent = await signedIn(email);
      const token = await getAppCsrf(agent, '/app/dashboard');

      const res = await postImage(agent, '/api/v1/admin/media/og-cover', 'file', ONE_PIXEL_PNG, { token });

      expect(res.status).toBe(403);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('lets an admin replace the cover and serves the new bytes by slug', async () => {
    const agent = await signedIn(ADMIN);
    const token = await getAppCsrf(agent, '/app/admin/users');

    const res = await postImage(agent, '/api/v1/admin/media/og-cover', 'file', TRANSPARENT_PNG, { token });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ slug: 'og-cover', url: `/media/${res.body.mediaId}` });

    const served = await getBinary(request(app), '/media/slug/og-cover');
    expect(served.status).toBe(200);
    expect(Buffer.isBuffer(served.body)).toBe(true);
    expect(served.body.equals(TRANSPARENT_PNG)).toBe(true);
    expect(served.headers.etag).toBe(`"${createHash('sha256').update(TRANSPARENT_PNG).digest('hex')}"`);

    // The slug is unique: replacing the cover updates the same row instead of accumulating rows.
    const rows = await queryRows("SELECT count(*)::int AS total FROM media_assets WHERE slug = 'og-cover'");
    expect(rows[0].total).toBe(1);
  });
});
