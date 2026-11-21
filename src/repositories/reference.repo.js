import { minskToday } from '../lib/dates.js';

/**
 * Data access for the reporting reference values. Milestone 1 exposes a single aggregate: the data anchor, the last
 * calendar day covered by reported statistics.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 */
export function createReferenceRepository(db) {
  return {
    /**
     * Returns the data anchor as a `YYYY-MM-DD` calendar date.
     *
     * Every default period, alert window and cohort horizon is counted back from this date instead of the system
     * clock (metrics spec §0.1), so a stand opened weeks after the seed still reports the same numbers. On an empty
     * stand there is no latest date; falling back to Minsk today is part of the anchor definition, not a display
     * decision, which is why it lives here rather than in each controller.
     *
     * @returns {Promise<string>} Latest `daily_stats.stat_date`, or today in Europe/Minsk when no stats exist.
     */
    async getDataAnchor() {
      const { rows } = await db.query('SELECT max(stat_date)::text AS anchor FROM daily_stats');
      return rows[0]?.anchor ?? minskToday();
    },
  };
}
