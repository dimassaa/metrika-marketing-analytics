/**
 * SQL query counter for the metrics integration tests.
 *
 * Services receive repositories that receive this object instead of a `pg.Pool`. Every statement sent through
 * `query` is counted, including the `BEGIN`/`COMMIT` of `cohortsRepository.withSnapshot`: the budget is about round
 * trips to PostgreSQL, not about how many statements the planner happens to run. EXPLAIN probes bypass this wrapper
 * and run on a raw client, so they never enter the count.
 *
 * `connect` is wrapped too because `withSnapshot` calls it. A pool and a checked-out client expose different
 * methods, so the proxy forwards only `query` and `release`; those are the two methods the repositories use on a
 * client, and forwarding the rest would hide state the counter cannot see anyway.
 *
 * @param {import('pg').Pool} pool
 * @returns {{
 *   db: { query: Function, connect: Function, totalCount?: number },
 *   count: () => number,
 *   reset: () => void,
 * }}
 */
export function wrapDb(pool) {
  let queries = 0;

  /**
   * @param {import('pg').ClientBase} client
   * @returns {{ query: Function, release: Function }}
   */
  function wrapClient(client) {
    return {
      query(...args) {
        queries += 1;
        return client.query(...args);
      },
      release(...args) {
        return client.release(...args);
      },
    };
  }

  /** @type {{ query: Function, connect: Function, totalCount?: number }} */
  const db = {
    query(...args) {
      queries += 1;
      return pool.query(...args);
    },
    async connect(...args) {
      return wrapClient(await pool.connect(...args));
    },
  };

  // `withSnapshot` distinguishes a pool from a checked-out client by these counters. Without the getter it would
  // treat the wrapper as a client and skip the repeatable-read snapshot, changing the code path under test.
  if (typeof pool.totalCount === 'number') {
    Object.defineProperty(db, 'totalCount', { get: () => pool.totalCount });
  }

  return {
    db,
    count: () => queries,
    reset: () => {
      queries = 0;
    },
  };
}
