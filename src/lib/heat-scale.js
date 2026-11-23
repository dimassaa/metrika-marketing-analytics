/**
 * Heat-map scale shared by the retention grid of the channel passport and the cohort matrix.
 *
 * The palette itself lives in `public/css/app.css`; this module only decides which of the five buckets a cell
 * belongs to, so the two screens cannot colour the same percentage differently. A future or unmeasured cell is
 * `is-empty`, never bucket `heat-0`: "no data" and "0% retention" are different facts.
 */

/** Number of painted buckets; the stylesheet defines `.heat-0` … `.heat-4`. */
export const HEAT_BUCKET_COUNT = 5;

/**
 * @param {number | null | undefined} retentionPct Retention percentage, or null/undefined for a future cell.
 * @returns {'heat-0' | 'heat-1' | 'heat-2' | 'heat-3' | 'heat-4' | 'is-empty'}
 * @throws {TypeError} When a present value is not a finite number; a broken cell must fail loudly, not look like 0%.
 */
export function heatBucket(retentionPct) {
  if (retentionPct === null || retentionPct === undefined) return 'is-empty';
  if (typeof retentionPct !== 'number' || !Number.isFinite(retentionPct)) {
    throw new TypeError(`heatBucket expected a finite percentage, got ${JSON.stringify(retentionPct)}`);
  }

  // Retention is defined on [0, 100]; clamping keeps a defensive value in the last bucket instead of producing a
  // class the stylesheet does not define.
  const bounded = Math.min(100, Math.max(0, retentionPct));
  const index = Math.min(HEAT_BUCKET_COUNT - 1, Math.floor(bounded / 20));
  return `heat-${index}`;
}
