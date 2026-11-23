import { mountIsland } from '../lib/mount.js';
import { Card } from '../components/ui/Card.jsx';
import { Kpi } from '../components/ui/Kpi.jsx';
import { Skeleton } from '../components/ui/Skeleton.jsx';
import { AttributionBars } from '../components/charts/AttributionBars.jsx';
import { ChartErrorBoundary } from '../components/charts/ChartErrorBoundary.jsx';
import { ChartFrame } from '../components/charts/ChartFrame.jsx';

/**
 * Attribution island: model switch, the selected model's summary, grouped revenue bars and the delta table.
 *
 * One island per page, as on every other screen: the server already sent the full screen model, so a second fetch
 * would create a second source of truth. All three model series stay in the chart regardless of the selection — the
 * chosen model changes the summary and the highlighted link, not which models exist. Money and percentages are
 * ready-formatted server strings; React never re-derives a metric.
 *
 * @param {{
 *   page: 'attribution',
 *   period: { from: string, to: string, days: number, label: string },
 *   model: string,
 *   models: Array<{
 *     key: string, label: string, totalAttributedCents: string, totalAttributedLabel: string,
 *     totalSpendCents: string, totalSpendLabel: string, romiPct: number | null, romiLabel: string,
 *     selected: boolean,
 *   }>,
 *   summary: {
 *     key: string, label: string, totalRevenueCents: string, totalRevenueLabel: string,
 *     totalAttributedCents: string, totalAttributedLabel: string, totalSpendCents: string,
 *     totalSpendLabel: string, romiPct: number | null, romiLabel: string,
 *   },
 *   comparison: object[],
 *   charts: { revenue: object },
 *   table: {
 *     caption: string, deltaModel: string, deltaBaseLabel: string,
 *     columns: Array<{ key: string, label: string, numeric: boolean }>,
 *     rows: Array<{
 *       key: string, channelCode: string, lastTouchCents: string, firstTouchCents: string,
 *       linearCents: string, deltaCents: string, deltaPct: number | null,
 *       cells: Record<string, string>,
 *     }>,
 *   },
 *   selector: {
 *     current: string,
 *     options: Array<{ value: string, label: string, href: string, selected: boolean, ariaCurrent: 'page' | null }>,
 *   },
 *   unattributedNote: string | null,
 * }} props Screen model shared with `/api/v1/attribution`.
 */
export function AttributionIsland({ period, models, summary, charts, table, selector, unattributedNote }) {
  // Defensive loading state for a stale page that mounts without a model; the EJS skeleton covers the first paint.
  if (!summary || !charts?.revenue || !selector) return <Skeleton lines={4} />;

  const selected = models.find((entry) => entry.selected) ?? summary;

  const kpis = [
    {
      id: 'attributed',
      label: 'Атрибутированная выручка',
      value: summary.totalAttributedLabel,
      unit: 'BYN',
      hint: `Модель «${summary.label}»`,
      tone: null,
    },
    {
      id: 'spend',
      label: 'Расход',
      value: summary.totalSpendLabel,
      unit: 'BYN',
      hint: `За ${period.label}`,
      tone: null,
    },
    {
      id: 'romi',
      label: 'ROMI модели',
      value: summary.romiLabel,
      unit: null,
      hint: 'Возврат на маркетинг',
      tone: summary.romiPct !== null && summary.romiPct < 0 ? 'bad' : null,
    },
    {
      id: 'revenue',
      label: 'Выручка периода',
      value: summary.totalRevenueLabel,
      unit: 'BYN',
      hint: 'Все заказы периода',
      tone: null,
    },
  ];

  return (
    <div className="stack stack--lg">
      <nav className="segmented" aria-label="Модель атрибуции">
        {selector.options.map((option) => (
          <a
            className={option.selected ? 'segmented__item is-active' : 'segmented__item'}
            href={option.href}
            aria-current={option.ariaCurrent ?? undefined}
            key={option.value}
          >
            {option.label}
          </a>
        ))}
      </nav>

      <Card
        title={`Сводка: ${summary.label}`}
        meta={`Атрибуция за ${period.label} · ${selected.totalAttributedLabel} BYN из ${summary.totalRevenueLabel} BYN выручки периода`}
      >
        <div className="grid grid--4">
          {kpis.map((item) => (
            <Kpi item={item} key={item.id} />
          ))}
        </div>
      </Card>

      {unattributedNote && (
        <p className="alert alert--warning" role="status">
          {unattributedNote}. Часть заказов осталась без канала: у клиента не было касания в окне и не было канала
          привлечения, поэтому эти деньги не приписаны ни одному каналу.
        </p>
      )}

      <ChartErrorBoundary
        island="attribution"
        title={charts.revenue.title}
        table={charts.revenue.table}
      >
        <ChartFrame
          title={charts.revenue.title}
          caption={charts.revenue.caption}
          unit={charts.revenue.unit}
          ariaLabel={charts.revenue.ariaLabel}
          empty={!charts.revenue.hasData}
          emptyText="За период нет атрибутированной выручки: все три модели дают нули. Когда появятся заказы и касания, столбцы заполнятся."
          table={charts.revenue.table}
          height="md"
        >
          <AttributionBars chart={charts.revenue} />
        </ChartFrame>
      </ChartErrorBoundary>

      <Card
        title="Сравнение моделей по каналам"
        meta={`Дельта — ${table.deltaBaseLabel}: положительное значение означает, что линейная модель отдаёт каналу больше, чем последнее касание.`}
      >
        <div className="table-wrap">
          <table className="table table--attribution">
            <caption className="u-visually-hidden">{table.caption}</caption>
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
                  <th scope="row">{row.channelCode}</th>
                  {table.columns
                    .filter((column) => column.key !== 'channel')
                    .map((column) => (
                      <td key={column.key} className="u-right u-numeric">
                        {row.cells[column.key]}
                      </td>
                    ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="matrix__note">
          Все три модели раскладывают одну и ту же выручку периода; колонки не складываются между собой. Итог каждой
          модели указан в её карточке выбора и в сводке выше.
        </p>
      </Card>
    </div>
  );
}

// The entry is also imported by the SSR structure test, where there is no DOM to mount into.
if (typeof document !== 'undefined') {
  mountIsland(AttributionIsland, 'attribution', 'Атрибуция');
}
