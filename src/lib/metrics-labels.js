/**
 * Russian labels for metric view-models.
 *
 * They live in one module because the same status or reason can surface in several services: a ranking exclusion and
 * a health row must not drift into «Мало данных» versus «Нет данных» for the same `no_data` code.
 */

/** One label per channel health status; the view never derives a label from the status code itself. */
export const HEALTH_STATUS_LABELS = Object.freeze({
  healthy: 'В норме',
  watch: 'Наблюдать',
  risk: 'Риск',
  no_data: 'Мало данных',
});

/** Russian names of the M2 channel kinds; the database and query string keep the English codes. */
export const CHANNEL_KIND_LABELS = Object.freeze({
  paid: 'Платный',
  owned: 'Собственный',
  earned: 'Заработанный',
});

/** One label per reason a channel is left out of the ranking. */
export const RANKING_REASON_LABELS = Object.freeze({
  no_data: HEALTH_STATUS_LABELS.no_data,
  missing_criterion: 'Не хватает метрики',
  blended: 'Сводная строка',
});

/**
 * @param {number} count
 * @returns {string} Russian noun form for a cohort count (`1 когорта`, `2 когорты`, `5 когорт`).
 */
export function cohortsLabel(count) {
  const tail = count % 100;
  const last = count % 10;
  if (tail >= 11 && tail <= 14) return `${count} когорт`;
  if (last === 1) return `${count} когорта`;
  if (last >= 2 && last <= 4) return `${count} когорты`;
  return `${count} когорт`;
}
