import { mountIsland } from '../lib/mount.js';
import { Card } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/EmptyState.jsx';
import { Skeleton } from '../components/ui/Skeleton.jsx';
import { ChartErrorBoundary } from '../components/charts/ChartErrorBoundary.jsx';
import { ChartFrame } from '../components/charts/ChartFrame.jsx';
import { CohortCurve } from '../components/charts/CohortCurve.jsx';

/**
 * Cohorts island: retention heatmap, incomplete-cohort note and the weighted cumulative LTV curve.
 *
 * One island per page. The matrix is a real `<table>` rendered from the server's `table` contract: a caption, column
 * scopes and a row scope per cohort. Colour is never the only signal, every cell carries its percentage as text, and
 * a future month is `—` with an explanatory title instead of a painted zero.
 *
 * @param {{
 *   horizonMonths: number,
 *   anchor: string,
 *   hasData: boolean,
 *   incompleteCount: number,
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
export function CohortsIsland({ horizonMonths, hasData, excludedIncomplete, charts, table }) {
  // Defensive loading state for a stale page that mounts without a model; the EJS skeleton covers the first paint.
  if (!table?.columns || !charts?.ltv) return <Skeleton lines={4} />;

  const monthColumns = table.columns.filter((column) => typeof column.monthOffset === 'number');

  return (
    <div className="stack stack--lg">
      <Card
        title="Удержание по когортам"
        meta={`Когорты по месяцу первого заказа · горизонт ${horizonMonths} мес. · значения — доля вернувшихся клиентов`}
      >
        {hasData ? (
          <div className="matrix-wrap">
            <table className="matrix">
              <caption className="u-visually-hidden">{table.caption}</caption>
              <thead>
                <tr>
                  {table.columns.map((column) =>
                    typeof column.monthOffset === 'number' ? (
                      <th scope="col" className="matrix__month" key={column.key}>
                        <span title={`${column.monthOffset} мес. после первого заказа`}>{column.label}</span>
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

        <p className="matrix__note">
          Пунктиром отмечены неполные когорты: у них ещё не прошёл весь горизонт. Пустая ячейка «—» означает, что месяц
          ещё не наступил, а не нулевое удержание.
        </p>
        <MatrixLegend monthCount={monthColumns.length} />
      </Card>

      <ChartErrorBoundary island="cohorts" title={charts.ltv.title} table={charts.ltv.table}>
        <ChartFrame
          title={charts.ltv.title}
          caption={charts.ltv.caption}
          unit={charts.ltv.unit}
          ariaLabel={charts.ltv.ariaLabel}
          empty={!charts.ltv.hasData}
          emptyText="Ни одна когорта ещё не прошла горизонт полностью: средний LTV считать не по чему. Неполные когорты остаются в таблице удержания."
          table={charts.ltv.table}
          height="md"
        >
          <CohortCurve chart={charts.ltv} />
        </ChartFrame>
      </ChartErrorBoundary>

      {excludedIncomplete.length > 0 && (
        <Card
          title="Когорты вне кривой"
          meta={`${excludedIncomplete.length} неполных когорт: горизонт ${horizonMonths} мес. ещё не прошёл`}
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
 * The five-bucket heat legend plus the two non-measured states. The swatches reuse the same `.heat-*` classes as the
 * cells, so a legend cannot drift from the matrix.
 *
 * @param {{ monthCount: number }} props
 */
function MatrixLegend({ monthCount }) {
  return (
    <ul className="matrix-legend" aria-label="Обозначения матрицы удержания">
      {HEAT_LEGEND.map((entry) => (
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

const HEAT_LEGEND = Object.freeze([
  { className: 'heat-0', label: '0–19%' },
  { className: 'heat-1', label: '20–39%' },
  { className: 'heat-2', label: '40–59%' },
  { className: 'heat-3', label: '60–79%' },
  { className: 'heat-4', label: '80–100%' },
]);

// The entry is also imported by the SSR structure test, where there is no DOM to mount into.
if (typeof document !== 'undefined') {
  mountIsland(CohortsIsland, 'cohorts', 'Когорты');
}
