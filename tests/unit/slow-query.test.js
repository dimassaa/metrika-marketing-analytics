import { describe, expect, it } from 'vitest';
import { observeDb, withRequestUser } from '../../src/lib/slow-query.js';

function fakeDb(impl = async () => ({ rows: [] })) {
  return { query: impl };
}

function collector() {
  const entries = [];
  return {
    entries,
    log: (entry, message) => entries.push({ ...entry, message }),
  };
}

describe('slow-query observer', () => {
  it('logs duration, operation, user id and the statement without parameters', async () => {
    const sink = collector();
    const db = observeDb(fakeDb(), { thresholdMs: 0, log: sink.log });

    await db.query('SELECT * FROM users WHERE id = $1', ['super-secret-param']);

    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]).toMatchObject({
      operation: 'select',
      statement: 'SELECT * FROM users WHERE id = $1',
      userId: 'anon',
      message: 'slow query',
    });
    expect(typeof sink.entries[0].durationMs).toBe('number');
    expect(JSON.stringify(sink.entries)).not.toContain('super-secret-param');
  });

  it('attributes a query to the signed-in user from the request context', async () => {
    const sink = collector();
    const db = observeDb(fakeDb(), { thresholdMs: 0, log: sink.log });

    let pending;
    withRequestUser({ session: { user: { id: '42' } } }, {}, () => {
      pending = db.query('UPDATE users SET last_login_at = now() WHERE id = $1', ['42']);
    });
    await pending;

    expect(sink.entries[0]).toMatchObject({ operation: 'update', userId: '42' });
  });

  it('stays quiet below the threshold and still returns the result', async () => {
    const sink = collector();
    const db = observeDb(fakeDb(async () => ({ rows: [{ ok: 1 }] })), { thresholdMs: 10_000, log: sink.log });

    const result = await db.query('SELECT 1');

    expect(result).toEqual({ rows: [{ ok: 1 }] });
    expect(sink.entries).toEqual([]);
  });

  it('rethrows a failed statement after observing it', async () => {
    const sink = collector();
    const db = observeDb(
      fakeDb(async () => {
        throw new Error('boom');
      }),
      { thresholdMs: 0, log: sink.log },
    );

    await expect(db.query('SELECT broken')).rejects.toThrow('boom');
    expect(sink.entries).toHaveLength(1);
  });

  it('keeps the pool identity for non-query properties and transaction clients', async () => {
    const sink = collector();
    const client = { query: async () => ({ rows: [] }), release: () => {} };
    const pool = {
      totalCount: 3,
      on: () => {},
      query: async () => ({ rows: [] }),
      connect: async () => client,
    };
    const db = observeDb(pool, { thresholdMs: 0, log: sink.log });

    expect(db.totalCount).toBe(3);
    const checkedOut = await db.connect();
    await checkedOut.query('BEGIN');
    expect(sink.entries[0]).toMatchObject({ operation: 'begin', userId: 'anon' });
  });
});
