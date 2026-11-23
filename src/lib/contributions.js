/**
 * Presentation of the weighted ranking score.
 *
 * The server already decided every number in `contributions`; this module only names the criteria for the stack bar.
 * It is shared so the table tooltip, the chart legend and the unit test cannot disagree about the order or the labels.
 */

/** Order is the contract of the stack bar and of the ranking view-model. */
export const RANKING_CRITERIA = Object.freeze([
  Object.freeze({ criterion: 'cac', label: 'CAC' }),
  Object.freeze({ criterion: 'romi', label: 'ROMI' }),
  Object.freeze({ criterion: 'ltvCac', label: 'LTV:CAC' }),
  Object.freeze({ criterion: 'newCustomers', label: 'Новые клиенты' }),
]);

/** Criterion → Russian label, the one map used by the stack bar and its table. */
export const RANKING_CRITERION_LABELS = Object.freeze(
  Object.fromEntries(RANKING_CRITERIA.map((entry) => [entry.criterion, entry.label])),
);

/**
 * @param {object} row A ranked channel row or one entry of `ranking.ranked`.
 * @returns {Array<{
 *   criterion: 'cac' | 'romi' | 'ltvCac' | 'newCustomers',
 *   label: string,
 *   value: number,
 *   scored: number,
 *   weight: number,
 * }>} One segment per criterion, in the ranking order; an unranked row has no segments.
 * @throws {TypeError} When a contribution names an unknown criterion or carries a non-finite value.
 */
export function toStackSegments(row) {
  if (!Array.isArray(row?.contributions) || row.contributions.length === 0) return [];

  return row.contributions.map((entry) => {
    const label = RANKING_CRITERION_LABELS[entry.criterion];
    if (label === undefined) {
      throw new TypeError(`unknown ranking criterion: ${String(entry.criterion)}`);
    }
    if (!Number.isFinite(entry.contribution) || !Number.isFinite(entry.scored) || !Number.isFinite(entry.weight)) {
      throw new TypeError(`ranking contribution for ${entry.criterion} is not a finite number`);
    }
    return {
      criterion: entry.criterion,
      label,
      value: entry.contribution,
      scored: entry.scored,
      weight: entry.weight,
    };
  });
}
