import { mountIsland } from '../lib/mount.js';
import { Card } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/EmptyState.jsx';
import { Skeleton } from '../components/ui/Skeleton.jsx';
import { ChartErrorBoundary } from '../components/charts/ChartErrorBoundary.jsx';
import { ChartFrame } from '../components/charts/ChartFrame.jsx';
import { CohortCurve } from '../components/charts/CohortCurve.jsx';
import { cohortsLabel } from '../../src/lib/metrics-labels.js';
import { HEAT_BUCKETS } from '../../src/lib/heat-scale.js';

/**
 * Cohorts island: retention heatmap, incomplete-cohort note and the weighted cumulative LTV curve.
 *
 * One island per page. The matrix is a real `<table>` rendered from the server's `table` contract: a caption, column
 * scopes and a row scope per cohort. Colour is never the only signal, every cell carries its percentage as text, and
 * a future month is `—` with an explanatory title instead of a painted zero. The cumulative LTV in that title is also
 * the cell's accessible name, so the detail is not hidden in a hover-only tooltip.
 *
 * @param {{
 *   horizonMonths: number,
 *   anchor: string,
 *   hasData: boolean,
 *   channelFilter: { id: string, code: string, name: string, label: string } | null,
 *   cohorts: object[],
 *   excludedIncomplete: Array<object>,
 *   channelLtv: object[],
 *   charts: { ltv: object },
 *   table: {
 *     caption: string,
 *     columns: Array<{ key: string, label: string, numeric: boolean, monthOffset?: number }>,
 *     rows: Array<{
 *       key: string, cohortMonth: string, cohortMonthDate: string, cohortLabel: string, cohortSizeLabel: string,
 *       isPartial: boolean, ltvLabel: string,
 *       cells: Array<{ monthOffset: number, label: string, heatClass: string, title: string }>,
 *     }>,
 *   },
 * }} props Screen model shared with `/api/v1/cohorts`.
 */
export function CohortsIsland({ horizonMonths, hasData, channelFilter, excludedIncomplete, charts, table }) {
  // Defensive loading state for a stale page that mounts without a model; the EJS skeleton covers the first paint.
  if (!table?.columns || !charts?.ltv) return <Skeleton lines={4} />;

  const monthColumns = table.columns.filter((column) => typeof column.monthOffset === 'number');
  const emptyCurveText = hasData
    ? 'У этих когорт ещё не прошёл весь горизонт: средний LTV по завершённым когортам считать не по чему. Неполные когорты остаются в таблице удержания.'
    : 'Когорт пока нет: кривая появится после первых клиентов с заказом и полным горизонтом наблюдения.';

  return (
    <div className="stack stack--lg">
      <Card
        title="Удержание по когортам"
        meta={`Когорты по месяцу первого заказа · горизонт ${horizonMonths} мес. · значения — доля вернувшихся клиентов`}
      >
        {channelFilter && <p className="matrix__filter">{channelFilter.label}</p>}

        {hasData ? (
          <div className="matrix-wrap" role="region" aria-label="Удержание по когортам: таблица данных" tabIndex={0}>
            <table className="matrix">
              <caption className="u-visually-hidden">{table.caption}</caption>
              <thead>
                <tr>
                  {table.columns.map((column) =>
                    typeof column.monthOffset === 'number' ? (
                      <th
                        scope="col"
                        className="matrix__month"
                        key={column.key}
                        aria-label={`${column.monthOffset} мес. после первого заказа`}
                      >
                        <span aria-hidden="true">{column.label}</span>
                      </th>
                    ) : (
                      <th scope="col" className={column.numeric ? 'u-right' : undefined} key={column.key}>
                        {column.label}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr className={row.isPartial ? 'is-partial' : undefined} key={row.key}>
                    <th scope="row" className="matrix__cohort">
                      {row.cohortLabel}
                      {row.isPartial && <span className="matrix__partial">неполная</span>}
                    </th>
                    <td className="u-right u-numeric">{row.cohortSizeLabel}</td>
                    {row.cells.map((cell) => (
                      <td
                        className={`matrix__cell ${cell.heatClass}`}
                        key={cell.monthOffset}
                        title={cell.title}
                        aria-label={`${cell.label}; ${cell.title}`}
                      >
                        {cell.label}
                      </td>
                    ))}
                    <td className="u-right u-numeric">{row.ltvLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="Когорт пока нет">
            Загрузите статистику или дождитесь первых клиентов: когорта появляется, когда у клиента есть первый заказ.
            Тогда здесь появятся месяцы удержания и кривая LTV.
          </EmptyState>
        )}

        {hasData && (
          <>
            <p className="matrix__note">
              Неполные данные: пунктиром отмечены когорты, у которых ещё не прошёл весь горизонт. Пустая ячейка «—»
              означает, что месяц ещё не наступил, а не нулевое удержание.
            </p>
            <MatrixLegend monthCount={monthColumns.length} />
          </>
        )}
      </Card>

      <ChartErrorBoundary island="cohorts" title={charts.ltv.title} table={charts.ltv.table}>
        <ChartFrame
          title={charts.ltv.title}
          caption={charts.ltv.caption}
          unit={charts.ltv.unit}
          ariaLabel={charts.ltv.ariaLabel}
          empty={!charts.ltv.hasData}
          emptyText={emptyCurveText}
          table={charts.ltv.table}
          height="md"
        >
          <CohortCurve chart={charts.ltv} />
        </ChartFrame>
      </ChartErrorBoundary>

      {excludedIncomplete.length > 0 && (
        <Card
          title="Когорты вне кривой"
          meta={`${cohortsLabel(excludedIncomplete.length)}: горизонт ${horizonMonths} мес. ещё не прошёл`}
        >
          <p className="matrix__note">
            Неполные когорты не вошли в кривую: их горизонт не закончился, поэтому средний LTV по ним был бы
            занижен. В матрице удержания они остаются — пунктирная граница и подпись «неполная».
          </p>
          <ul className="cohort-excluded">
            {excludedIncomplete.map((cohort) => (
              <li className="cohort-excluded__row" key={cohort.cohortMonth}>
                <span className="cohort-excluded__name">{cohort.cohortLabel}</span>
                <span className="cohort-excluded__meta">
                  {cohort.cohortSizeLabel} клиентов · наблюдено {cohort.monthsObserved} из {horizonMonths} мес.
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/**
 * The five-bucket heat legend plus the two non-measured states. Buckets and labels come from `heat-scale.js`, so the
 * legend cannot drift from the matrix; only the swatch colours live in the stylesheet.
 *
 * @param {{ monthCount: number }} props
 */
function MatrixLegend({ monthCount }) {
  return (
    <ul className="matrix-legend" aria-label="Обозначения матрицы удержания">
      {HEAT_BUCKETS.map((entry) => (
        <li className="matrix-legend__item" key={entry.className}>
          <span className={`matrix-legend__swatch ${entry.className}`} aria-hidden="true" />
          {entry.label}
        </li>
      ))}
      <li className="matrix-legend__item">
        <span className="matrix-legend__swatch matrix-legend__swatch--empty" aria-hidden="true" />
        «—» — месяц ещё не наступил
      </li>
      <li className="matrix-legend__item">
        <span className="matrix-legend__line" aria-hidden="true" />
        пунктир — неполная когорта ({monthCount} мес. горизонта)
      </li>
    </ul>
  );
}

// The entry is also imported by the SSR structure test, where there is no DOM to mount into.
if (typeof document !== 'undefined') {
  mountIsland(CohortsIsland, 'cohorts', 'Когорты');
}
