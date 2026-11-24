import { describe, expect, it, vi } from 'vitest';
import { createExplainProxy, toExplainStatement } from '../../scripts/explain-queries.js';

/**
 * The proxy is the safety boundary of the measurement script: it turns read models into `EXPLAIN ANALYZE` and must
 * refuse anything else **before** the statement reaches PostgreSQL. These tests pin both sides, so a later
 * refactor cannot turn the script into a way to execute writes against the demo database.
 */

function fakeDb() {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return {
        rows: [
          {
            'QUERY PLAN': [
              {
                Plan: { 'Node Type': 'Result', 'Actual Rows': 1, 'Actual Total Time': 0.01, 'Plan Rows': 1 },
                'Planning Time': 0.05,
                'Execution Time': 0.02,
              },
            ],
          },
        ],
      };
    },
  };
}

describe('toExplainStatement', () => {
  it('wraps a plain SELECT and keeps its parameters untouched', async () => {
    const db = fakeDb();
    const proxy = createExplainProxy(db, { onPlan: () => {} });

    await proxy.query('SELECT * FROM channels WHERE id = $1', [7]);

    expect(db.calls[0].text).toBe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM channels WHERE id = $1');
    expect(db.calls[0].params).toEqual([7]);
  });

  it('wraps a WITH … SELECT aggregate', () => {
    const statement = toExplainStatement('WITH spend AS (SELECT 1) SELECT * FROM spend');

    expect(statement).toBe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) WITH spend AS (SELECT 1) SELECT * FROM spend');
  });

  it('accepts comments and a single trailing semicolon', () => {
    expect(toExplainStatement('-- read-only report\nSELECT 1;')).toContain('SELECT 1;');
    expect(toExplainStatement('/* delete is mentioned only in a comment */ SELECT 1')).toContain('SELECT 1');
  });

  it('does not confuse a quoted literal with a write keyword', () => {
    expect(() => toExplainStatement("SELECT 'delete from users' AS note")).not.toThrow();
  });

  it.each([
    ['INSERT', 'INSERT INTO channels (code) VALUES (\'x\')'],
    ['UPDATE', 'UPDATE channels SET name = \'x\''],
    ['DELETE', 'DELETE FROM channels'],
    ['DDL', 'CREATE TABLE scratch (id int)'],
    ['data-modifying CTE', 'WITH gone AS (DELETE FROM sessions RETURNING *) SELECT * FROM gone'],
    ['two statements', 'SELECT 1; SELECT 2'],
    ['SELECT followed by a write', 'SELECT 1; DROP TABLE channels'],
    ['empty input', '   '],
  ])('rejects %s before the database is touched', (_label, sql) => {
    const db = fakeDb();
    const proxy = createExplainProxy(db, { onPlan: () => {} });

    expect(() => proxy.query(sql, [])).toThrow(TypeError);
    expect(db.calls).toHaveLength(0);
  });

  it('rejects non-string input instead of coercing it', () => {
    expect(() => toExplainStatement(undefined)).toThrow(TypeError);
    expect(() => toExplainStatement({ toString: () => 'SELECT 1' })).toThrow(TypeError);
  });
});

describe('createExplainProxy', () => {
  it('returns an empty result set and reports the plan to the caller', async () => {
    const db = fakeDb();
    const plans = [];
    const proxy = createExplainProxy(db, { onPlan: (entry) => plans.push(entry) });

    const result = await proxy.query('SELECT count(*) FROM orders');

    expect(result.rows).toEqual([]);
    expect(plans).toHaveLength(1);
    expect(plans[0].sql).toBe('SELECT count(*) FROM orders');
    expect(plans[0].plan['Node Type']).toBe('Result');
    expect(plans[0].executionMs).toBeCloseTo(0.02);
  });

  it('fails loudly when EXPLAIN returns a shape without a plan', async () => {
    const proxy = createExplainProxy({ query: async () => ({ rows: [] }) }, { onPlan: () => {} });

    await expect(proxy.query('SELECT 1')).rejects.toThrow(/explain/i);
  });

  it('does not expose write-capable methods to the caller', () => {
    const proxy = createExplainProxy(fakeDb(), { onPlan: () => {} });

    expect(proxy.query).toBeTypeOf('function');
    expect(proxy.connect).toBeUndefined();
  });

  it('validates before the first asynchronous hop', () => {
    const db = fakeDb();
    const spy = vi.spyOn(db, 'query');
    const proxy = createExplainProxy(db, { onPlan: () => {} });

    expect(() => proxy.query('DROP TABLE channels')).toThrow(TypeError);
    expect(spy).not.toHaveBeenCalled();
  });
});
