import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { runMigrations } from '../../db/migrate.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';

const EXPECTED_TABLES = [
  'alerts',
  'audit_log',
  'campaigns',
  'channels',
  'customers',
  'daily_stats',
  'goals',
  'import_batches',
  'media_assets',
  'orders',
  'scenarios',
  'schema_migrations',
  'sessions',
  'touchpoints',
  'users',
];

/**
 * Asserts that `promise` rejects with the given PostgreSQL SQLSTATE.
 *
 * SQLSTATE codes are stable across server locales, unlike message text: the same CHECK violation reads
 * "violates check constraint" in English and «нарушает ограничение-проверку» when the server runs with
 * ru_RU.UTF-8, so message matching would only pass on some machines.
 * @param {Promise<unknown>} promise Query expected to fail.
 * @param {string} code Expected SQLSTATE, e.g. '23514' for a CHECK violation or '23503' for an FK violation.
 */
async function expectSqlState(promise, code) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('migrations', () => {
  let pool;

  beforeAll(async () => {
    await resetTestDatabase();
    pool = getTestPool();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('creates every table from the initial migration', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual(EXPECTED_TABLES);
  });

  it('is idempotent: a second run applies nothing and does not throw', async () => {
    await expect(runMigrations({ connectionString: env.testDatabaseUrl })).resolves.toEqual([]);
  });

  it('enforces the integrity constraints', async () => {
    const suffix = Date.now().toString(36);

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($1, 'hash', 'Тестовый аналитик', 'admin')
       RETURNING id`,
      [`analyst-${suffix}@metrika.by`],
    );
    const channel = await pool.query(
      `INSERT INTO channels (code, name) VALUES ($1, 'Тестовый канал') RETURNING id`,
      [`test_channel_${suffix}`],
    );
    const channelId = channel.rows[0].id;
    const campaign = await pool.query(
      `INSERT INTO campaigns (channel_id, code, name, started_on)
       VALUES ($1, $2, 'Тестовая кампания', '2026-01-01') RETURNING id`,
      [channelId, `test_campaign_${suffix}`],
    );
    const customer = await pool.query(
      `INSERT INTO customers (external_id, first_channel_id, acquired_at)
       VALUES ($1, $2, '2026-01-02T10:00:00Z') RETURNING id`,
      [`cust_${suffix}`, channelId],
    );

    // An order cannot report more margin than revenue: CHECK violation.
    await expectSqlState(
      pool.query(
        `INSERT INTO orders (external_id, customer_id, campaign_id, occurred_at, revenue_cents, margin_cents)
         VALUES ($1, $2, $3, '2026-01-03T12:00:00Z', 1000, 2000)`,
        [`order_bad_margin_${suffix}`, customer.rows[0].id, campaign.rows[0].id],
      ),
      '23514',
    );

    // Historical channel data is protected: deleting a channel with campaigns raises restrict_violation.
    // ON DELETE RESTRICT reports 23001; 23503 (foreign_key_violation) is reserved for NO ACTION.
    await expectSqlState(pool.query('DELETE FROM channels WHERE id = $1', [channelId]), '23001');

    // A campaign cannot point at a channel that does not exist: foreign_key_violation.
    await expectSqlState(
      pool.query(
        `INSERT INTO campaigns (channel_id, code, name, started_on)
         VALUES (999999999, $1, 'Кампания-сирота', '2026-01-01')`,
        [`orphan_campaign_${suffix}`],
      ),
      '23503',
    );

    // Channel codes are unique: unique_violation.
    await expectSqlState(
      pool.query(`INSERT INTO channels (code, name) VALUES ($1, 'Дубль')`, [`test_channel_${suffix}`]),
      '23505',
    );

    // The role list is closed; 'owner' is not a valid role, so the CHECK rejects it.
    await expectSqlState(
      pool.query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ($1, 'hash', 'Владелец', 'owner')`,
        [`owner-${suffix}@metrika.by`],
      ),
      '23514',
    );

    // pg returns int8/bigint columns as strings to avoid precision loss; money columns rely on the same mapping.
    expect(user.rows[0].id).toMatch(/^\d+$/);
  });
});
