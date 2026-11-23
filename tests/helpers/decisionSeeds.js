import { seed } from '../../db/seed/seed.js';
import { resetTestDatabase } from './db.js';

/**
 * Fixed data anchor for every M5 database test.
 *
 * The seed's generated numbers depend on the anchor, so two files using different anchors would see different CAC,
 * alerts and curves. Pinning one date makes a failure reproducible and lets a test assert exact kopeck values instead
 * of "greater than zero".
 */
export const SEED_ANCHOR = '2026-11-20';

/**
 * Recreates the schema and loads the deterministic demo dataset.
 *
 * `resetTestDatabase` is the only supported way to get a clean schema (a migration change would survive TRUNCATE), and
 * the seed itself truncates every demo table. Tests that mutate alerts/scenarios/audit still clear those tables in
 * `beforeEach`, because files share one database and their order must not matter.
 *
 * @returns {Promise<void>}
 */
export async function seedDecisions() {
  await resetTestDatabase();
  await seed({ anchorDate: SEED_ANCHOR });
}

/**
 * Clears the tables an M5 test writes, without touching the seeded dimension and facts.
 *
 * `sessions` is included because the HTTP layer of M6 logs in; leaving a session row behind would make a later file
 * depend on an earlier login. `RESTART IDENTITY` keeps ids small in assertions that only compare within a test, while
 * the audit assertions match `entity`/`entity_id` rather than the row count.
 *
 * @param {{ query: (text: string) => Promise<unknown> }} pool
 * @returns {Promise<void>}
 */
export async function clearDecisionTables(pool) {
  await pool.query('TRUNCATE alerts, scenarios, audit_log, sessions RESTART IDENTITY');
}
