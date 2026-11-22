import { useId } from 'react';
import { EmptyState } from '../ui/EmptyState.jsx';

/**
 * Accessible frame shared by every chart.
 *
 * Structure is fixed by the design rules: `<figure aria-labelledby>` → `<figcaption><h3 id>`, then the plot slot
 * with `role="img"` and a text alternative, then the duplicate table. The table lives **outside** the `role="img"`
 * subtree on purpose: a screen reader must read it as data, not as part of the picture. It is collapsed in
 * `<details>` so the visual layout stays compact.
 *
 * An empty chart renders an explanation instead of an axis with a zero line, because a zero line at "no spend" and
 * a zero line at "spend measured as zero" are indistinguishable.
 *
 * @param {{
 *   title: string,
 *   caption: string,
 *   unit: string | null,
 *   ariaLabel: string,
 *   empty: boolean,
 *   emptyText?: import('react').ReactNode,
 *   table: { columns: Array<{ key: string, label: string, numeric: boolean }>,
 *     rows: Array<{ key: string, cells: Record<string, string> }> },
 *   height?: 'sm' | 'md',
 *   children?: import('react').ReactNode,
 * }} props
 */
export function ChartFrame({
  title,
  caption,
  unit,
  ariaLabel,
  empty,
  emptyText = 'За выбранный период нет измеренных значений: показывать нулевую линию было бы неправдой.',
  table,
  height = 'md',
  children,
}) {
  const titleId = useId();

  return (
    <figure className="card chart" aria-labelledby={titleId}>
      <figcaption className="chart__head">
        <h3 className="chart__title" id={titleId}>
          {title}
        </h3>
        <p className="chart__caption">{caption}</p>
        {unit && (
          <span className="chart__unit" aria-hidden="true">
            {unit === 'BYN' ? <span className="byn">BYN</span> : unit}
          </span>
        )}
      </figcaption>

      {empty ? (
        <EmptyState>{emptyText}</EmptyState>
      ) : (
        <div className={`chart__plot chart__plot--${height}`} role="img" aria-label={ariaLabel}>
          {children}
        </div>
      )}

      <ChartTable table={table} caption={`${title}: таблица данных`} />
    </figure>
  );
}

/**
 * Duplicate table for a chart. Always rendered, including for an empty chart: the rows then carry dashes, which is
 * the only place a reader can see which weeks were actually requested.
 *
 * @param {{
 *   table: { columns: Array<{ key: string, label: string, numeric: boolean }>,
 *     rows: Array<{ key: string, cells: Record<string, string> }> },
 *   caption: string,
 * }} props
 */
export function ChartTable({ table, caption }) {
  if (!table?.columns?.length) return null;

  return (
    <details className="chart__table">
      <summary>Показать таблицу</summary>
      <div className="table-wrap">
        <table className="table">
          <caption className="u-visually-hidden">{caption}</caption>
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th key={column.key} scope="col" className={column.numeric ? 'u-right' : undefined}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.key}>
                {table.columns.map((column) => (
                  <td key={column.key} className={column.numeric ? 'u-numeric' : undefined}>
                    {row.cells[column.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
