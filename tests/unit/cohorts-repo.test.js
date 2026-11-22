import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../src/lib/errors.js';
import { createCohortsRepository } from '../../src/repositories/cohorts.repo.js';

/**
 * Minimal `pg` pool double that records which connection each statement ran on. The pool-level `query` is a trap:
 * a repository that bypasses the snapshot would call it and fail the test instead of silently reading a second
 * connection.
 *
 * @param {(sql: string, params: unknown[]) => { rows: any[] }} respond
 */
function createPoolDouble(respond) {
  const statements = [];
  const client = {
    statements,
    released: false,
    async query(sql, params = []) {
      statements.push({ sql: sql.trim(), params, connection: 'client' });
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql.trim())) return { rows: [] };
      return respond(sql, params);
    },
    release() {
      this.released = true;
    },
  };

  const pool = {
    client,
    // The repository recognises a real pool by its live connection counters.
    totalCount: 1,
    connect: vi.fn(async () => client),
    query: vi.fn(async () => {
      throw new Error('pool.query must not be used: the reads belong to one snapshot client');
    }),
  };

  return { pool, client };
}

/**
 * @param {string} sql
 * @returns {{ rows: any[] }}
 */
function respond(sql) {
  if (sql.includes('FROM channels')) {
    return { rows: [{ channel_id: '1', channel_code: 'instagram', is_active: true }] };
  }
  if (sql.includes('AS cohort_size')) {
    return { rows: [{ cohort_month: '2026-01-01', channel_id: '1', channel_code: 'instagram', cohort_size: 120 }] };
  }
  if (sql.includes('AS margin_cents')) {
    return {
      rows: [
        {
          cohort_month: '2026-01-01',
          channel_id: '1',
          month_offset: 0,
          active_customers: 120,
          margin_cents: '1440000',
        },
      ],
    };
  }
  throw new Error(`unexpected statement: ${sql}`);
}

const FILTERS = { toCohortMonth: '2026-01-01', anchor: '2026-01-20' };

describe('createCohortsRepository', () => {
  it('runs sizes, margins and channels on one repeatable-read snapshot client', async () => {
    const { pool, client } = createPoolDouble(respond);
    const repository = createCohortsRepository(pool);

    const result = await repository.withSnapshot(async (scoped) => {
      const [sizes, margins, channels] = await Promise.all([
        scoped.listCohortSizes(FILTERS),
        scoped.listCohortMonthlyMargins(FILTERS),
        scoped.listChannels(),
      ]);
      return { sizes, margins, channels };
    });

    expect(client.statements[0].sql).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(client.statements.at(-1).sql).toBe('COMMIT');
    expect(client.statements.every((statement) => statement.connection === 'client')).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.released).toBe(true);

    expect(result.sizes).toEqual([
      { cohortMonth: '2026-01-01', channelId: '1', channelCode: 'instagram', cohortSize: 120 },
    ]);
    expect(result.margins).toEqual([
      {
        cohortMonth: '2026-01-01',
        channelId: '1',
        monthOffset: 0,
        marginCents: 1440000n,
        activeCustomers: 120,
      },
    ]);
    expect(result.channels).toEqual([{ channelId: '1', channelCode: 'instagram', isActive: true }]);
  });

  it('rolls the snapshot back and releases the client when a read fails', async () => {
    const { pool, client } = createPoolDouble(() => {
      throw new Error('replica exploded');
    });
    const repository = createCohortsRepository(pool);

    await expect(repository.withSnapshot((scoped) => scoped.listCohortSizes(FILTERS))).rejects.toThrow(
      'replica exploded',
    );

    expect(client.statements.map((statement) => statement.sql)).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      expect.stringContaining('WITH cohort'),
      'ROLLBACK',
    ]);
    expect(client.released).toBe(true);
  });

  it('uses an existing transaction client directly instead of nesting a snapshot', async () => {
    const { pool } = createPoolDouble(respond);
    const repository = createCohortsRepository(pool.client);

    const channels = await repository.withSnapshot((scoped) => scoped.listChannels());

    expect(channels).toHaveLength(1);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects a missing or malformed anchor before the query leaves the process', async () => {
    const { pool } = createPoolDouble(respond);
    const repository = createCohortsRepository(pool);

    await expect(repository.listCohortSizes({ toCohortMonth: '2026-01-01' })).rejects.toThrow(ValidationError);
    await expect(
      repository.listCohortSizes({ toCohortMonth: '2026-01-01', anchor: '2026-02-30' }),
    ).rejects.toThrow(ValidationError);
  });
});
