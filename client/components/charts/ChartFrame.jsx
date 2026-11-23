import { useId, useRef } from 'react';
import { EmptyState } from '../ui/EmptyState.jsx';
import { usePlotFocusGuard } from '../../lib/plot-focus.js';

/**
 * Accessible frame shared by every chart.
 *
 * Structure is fixed by the design rules: `<figure aria-labelledby>` → `<figcaption><h3 id>`, then the plot slot
 * with `role="img"` and a text alternative, then the duplicate table. The table lives **outside** the `role="img"`
 * subtree on purpose: a screen reader must read it as data, not as part of the picture. It is collapsed in
 * `<details>` so the visual layout stays compact.
 *
 * Every chart passes `accessibilityLayer={false}` to Recharts. The frame already supplies one accessible image and
 * one table; Recharts' own layer would add a second `tabindex="0"` control inside the image, announcing the same
 * values twice. The frame also owns a plot ref that removes Recharts' portal `<g>` layers from the Tab order — see
 * `client/lib/plot-focus.js`; pointer events stay enabled, so hover tooltips still work.
 *
 * An empty chart renders an explanation instead of an axis with a zero line, because a zero line at "no spend" and
 * a zero line at "spend measured as zero" are indistinguishable. Its action opens the duplicate table, the one real
 * next step on a screen with no data.
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
  const tableRef = useRef(null);
  const plotRef = usePlotFocusGuard();

  const hasTable = Array.isArray(table?.columns) && table.columns.length > 0;

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
        <EmptyState
          action={
            hasTable ? (
              <button
                className="btn btn--ghost btn--sm"
                type="button"
                onClick={() => revealDetails(tableRef.current)}
              >
                Открыть таблицу данных
              </button>
            ) : null
          }
        >
          {emptyText}
        </EmptyState>
      ) : (
        <div
          ref={plotRef}
          className={`chart__plot chart__plot--${height}`}
          role="img"
          aria-label={ariaLabel}
        >
          {children}
        </div>
      )}

      <ChartTable
        table={table}
        caption={`${title}: таблица данных`}
        detailsRef={tableRef}
      />
    </figure>
  );
}

/**
 * Opens the already-rendered duplicate table and moves focus to its disclosure control.
 *
 * Exported because a server render cannot run the click handler; the test drives this function with a minimal
 * `<details>` stand-in and proves both the open state and the focus move.
 *
 * @param {HTMLDetailsElement | null | undefined} details
 * @returns {void}
 */
export function revealDetails(details) {
  if (!details) return;
  details.open = true;
  details.querySelector('summary')?.focus();
}

/**
 * Duplicate table for a chart. Always rendered, including for an empty chart: the rows then carry dashes, which is
 * the only place a reader can see which weeks were actually requested.
 *
 * The scroll wrapper is a labelled `region` and a tab stop. On a 390px screen the table is wider than the card, and
 * a keyboard user cannot scroll a plain `overflow-x: auto` box without focusing it first.
 *
 * @param {{
 *   table: { columns: Array<{ key: string, label: string, numeric: boolean }>,
 *     rows: Array<{ key: string, cells: Record<string, string> }> },
 *   caption: string,
 *   detailsRef?: import('react').Ref<HTMLDetailsElement>,
 * }} props
 */
export function ChartTable({ table, caption, detailsRef = null }) {
  if (!table?.columns?.length) return null;

  return (
    <details className="chart__table" ref={detailsRef}>
      <summary>Показать таблицу</summary>
      <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}>
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
