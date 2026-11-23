import { mountIsland } from '../lib/mount.js';
import { Card } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/EmptyState.jsx';
import { Kpi } from '../components/ui/Kpi.jsx';
import { Skeleton } from '../components/ui/Skeleton.jsx';

/**
 * Alerts island: the unfiltered summary, the last-check line and the table row count.
 *
 * The filterable table and its dismissal forms are server-rendered in `pages/alerts.ejs`; this island deliberately
 * does not duplicate them. Every number is a ready string from the screen model, which is the same object
 * `/api/v1/alerts` returns.
 *
 * @param {{
 *   page: 'alerts',
 *   window: { from: string, to: string, label: string },
 *   filters: { status: string, severity: string, channelId: string | null },
 *   rows: object[],
 *   summary: {
 *     activeLabel: string, criticalLabel: string, warningLabel: string,
 *     resolvedLabel: string, dismissedLabel: string,
 *     lastRecalculatedLabel: string, isStale: boolean,
 *   },
 *   pagination: { page: number, total: number, hasMore: boolean },
 *   empty: boolean,
 * }} props
 */
export function AlertsIsland({ window, summary, rows, pagination, empty }) {
  if (!summary) return <Skeleton lines={4} />;

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
        title="Сводка проверки"
        meta={`Последняя проверка: ${summary.lastRecalculatedLabel}${summary.isStale ? ' · данные старше часа' : ''}`}
      >
        <div className="grid grid--4">
          {kpis.map((item) => (
            <Kpi item={item} key={item.id} />
          ))}
        </div>
      </Card>

      <Card
        title="Что показывает таблица"
        meta={`${pagination.total} строк по текущему фильтру · окно ${window.label}`}
      >
        {empty ? (
          <EmptyState title="По фильтру ничего не найдено">
            Смените статус или важность — сводка выше всегда считает все алерты, а таблица следует фильтру.
          </EmptyState>
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
