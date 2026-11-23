import { mountIsland } from '../lib/mount.js';
import { Card } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/EmptyState.jsx';
import { Kpi } from '../components/ui/Kpi.jsx';
import { Skeleton } from '../components/ui/Skeleton.jsx';
import { CacRomiLines } from '../components/charts/CacRomiLines.jsx';
import { ChartErrorBoundary } from '../components/charts/ChartErrorBoundary.jsx';
import { ChartFrame } from '../components/charts/ChartFrame.jsx';

/**
 * Alerts island: the unfiltered summary, the last-trigger line and the weekly CAC line of the problem channel.
 *
 * The filterable table and its dismissal forms are server-rendered in `pages/alerts.ejs`; this island deliberately
 * does not duplicate them. Every number is a ready string from the screen model, which is the same object
 * `/api/v1/alerts` returns. The chart's series comes from `listWeeklySeries` for the selected channel, so it shows
 * measured weeks rather than a line interpolated from alert values.
 *
 * @param {{
 *   page: 'alerts',
 *   window: { from: string, to: string, label: string },
 *   filters: { status: string, severity: string, channelId: string | null },
 *   rows: object[],
 *   summary: {
 *     activeLabel: string, criticalLabel: string, warningLabel: string,
 *     resolvedLabel: string, dismissedLabel: string,
 *     lastTriggeredLabel: string, isStale: boolean,
 *   },
 *   chart: object | null,
 *   pagination: { page: number, total: number, hasMore: boolean },
 *   empty: boolean,
 *   emptyState?: { title: string, text: string },
 * }} props
 */
export function AlertsIsland({ window, summary, rows, chart, pagination, empty, emptyState }) {
  if (!summary) return <Skeleton lines={4} />;

  const emptyCopy = emptyState ?? {
    title: 'По фильтру ничего не найдено',
    text: 'Смените статус, важность или канал: сводка выше считает все алерты, а таблица следует фильтру.',
  };

  const kpis = [
    {
      id: 'active',
      label: 'Активные',
      value: summary.activeLabel,
      unit: null,
      hint: `Окно ${window.label}`,
      tone: null,
    },
    {
      id: 'critical',
      label: 'Критичные',
      value: summary.criticalLabel,
      unit: null,
      hint: 'Требуют решения в первую очередь',
      tone: Number(summary.critical) > 0 ? 'bad' : null,
    },
    {
      id: 'warning',
      label: 'Предупреждения',
      value: summary.warningLabel,
      unit: null,
      hint: 'Следят за порогом',
      tone: null,
    },
    {
      id: 'closed',
      label: 'Закрытые и скрытые',
      value: `${summary.resolvedLabel} / ${summary.dismissedLabel}`,
      unit: null,
      hint: 'Закрыты правилом / скрыты вручную',
      tone: null,
    },
  ];

  return (
    <div className="stack stack--lg">
      <Card
        title="Сводка алертов"
        meta={`Последнее срабатывание: ${summary.lastTriggeredLabel}${summary.isStale ? ' · данные старше часа' : ''}`}
      >
        <div className="grid grid--4">
          {kpis.map((item) => (
            <Kpi item={item} key={item.id} />
          ))}
        </div>
      </Card>

      {chart && (
        <ChartErrorBoundary island="alerts" title={chart.title} table={chart.table}>
          <ChartFrame
            title={chart.title}
            caption={chart.caption}
            unit={chart.unit}
            ariaLabel={chart.ariaLabel}
            empty={!chart.hasData}
            emptyText="За 12 недель нет недель с новыми клиентами: CAC не из чего считать. Таблица ниже перечисляет все недели окна, а не только измеренные."
            table={chart.table}
            height="sm"
          >
            <CacRomiLines chart={chart} />
          </ChartFrame>
        </ChartErrorBoundary>
      )}

      <Card
        title="Что показывает таблица"
        meta={`${pagination.total} строк по текущему фильтру · окно ${window.label}`}
      >
        {empty ? (
          <EmptyState title={emptyCopy.title}>{emptyCopy.text}</EmptyState>
        ) : (
          <p className="u-muted">
            В таблице {rows.length} строк на этой странице. Значения и пороги показаны в единицах правила: CAC — в
            BYN, ROMI — в процентах, окупаемость — в месяцах, LTV:CAC — коэффициентом.
          </p>
        )}
      </Card>
    </div>
  );
}

// The entry is also imported by SSR structure tests, where there is no DOM to mount into.
if (typeof document !== 'undefined') {
  mountIsland(AlertsIsland, 'alerts', 'Алерты');
}
