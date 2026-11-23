import { EmptyState } from '../ui/EmptyState.jsx';
import { formatInteger } from '../../../src/lib/format.js';

/**
 * Retention matrix of one channel, rendered from the passport view-model.
 *
 * The grid never computes a percentage: labels, heat classes and cumulative LTV are already in the model, so the
 * passport and the cohorts screen share one `heatBucket` rule. A future cell shows `—` with the empty class; painting
 * it as 0% would claim that the whole cohort was inactive in a month that has not happened yet.
 *
 * @param {{ retention: {
 *   horizonMonths: number,
 *   anchor: string,
 *   hasData: boolean,
 *   incompleteCount: number,
 *   cohorts: Array<{
 *     cohortMonth: string, cohortLabel: string, cohortSize: number, ltvLabel: string,
 *     isPartial: boolean,
 *     cells: Array<{ monthOffset: number, retentionLabel: string, heatClass: string, cumLtvLabel: string }>,
 *   }>,
 * } }} props
 */
export function RetentionGrid({ retention }) {
  if (!retention?.hasData) {
    return (
      <EmptyState title="Когорт пока нет">
        Для этого канала ещё нет клиентов с завершённым или начатым месяцем удержания. Когда появятся заказы,
        матрица заполнится сама.
      </EmptyState>
    );
  }

  const months = Array.from({ length: retention.horizonMonths }, (_, index) => index);

  return (
    <div className="stack stack--sm">
      <div className="matrix-wrap" role="region" aria-label="Удержание клиентов канала: таблица данных" tabIndex={0}>
        <table className="matrix">
          <caption className="u-visually-hidden">
            Удержание клиентов канала по когортам за {retention.horizonMonths} месяцев от первого заказа
          </caption>
          <thead>
            <tr>
              <th scope="col">Когорта</th>
              <th scope="col" className="u-right">
                Клиенты
              </th>
              {months.map((month) => (
                <th scope="col" className="matrix__month" key={month}>
                  <span title={`${month} мес. после первого заказа`}>{month}</span>
                </th>
              ))}
              <th scope="col" className="u-right">
                LTV{retention.horizonMonths}, BYN
              </th>
            </tr>
          </thead>
          <tbody>
            {retention.cohorts.map((cohort) => (
              <tr className={cohort.isPartial ? 'is-partial' : undefined} key={cohort.cohortMonth}>
                <th scope="row" className="matrix__cohort">
                  {cohort.cohortLabel}
                  {cohort.isPartial && <span className="matrix__partial">неполная</span>}
                </th>
                <td className="u-right u-numeric">{formatInteger(cohort.cohortSize)}</td>
                {cohort.cells.map((cell) => (
                  <td
                    className={`matrix__cell ${cell.heatClass}`}
                    key={cell.monthOffset}
                    title={`Накопленный LTV: ${cell.cumLtvLabel} BYN`}
                    aria-label={`${cell.retentionLabel}; накопленный LTV: ${cell.cumLtvLabel} BYN`}
                  >
                    {cell.retentionLabel}
                  </td>
                ))}
                <td className="u-right u-numeric">{cohort.ltvLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="matrix__note">
        Месяц 0 — месяц первого заказа. Пунктиром отмечены неполные когорты: у них ещё не прошёл весь горизонт
        {retention.incompleteCount > 0 ? ` (${retention.incompleteCount})` : ''}. Пустая ячейка «—» означает, что
        месяц ещё не наступил, а не нулевое удержание.
      </p>
    </div>
  );
}
