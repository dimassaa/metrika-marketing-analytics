import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { seed } from '../../db/seed/seed.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
import { getAppCsrf } from '../helpers/csrf.js';

const ANALYST = 'analyst@metrika.by';
const VIEWER = 'viewer@metrika.by';

const DAILY_HEADER = 'campaign_code;stat_date;impressions;clicks;leads;spend';
const CUSTOMER_HEADER = 'external_id;first_channel_code;first_campaign_code;first_order_at';
const TOUCHPOINT_HEADER = 'customer_external_id;channel_code;campaign_code;occurred_at;kind';
const ORDER_HEADER = 'external_id;customer_external_id;campaign_code;occurred_at;revenue;margin';

/** @type {import('pg').Pool} */
let pool;
/** @type {import('express').Express} */
let app;

beforeAll(async () => {
  await resetTestDatabase();
  await seed();
  pool = getTestPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  // The brief's isolation rule: batches and the journal are per-test, sessions are per-test, and every data row a
  // test creates carries its own prefix. Nothing here depends on rows written by another test.
  await pool.query('DELETE FROM import_batches');
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM sessions');
  app = makeApp();
});

/**
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
 * Sends a real multipart upload, exactly like the browser island: fields first, file last.
 * @param {import('supertest').SuperAgentTest} agent
 * @param {{ kind: string, csv: string, dryRun?: boolean, token?: string, filename?: string }} upload
 * @returns {Promise<import('supertest').Response>}
 */
async function postImport(agent, { kind, csv, dryRun = false, token, filename = 'import.csv' }) {
  let req = agent.post('/api/v1/import');
  if (token !== undefined) req = req.set('X-CSRF-Token', token);
  req = req.field('kind', kind);
  if (dryRun) req = req.field('dryRun', 'true');
  return req.attach('file', Buffer.from(csv, 'utf8'), filename);
}

/**
 * @param {string} table
 * @param {string} [where]
 * @param {unknown[]} [params]
 * @returns {Promise<number>}
 */
async function countRows(table, where = 'TRUE', params = []) {
  const { rows } = await pool.query(`SELECT count(*)::int AS total FROM ${table} WHERE ${where}`, params);
  return rows[0].total;
}

describe('import templates', () => {
  it('serves four BOM-prefixed CSV templates with the documented header', async () => {
    const agent = await signedIn(ANALYST);
    const kinds = ['daily_stats', 'customers', 'touchpoints', 'orders'];

    for (const kind of kinds) {
      const res = await agent.get(`/app/import/templates/${kind}.csv`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toContain(`${kind}.csv`);
      expect(res.text.startsWith('\uFEFF')).toBe(true);
    }

    const daily = await agent.get('/app/import/templates/daily_stats.csv');
    expect(daily.text.startsWith(`\uFEFF${DAILY_HEADER}`)).toBe(true);
  });
});

describe('dry run', () => {
  it('validates three daily rows without writing data, a batch or an audit row', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);
    const before = {
      stats: await countRows('daily_stats'),
      batches: await countRows('import_batches'),
      audit: await countRows('audit_log'),
    };
    const csv = [
      DAILY_HEADER,
      'instagram_retarget;2024-02-01;1000;50;5;10,00',
      'instagram_retarget;2024-02-02;1100;55;6;11.50',
      'instagram_cold;2024-02-01;900;40;4;9,00',
    ].join('\n');

    const res = await postImport(agent, { kind: 'daily_stats', csv, dryRun: true, token });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'daily_stats',
      dryRun: true,
      committed: false,
      batchId: null,
      rowsTotal: 3,
      rowsOk: 3,
      rowsDuplicate: 0,
      rowsFailed: 0,
      warnings: [],
      errors: [],
      wouldCommit: true,
    });
    expect(await countRows('daily_stats')).toBe(before.stats);
    expect(await countRows('import_batches')).toBe(before.batches);
    expect(await countRows('audit_log')).toBe(before.audit);
  });

  it('predicts the same duplicate counts as a commit and writes nothing', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    // One customer already exists, and the file repeats a new one inside itself: both are duplicates for a commit.
    const existing = await postImport(agent, {
      kind: 'customers',
      token,
      csv: [CUSTOMER_HEADER, 'm2_dry_c1;instagram;;'].join('\n'),
    });
    expect(existing.body.committed).toBe(true);

    const customerCsv = [
      CUSTOMER_HEADER,
      'm2_dry_c1;instagram;;',
      'm2_dry_c2;instagram;;',
      'm2_dry_c2;instagram;;',
    ].join('\n');
    const customersBefore = await countRows('customers', `external_id LIKE 'm2_dry_c%'`);

    const customerDryRun = await postImport(agent, { kind: 'customers', csv: customerCsv, dryRun: true, token });
    expect(customerDryRun.body).toMatchObject({
      committed: false,
      batchId: null,
      rowsTotal: 3,
      rowsOk: 1,
      rowsDuplicate: 2,
      rowsFailed: 0,
    });
    expect(await countRows('customers', `external_id LIKE 'm2_dry_c%'`)).toBe(customersBefore);
    expect(await countRows('customers', `external_id = 'm2_dry_c2'`)).toBe(0);

    const customerCommit = await postImport(agent, { kind: 'customers', csv: customerCsv, token });
    expect(customerCommit.body).toMatchObject({
      committed: true,
      rowsTotal: 3,
      rowsOk: 1,
      rowsDuplicate: 2,
      rowsFailed: 0,
    });
    expect(await countRows('customers', `external_id LIKE 'm2_dry_c%'`)).toBe(customersBefore + 1);

    // The same equality for orders: one stored key, one new key repeated in the file.
    await postImport(agent, {
      kind: 'customers',
      token,
      csv: [CUSTOMER_HEADER, 'm2_dryo_c1;instagram;;', 'm2_dryo_c2;instagram;;'].join('\n'),
    });
    const orderCsvFirst = [
      ORDER_HEADER,
      'm2_dryo_o1;m2_dryo_c1;;2029-06-01T10:00:00Z;100,00;40,00',
    ].join('\n');
    expect((await postImport(agent, { kind: 'orders', csv: orderCsvFirst, token })).body.committed).toBe(true);

    const orderCsv = [
      ORDER_HEADER,
      'm2_dryo_o1;m2_dryo_c1;;2029-06-01T10:00:00Z;100,00;40,00',
      'm2_dryo_o2;m2_dryo_c2;;2029-06-02T10:00:00Z;120,00;50,00',
      'm2_dryo_o2;m2_dryo_c2;;2029-06-02T10:00:00Z;120,00;50,00',
    ].join('\n');
    const ordersBefore = await countRows('orders', `external_id LIKE 'm2_dryo_o%'`);

    const orderDryRun = await postImport(agent, { kind: 'orders', csv: orderCsv, dryRun: true, token });
    expect(orderDryRun.body).toMatchObject({
      committed: false,
      batchId: null,
      rowsTotal: 3,
      rowsOk: 1,
      rowsDuplicate: 2,
      rowsFailed: 0,
    });
    expect(await countRows('orders', `external_id LIKE 'm2_dryo_o%'`)).toBe(ordersBefore);
    expect(await countRows('orders', `external_id = 'm2_dryo_o2'`)).toBe(0);

    const orderCommit = await postImport(agent, { kind: 'orders', csv: orderCsv, token });
    expect(orderCommit.body).toMatchObject({
      committed: true,
      rowsTotal: 3,
      rowsOk: 1,
      rowsDuplicate: 2,
      rowsFailed: 0,
    });
    expect(await countRows('orders', `external_id LIKE 'm2_dryo_o%'`)).toBe(ordersBefore + 1);
  });
});

describe('daily_stats import', () => {
  it('updates an existing campaign/date pair and inserts the new dates', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    const first = await postImport(agent, {
      kind: 'daily_stats',
      token,
      csv: [DAILY_HEADER, 'instagram_retarget;2024-03-01;1000;50;5;10,00'].join('\n'),
    });
    expect(first.status).toBe(200);
    expect(first.body.committed).toBe(true);

    const second = await postImport(agent, {
      kind: 'daily_stats',
      token,
      csv: [
        DAILY_HEADER,
        'instagram_retarget;2024-03-01;1200;60;6;99,99',
        'instagram_retarget;2024-03-02;1300;70;7;12,00',
        'instagram_retarget;2024-03-03;1400;80;8;13,00',
      ].join('\n'),
    });

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      kind: 'daily_stats',
      dryRun: false,
      committed: true,
      rowsTotal: 3,
      rowsOk: 3,
      rowsDuplicate: 0,
      rowsFailed: 0,
      wouldCommit: null,
    });
    expect(Number.isInteger(second.body.batchId)).toBe(true);

    const { rows: stats } = await pool.query(
      `SELECT stat_date::text AS stat_date, spend_cents::text AS spend_cents
         FROM daily_stats ds
         JOIN campaigns c ON c.id = ds.campaign_id
        WHERE c.code = 'instagram_retarget'
          AND ds.stat_date BETWEEN '2024-03-01' AND '2024-03-03'
        ORDER BY ds.stat_date`,
    );
    expect(stats.map((row) => row.spend_cents)).toEqual(['9999', '1200', '1300']);
    expect(stats).toHaveLength(3);

    const { rows: batches } = await pool.query(
      `SELECT kind, rows_total, rows_ok, rows_duplicate, rows_failed, errors
         FROM import_batches WHERE id = $1`,
      [second.body.batchId],
    );
    expect(batches[0]).toMatchObject({
      kind: 'daily_stats',
      rows_total: 3,
      rows_ok: 3,
      rows_duplicate: 0,
      rows_failed: 0,
      errors: [],
    });

    const { rows: audit } = await pool.query(
      `SELECT action, entity, entity_id, payload FROM audit_log
        WHERE action = 'import.run' AND entity_id = $1`,
      [String(second.body.batchId)],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('import.run');
    expect(audit[0].entity).toBe('import');
    expect(audit[0].payload).toMatchObject({ kind: 'daily_stats', committed: true, rowsOk: 3 });

    const page = await agent.get(`/app/import/batches/${second.body.batchId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Статистика кампаний');
    expect(page.text).toContain('импорт');
  });
});

describe('customers import', () => {
  it('inserts unique customers and counts an in-file duplicate as skipped', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);
    const csv = [
      CUSTOMER_HEADER,
      'm2_batch_c1;instagram;;',
      'm2_batch_c2;instagram;instagram_retarget;2029-01-10T10:00:00+03:00',
      'm2_batch_c1;instagram;;',
    ].join('\n');

    const res = await postImport(agent, { kind: 'customers', csv, token });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'customers',
      committed: true,
      rowsTotal: 3,
      rowsOk: 2,
      rowsDuplicate: 1,
      rowsFailed: 0,
      errors: [],
    });

    const { rows } = await pool.query(
      `SELECT external_id,
              first_order_at,
              acquired_at = first_order_at AS acquired_from_order
         FROM customers
        WHERE external_id IN ('m2_batch_c1','m2_batch_c2')
        ORDER BY external_id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].first_order_at).toBeNull();
    expect(rows[1].first_order_at.toISOString()).toBe('2029-01-10T07:00:00.000Z');
    expect(rows[1].acquired_from_order).toBe(true);
  });
});

describe('touchpoints and orders import', () => {
  it('inserts both kinds, then skips a repeated file without creating duplicates', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    const customers = await postImport(agent, {
      kind: 'customers',
      token,
      csv: [
        CUSTOMER_HEADER,
        'm2_dup_c1;instagram;;',
        'm2_dup_c2;instagram;;',
      ].join('\n'),
    });
    expect(customers.body).toMatchObject({ committed: true, rowsOk: 2 });

    // A CRLF file with a BOM: the Excel-on-Windows shape the parser must accept. The second touchpoint predates
    // the acquisition instant, so the customer's acquired_at has to move back to it.
    const touchpointCsv = `\uFEFF${[
      TOUCHPOINT_HEADER,
      'm2_dup_c1;instagram;instagram_retarget;2029-01-11T10:00:00+03:00;click',
      'm2_dup_c2;email;;2024-01-01T00:00:00Z;visit',
    ].join('\r\n')}\r\n`;

    const touchpoints = await postImport(agent, { kind: 'touchpoints', csv: touchpointCsv, token });
    expect(touchpoints.status).toBe(200);
    expect(touchpoints.body).toMatchObject({ committed: true, rowsOk: 2, rowsDuplicate: 0, rowsFailed: 0 });

    const { rows: acquired } = await pool.query(
      `SELECT acquired_at FROM customers WHERE external_id = 'm2_dup_c2'`,
    );
    expect(acquired[0].acquired_at.toISOString()).toBe('2024-01-01T00:00:00.000Z');

    const repeatedTouchpoints = await postImport(agent, { kind: 'touchpoints', csv: touchpointCsv, token });
    expect(repeatedTouchpoints.body).toMatchObject({
      committed: true,
      rowsOk: 0,
      rowsDuplicate: 2,
      rowsFailed: 0,
    });
    expect(
      await countRows(
        'touchpoints',
        `customer_id IN (SELECT id FROM customers WHERE external_id IN ('m2_dup_c1','m2_dup_c2'))`,
      ),
    ).toBe(2);

    const orderCsv = [
      ORDER_HEADER,
      'm2_dup_o1;m2_dup_c1;;2029-01-13T10:00:00+03:00;50,00;20,00',
      'm2_dup_o2;m2_dup_c2;instagram_retarget;2029-01-14T10:00:00+03:00;70.00;30.00',
    ].join('\n');

    const orders = await postImport(agent, { kind: 'orders', csv: orderCsv, token });
    expect(orders.body).toMatchObject({ committed: true, rowsOk: 2, rowsDuplicate: 0, rowsFailed: 0 });

    const repeatedOrders = await postImport(agent, { kind: 'orders', csv: orderCsv, token });
    expect(repeatedOrders.body).toMatchObject({ committed: true, rowsOk: 0, rowsDuplicate: 2 });
    expect(
      await countRows('orders', `external_id IN ('m2_dup_o1','m2_dup_o2')`),
    ).toBe(2);

    const { rows: firstOrders } = await pool.query(
      `SELECT c.external_id, c.first_order_at
         FROM customers c WHERE c.external_id IN ('m2_dup_c1','m2_dup_c2') ORDER BY c.external_id`,
    );
    expect(firstOrders[0].first_order_at.toISOString()).toBe('2029-01-13T07:00:00.000Z');
    expect(firstOrders[1].first_order_at.toISOString()).toBe('2029-01-14T07:00:00.000Z');
  });
});

describe('atomicity', () => {
  it('rejects a batch above the 10% error threshold without applying any valid row', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    await postImport(agent, {
      kind: 'customers',
      token,
      csv: [CUSTOMER_HEADER, 'm2_thr_c1;instagram;;'].join('\n'),
    });

    const csv = [
      ORDER_HEADER,
      'm2_thr_o1;m2_thr_c1;;2029-02-01T10:00:00Z;100,00;40,00',
      'm2_thr_o2;m2_thr_c1;;2029-02-02T10:00:00Z;100,00;140,00',
      'm2_thr_o3;m2_thr_c1;;2029-02-03T10:00:00Z;100,00;40,00',
      'm2_thr_o4;m2_thr_c1;;2029-02-04T10:00:00Z;100,00;40,00',
      'm2_thr_o5;m2_thr_c1;;2029-02-05T10:00:00Z;100,00;40,00',
    ].join('\n');

    const res = await postImport(agent, { kind: 'orders', csv, token });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      committed: false,
      rowsTotal: 5,
      // Counters describe the file: four rows are valid, one has a margin error. None of the four was applied.
      rowsOk: 4,
      rowsDuplicate: 0,
      rowsFailed: 1,
      wouldCommit: null,
    });
    expect(Number.isInteger(res.body.batchId)).toBe(true);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatchObject({ row: 3, field: 'margin' });

    expect(await countRows('orders', `external_id LIKE 'm2_thr_o%'`)).toBe(0);

    const { rows: batches } = await pool.query(
      `SELECT rows_total, rows_ok, rows_duplicate, rows_failed, committed, errors
         FROM import_batches WHERE id = $1`,
      [res.body.batchId],
    );
    expect(batches[0]).toMatchObject({
      rows_total: 5,
      rows_ok: 4,
      rows_duplicate: 0,
      rows_failed: 1,
      committed: false,
    });
    expect(batches[0].errors).toHaveLength(1);

    const { rows: audit } = await pool.query(
      `SELECT payload FROM audit_log WHERE action = 'import.run' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit[0].payload).toMatchObject({
      committed: false,
      kind: 'orders',
      rowsOk: 4,
      rowsFailed: 1,
    });

    // The refused batch is reachable and says so instead of pretending it applied four rows.
    const page = await agent.get(`/app/import/batches/${res.body.batchId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Импорт отклонён');
    expect(page.text).toContain('Маржа не может превышать выручку');
    expect(page.text).not.toContain('Импорт применён');
  });

  it('accepts the exact 10% boundary and applies the nine valid orders', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    const customersCsv = [
      CUSTOMER_HEADER,
      ...Array.from({ length: 9 }, (_, index) => `m2_edge_c${index + 1};instagram;;`),
    ].join('\n');
    const customers = await postImport(agent, { kind: 'customers', csv: customersCsv, token });
    expect(customers.body.rowsOk).toBe(9);

    const orderRows = Array.from(
      { length: 9 },
      (_, index) => `m2_edge_o${index + 1};m2_edge_c${index + 1};;2029-03-0${index + 1}T10:00:00Z;100,00;40,00`,
    );
    const csv = [
      ORDER_HEADER,
      ...orderRows,
      'm2_edge_o10;m2_edge_missing;;2029-03-10T10:00:00Z;100,00;40,00',
    ].join('\n');

    const res = await postImport(agent, { kind: 'orders', csv, token });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      committed: true,
      rowsTotal: 10,
      rowsOk: 9,
      rowsDuplicate: 0,
      rowsFailed: 1,
      wouldCommit: null,
    });
    expect(res.body.errors[0]).toMatchObject({ row: 11, field: 'customer_external_id' });
    expect(await countRows('orders', `external_id LIKE 'm2_edge_o%'`)).toBe(9);
  });

  it('rolls back the whole transaction when the audit insert is forced to fail', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    await pool.query(
      `INSERT INTO customers (external_id, first_channel_id, acquired_at)
       SELECT 'm2_roll_c1', id, now() FROM channels WHERE code = 'instagram'`,
    );

    await pool.query(
      `CREATE OR REPLACE FUNCTION raise_on_audit() RETURNS trigger AS $$
       BEGIN RAISE EXCEPTION 'injected audit failure'; END;
       $$ LANGUAGE plpgsql`,
    );
    await pool.query(
      `CREATE TRIGGER inject_audit_fail BEFORE INSERT ON audit_log
       FOR EACH ROW EXECUTE FUNCTION raise_on_audit()`,
    );

    let res;
    try {
      res = await postImport(agent, {
        kind: 'orders',
        token,
        csv: [
          ORDER_HEADER,
          'm2_roll_o1;m2_roll_c1;;2029-04-01T10:00:00Z;100,00;40,00',
        ].join('\n'),
      });
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS inject_audit_fail ON audit_log');
      await pool.query('DROP FUNCTION IF EXISTS raise_on_audit()');
    }

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');

    expect(await countRows('orders', `external_id = 'm2_roll_o1'`)).toBe(0);
    expect(await countRows('import_batches')).toBe(0);
    // The login itself writes `auth.login`; the failed import must leave no `import.run` entry behind.
    expect(await countRows('audit_log', `action = 'import.run'`)).toBe(0);
  });
});

describe('file-level rejections', () => {
  it('rejects a header-only file in both modes', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    for (const dryRun of [true, false]) {
      const res = await postImport(agent, { kind: 'daily_stats', csv: DAILY_HEADER, dryRun, token });

      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'Файл не содержит строк данных',
      });
    }
    expect(await countRows('import_batches')).toBe(0);
  });

  it('rejects an oversized upload with 413 before parsing', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    const res = await postImport(agent, {
      kind: 'daily_stats',
      token,
      csv: 'a'.repeat(2 * 1024 * 1024 + 100),
      filename: 'big.csv',
    });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(res.body.error.message).toBe('Файл превышает допустимый размер 2 МБ');
  });

  it('rejects a non-CSV MIME type or a non-CSV extension before parsing', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    const upload = (filename, contentType) =>
      agent
        .post('/api/v1/import')
        .set('X-CSRF-Token', token)
        .field('kind', 'daily_stats')
        .attach('file', Buffer.from([DAILY_HEADER, 'instagram_retarget;2024-08-02;1;1;1;1'].join('\n')), {
          filename,
          contentType,
        });

    // A PNG chosen in the file dialog: the extension and type both say it is not a CSV.
    const png = await upload('cover.png', 'image/png');
    expect(png.status).toBe(400);
    expect(png.body.error).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(png.body.error.message).toBe('Допустим только файл CSV с расширением .csv');

    // A spoofed type on a .csv name and a CSV type on a non-CSV name are rejected too: both signals must agree.
    const spoofed = await upload('import.csv', 'image/png');
    expect(spoofed.status).toBe(400);
    const wrongExtension = await upload('import.txt', 'text/csv');
    expect(wrongExtension.status).toBe(400);
  });

  it('stores only the base name of the uploaded file', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    const res = await agent
      .post('/api/v1/import')
      .set('X-CSRF-Token', token)
      .field('kind', 'daily_stats')
      .attach('file', Buffer.from([DAILY_HEADER, 'instagram_retarget;2024-08-01;1;1;1;1'].join('\n')), {
        filename: '../../evil.csv',
        contentType: 'text/csv',
      });

    expect(res.status).toBe(200);
    expect(res.body.committed).toBe(true);

    const { rows } = await pool.query('SELECT filename FROM import_batches WHERE id = $1', [res.body.batchId]);
    expect(rows[0].filename).toBe('evil.csv');
  });

  it('rejects an unknown kind, a missing required column and an unknown campaign code', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    const unknownKind = await postImport(agent, {
      kind: 'invoices',
      token,
      csv: [DAILY_HEADER, 'instagram_retarget;2024-04-01;1;1;1;1'].join('\n'),
    });
    expect(unknownKind.status).toBe(400);
    expect(unknownKind.body.error.message).toBe('Неизвестный тип импорта');

    const missingColumn = await postImport(agent, {
      kind: 'daily_stats',
      token,
      csv: 'campaign_code;stat_date;impressions;clicks;leads\ninstagram_retarget;2024-04-01;1;1;1',
    });
    expect(missingColumn.status).toBe(400);
    expect(missingColumn.body.error.message).toContain('spend');

    const badCampaign = await postImport(agent, {
      kind: 'daily_stats',
      token,
      dryRun: true,
      csv: [
        DAILY_HEADER,
        'no_such_campaign;2024-04-01;1;1;1;1',
        'instagram_retarget;2024-04-02;1;1;1;1',
      ].join('\n'),
    });
    expect(badCampaign.status).toBe(200);
    // One failed row out of two is 50%: the dry-run honestly reports that a real import would be refused.
    expect(badCampaign.body).toMatchObject({ rowsOk: 1, rowsFailed: 1, wouldCommit: false });
    expect(badCampaign.body.errors[0]).toMatchObject({ row: 2, field: 'campaign_code' });
    expect(badCampaign.body.errors[0].message).toBe('Кампания не найдена');
  });
});

describe('upload framing', () => {
  it('rejects a request without a file', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    const res = await agent.post('/api/v1/import').set('X-CSRF-Token', token).field('kind', 'daily_stats');

    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Выберите файл для загрузки',
    });
  });

  it('rejects a file sent under an unexpected field name', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    const res = await agent
      .post('/api/v1/import')
      .set('X-CSRF-Token', token)
      .field('kind', 'daily_stats')
      .attach('other', Buffer.from([DAILY_HEADER, 'instagram_retarget;2024-10-01;1;1;1;1'].join('\n')), 'x.csv');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('Неожиданное поле файла');
  });

  it('rejects too many fields and an oversized field with 400 instead of 500', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);
    const file = Buffer.from([DAILY_HEADER, 'instagram_retarget;2024-10-02;1;1;1;1'].join('\n'));

    let manyFields = agent.post('/api/v1/import').set('X-CSRF-Token', token).field('kind', 'daily_stats');
    for (let index = 0; index < 9; index += 1) manyFields = manyFields.field(`extra${index}`, 'x');
    const fieldsRes = await manyFields.attach('file', file, 'x.csv');

    expect(fieldsRes.status).toBe(400);
    expect(fieldsRes.body.error.code).toBe('VALIDATION_ERROR');
    expect(fieldsRes.body.error.message).toContain('Слишком много полей');

    const fieldRes = await agent
      .post('/api/v1/import')
      .set('X-CSRF-Token', token)
      .field('kind', 'daily_stats')
      .field('note', 'x'.repeat(9 * 1024))
      .attach('file', file, 'x.csv');

    expect(fieldRes.status).toBe(400);
    expect(fieldRes.body.error.code).toBe('VALIDATION_ERROR');
    expect(fieldRes.body.error.message).toContain('слишком длинное');
    expect(await countRows('import_batches')).toBe(0);
  });

  it('maps a truncated multipart body to a 400 JSON error', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    const res = await agent
      .post('/api/v1/import')
      .set('X-CSRF-Token', token)
      .set('Content-Type', 'multipart/form-data; boundary=----truncated')
      .send(
        [
          '------truncated',
          'Content-Disposition: form-data; name="kind"',
          '',
          'daily_stats',
          '------truncated',
          'Content-Disposition: form-data; name="file"; filename="a.csv"',
          'Content-Type: text/csv',
          '',
          'campaign_code;stat_date',
        ].join('\r\n'),
      );

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain('Не удалось прочитать форму загрузки');
  });

  it('rejects a declared multipart body above 3 MB with 413', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    const res = await postImport(agent, {
      kind: 'daily_stats',
      token,
      csv: 'a'.repeat(3 * 1024 * 1024 + 100),
      filename: 'huge.csv',
    });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('keeps a Cyrillic filename readable', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    const res = await agent
      .post('/api/v1/import')
      .set('X-CSRF-Token', token)
      .field('kind', 'daily_stats')
      .attach('file', Buffer.from([DAILY_HEADER, 'instagram_retarget;2024-10-03;1;1;1;1'].join('\n')), {
        filename: 'заказы.csv',
        contentType: 'text/csv',
      });

    expect(res.status).toBe(200);
    const { rows } = await pool.query('SELECT filename FROM import_batches WHERE id = $1', [res.body.batchId]);
    expect(rows[0].filename).toBe('заказы.csv');
  });
});

describe('access control for uploads', () => {
  it('answers a request without the CSRF header with a JSON 403 and accepts the same request with it', async () => {
    const agent = await signedIn(ANALYST);
    const csv = [DAILY_HEADER, 'instagram_retarget;2024-05-01;1;1;1;1'].join('\n');

    const withoutToken = await postImport(agent, { kind: 'daily_stats', csv, dryRun: true });
    expect(withoutToken.status).toBe(403);
    expect(withoutToken.headers['content-type']).toMatch(/application\/json/);
    expect(withoutToken.body.error.code).toBe('FORBIDDEN');

    const token = await getAppCsrf(agent);
    const withToken = await postImport(agent, { kind: 'daily_stats', csv, dryRun: true, token });
    expect(withToken.status).not.toBe(403);
  });

  it('answers a viewer with a JSON 403 instead of the styled HTML page', async () => {
    const agent = await signedIn(VIEWER);
    const token = await getAppCsrf(agent);

    const res = await postImport(agent, {
      kind: 'daily_stats',
      csv: [DAILY_HEADER, 'instagram_retarget;2024-05-02;1;1;1;1'].join('\n'),
      dryRun: true,
      token,
    });

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('limits one person to twenty imports per window with a JSON 429', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);
    const csv = [DAILY_HEADER, 'instagram_retarget;2024-07-01;1;1;1;1'].join('\n');

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const allowed = await postImport(agent, { kind: 'daily_stats', csv, dryRun: true, token });
      expect(allowed.status).toBe(200);
    }

    const limited = await postImport(agent, { kind: 'daily_stats', csv, dryRun: true, token });
    expect(limited.status).toBe(429);
    expect(limited.headers['content-type']).toMatch(/application\/json/);
    expect(limited.body.error).toEqual({
      code: 'RATE_LIMITED',
      message: 'Слишком много импортов. Попробуйте снова через 15 минут.',
    });
  });

  it('serves the import page to an analyst and hides it from a viewer', async () => {
    const analyst = await signedIn(ANALYST);
    const page = await analyst.get('/app/import');

    expect(page.status).toBe(200);
    expect(page.text).toContain('Импорт CSV');
    expect(page.text).not.toContain('следующем этапе');

    const viewer = await signedIn(VIEWER);
    const forbidden = await viewer.get('/app/import');
    expect(forbidden.status).toBe(403);
  });
});

describe('order references', () => {
  it('reports a missing campaign on an order row without failing the whole file', async () => {
    const agent = await signedIn(ANALYST);
    const token = await getAppCsrf(agent);

    await postImport(agent, {
      kind: 'customers',
      token,
      csv: [CUSTOMER_HEADER, 'm2_ref_c1;instagram;;'].join('\n'),
    });

    const res = await postImport(agent, {
      kind: 'orders',
      token,
      dryRun: true,
      csv: [
        ORDER_HEADER,
        'm2_ref_o1;m2_ref_c1;no_such_campaign;2029-05-01T10:00:00Z;100,00;40,00',
      ].join('\n'),
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rowsOk: 0, rowsFailed: 1, wouldCommit: false });
    expect(res.body.errors[0]).toMatchObject({ row: 2, field: 'campaign_code', message: 'Кампания не найдена' });
  });
});
