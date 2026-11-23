import { mountIsland } from '../lib/mount.js';
import { Card } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/EmptyState.jsx';
import { HealthBadge } from '../components/ui/HealthBadge.jsx';
import { Kpi } from '../components/ui/Kpi.jsx';
import { Skeleton } from '../components/ui/Skeleton.jsx';
import { CacRomiLines } from '../components/charts/CacRomiLines.jsx';
import { ChartErrorBoundary } from '../components/charts/ChartErrorBoundary.jsx';
import { ChartFrame } from '../components/charts/ChartFrame.jsx';
import { RetentionGrid } from '../components/charts/RetentionGrid.jsx';
import { SpendRevenueBars } from '../components/charts/SpendRevenueBars.jsx';
import { cellFormat } from '../../src/lib/cell-format.js';
import { formatCentsToByn } from '../../src/lib/format.js';

/**
 * Channel passport island: metric strip, target block, CAC/ROMI/spend charts, funnel, retention and campaigns.
 *
 * One island per page, as with the dashboard: the server already sent the full screen model, so a second fetch would
 * create a second source of truth. Every number here is a ready field of that model; React formats money through the
 * shared `format.js` and campaign cells through the single `cell-format` token map. The M2 edit form and the campaign
 * quick-add stay in the EJS frame and are not duplicated by this island.
 *
 * @param {{
 *   page: 'channel',
 *   channel: { id: string, name: string, kindLabel: string, isActive: boolean, activityLabel: string },
 *   period: { from: string, to: string, days: number, label: string },
 *   health: object,
 *   charts: { cac: object, romi: object, spendRevenue: object },
 *   retention: object,
 *   funnel: object,
 *   campaigns: object[],
 *   campaignsTruncated: boolean,
 *   targets: Array<object>,
 * }} props Screen model.
 */
export function ChannelIsland({
  channel,
  period,
  health,
  charts,
  retention,
  funnel,
  campaigns,
  campaignsTruncated,
  targets,
}) {
  if (!health) return <Skeleton lines={4} />;

  const metrics = [
    {
      id: 'cac',
      label: 'CAC',
      value: health.cacLabel,
      unit: health.cacCents === null ? null : 'BYN',
      hint: 'Стоимость нового клиента',
      tone: null,
    },
    {
      id: 'ltv',
      label: 'LTV12',
      value: health.ltvLabel,
      unit: health.ltv12Cents === null ? null : 'BYN',
      hint: 'Маржа клиента за 12 месяцев',
      tone: null,
    },
    {
      id: 'romi',
      label: 'ROMI',
      value: health.romiLabel,
      unit: null,
      hint: 'Возврат на маркетинг',
      tone: health.romiPct !== null && health.romiPct < 0 ? 'bad' : null,
    },
    {
      id: 'payback',
      label: 'Payback',
      value: health.paybackLabel,
      unit: null,
      hint: 'Оценка окупаемости CAC',
      tone: null,
    },
    {
      id: 'ltv-cac',
      label: 'LTV:CAC',
      value: health.ratioLabel,
      unit: null,
      hint: 'Запас прочности',
      tone: null,
    },
    {
      id: 'spend',
      label: 'Расход',
      value: formatCentsToByn(health.spendCents),
      unit: 'BYN',
      hint: `За ${period.label}`,
      tone: null,
    },
    {
      id: 'revenue',
      label: 'Выручка',
      value: formatCentsToByn(health.revenueCents),
      unit: 'BYN',
      hint: 'Атрибуция, последнее касание',
      tone: null,
    },
  ];

  return (
    <div className="stack stack--lg">
      <Card title="Метрики канала" meta={`${channel.kindLabel} · ${period.label}`}>
        <div className="stack">
          <div className="cluster">
            <HealthBadge status={health.status} label={health.statusLabel} />
            <p className="u-muted">
              {channel.isActive
                ? 'Канал активен: метрики считаются за выбранный период.'
                : 'Архивный канал: история сохранена, новые кампании по нему не создаются.'}
            </p>
          </div>

          <div className="grid grid--4">
            {metrics.map((item) => (
              <Kpi item={item} key={item.id} />
            ))}
          </div>
        </div>
      </Card>

      <Card
        title="Цели канала"
        meta={
          targets.every((target) => !target.targetSet)
            ? 'Цель не задана — сравнение появится после настройки канала.'
            : 'Факт за период против цели; цвет — только у статуса, не у суммы.'
        }
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Цель</th>
                <th scope="col" className="u-right">
                  План
                </th>
                <th scope="col" className="u-right">
                  Факт
                </th>
                <th scope="col">Статус</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((target) => (
                <tr key={target.metric}>
                  <th scope="row">{target.label}</th>
                  <td className="u-right u-nowrap">
                    <Amount value={target.targetLabel} unit={target.unit} />
                  </td>
                  <td className="u-right u-nowrap">
                    <Amount value={target.factLabel} unit={target.unit} />
                  </td>
                  <td>
                    <TargetStatus target={target} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <ChartErrorBoundary island="channel" title={charts.cac.title} table={charts.cac.table}>
        <ChartFrame
          title={charts.cac.title}
          caption={charts.cac.caption}
          unit={charts.cac.unit}
          ariaLabel={charts.cac.ariaLabel}
          empty={!charts.cac.hasData}
          emptyText="Ни одна неделя периода не дала измеренного CAC: у канала не было и клиентов, и расходов одновременно."
          table={charts.cac.table}
          height="sm"
        >
          <CacRomiLines chart={charts.cac} />
        </ChartFrame>
      </ChartErrorBoundary>

      <ChartErrorBoundary island="channel" title={charts.romi.title} table={charts.romi.table}>
        <ChartFrame
          title={charts.romi.title}
          caption={charts.romi.caption}
          unit={charts.romi.unit}
          ariaLabel={charts.romi.ariaLabel}
          empty={!charts.romi.hasData}
          emptyText="ROMI не определён ни в одной неделе: расход был нулевым или не было выручки. Значения — в таблице."
          table={charts.romi.table}
          height="sm"
        >
          <CacRomiLines chart={charts.romi} />
        </ChartFrame>
      </ChartErrorBoundary>

      <ChartErrorBoundary
        island="channel"
        title={charts.spendRevenue.title}
        table={charts.spendRevenue.table}
      >
        <ChartFrame
          title={charts.spendRevenue.title}
          caption={charts.spendRevenue.caption}
          unit={charts.spendRevenue.unit}
          ariaLabel={charts.spendRevenue.ariaLabel}
          empty={!charts.spendRevenue.hasData}
          table={charts.spendRevenue.table}
          height="md"
        >
          <SpendRevenueBars chart={charts.spendRevenue} />
        </ChartFrame>
      </ChartErrorBoundary>

      <Card title={funnel.title} meta="Показы → заказы. Клиенты и заказы считаются по каналу привлечения.">
        {funnel.hasData ? (
          <ol className="funnel">
            {funnel.stages.map((stage) => (
              <li className="funnel__stage" key={stage.key}>
                <div className="funnel__head">
                  <span className="funnel__label">{stage.label}</span>
                  <span className="funnel__value">{stage.valueLabel}</span>
                </div>
                <div className="funnel__row">
                  <meter
                    className="funnel__meter"
                    min="0"
                    max={stage.meterMax}
                    value={stage.value}
                    aria-label={
                      stage.sharePct === null
                        ? `${stage.label}: ${stage.valueLabel}; доля не определена — показов нет`
                        : `${stage.label}: ${stage.valueLabel}, ${stage.shareLabel} от показов`
                    }
                  >
                    {stage.valueLabel}
                  </meter>
                  <span className="funnel__share">
                    {stage.sharePct === null ? 'показов нет' : `${stage.shareLabel} от показов`}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState title="Воронка пуста">
            За период нет ни показов, ни клиентов, ни заказов. Когда статистика загрузится, этапы заполнятся.
          </EmptyState>
        )}
        <p className="matrix__note">
          Этапы приходят из разных источников — статистики кампаний, клиентов и заказов, — поэтому доля от показов
          может быть выше 100%: это честное расхождение, а не обрезанное значение.
        </p>
      </Card>

      <Card
        title="Удержание клиентов"
        meta={`Когорты по месяцу первого заказа · горизонт ${retention.horizonMonths} месяцев`}
      >
        <RetentionGrid retention={retention} />
      </Card>

      <Card title="Кампании: CAC за период" meta="CAC считается по расходу и клиентам выбранного периода, а не за всё время.">
        {campaigns.length === 0 ? (
          <EmptyState title="Кампаний нет">
            У канала ещё нет кампаний. Когда они появятся, расход начнёт раскладываться по периодам.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Кампания</th>
                  <th scope="col" className="u-right">
                    Расход
                  </th>
                  <th scope="col" className="u-right">
                    Новые клиенты
                  </th>
                  <th scope="col" className="u-right">
                    CAC
                  </th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => (
                  <tr key={campaign.id}>
                    <td>
                      {campaign.name}
                      <span className="table__meta">{campaign.code}</span>
                    </td>
                    <td className="u-right u-nowrap">
                      <Amount value={cellFormat('cents', campaign.spendCents)} unit="BYN" />
                    </td>
                    <td className="u-right u-numeric">{cellFormat('integer', campaign.newCustomers)}</td>
                    <td className="u-right u-nowrap">
                      <Amount value={cellFormat('cents', campaign.cacCents)} unit="BYN" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {campaignsTruncated && (
          <p className="matrix__note">
            Показаны первые {campaignsCountLabel(campaigns.length)}. Полный список с фильтрами — на странице
            кампаний.
          </p>
        )}
      </Card>
    </div>
  );
}

/**
 * @param {number} count
 * @returns {string} Russian noun form for the campaign count.
 */
function campaignsCountLabel(count) {
  const tail = count % 100;
  const last = count % 10;
  if (tail >= 11 && tail <= 14) return `${count} кампаний`;
  if (last === 1) return `${count} кампания`;
  if (last >= 2 && last <= 4) return `${count} кампании`;
  return `${count} кампаний`;
}

/**
 * Money text with the NBRB glyph. A dash is a real "not measured" value, so it never gets a currency suffix.
 * @param {{ value: string, unit: 'BYN' | null }} props
 */
function Amount({ value, unit }) {
  if (value === null || value === undefined || value === '—') return '—';
  return (
    <>
      {value}
      {unit === 'BYN' && (
        <>
          {' '}
          <span className="byn">BYN</span>
        </>
      )}
    </>
  );
}

/**
 * Three distinct states, not one: no configured target, a target without a fact, and a real comparison.
 * @param {{ target: { targetSet: boolean, factSet: boolean, tone: 'good' | 'bad' | null } }} props
 */
function TargetStatus({ target }) {
  if (!target.targetSet) return <span className="target__status target__status--none">Цель не задана</span>;
  if (!target.factSet) {
    return <span className="target__status target__status--unknown">Нет данных для сравнения</span>;
  }
  return (
    <span className={`target__status target__status--${target.tone}`}>
      {target.tone === 'good' ? 'В цели' : 'Вне цели'}
    </span>
  );
}

// The entry is also imported by `tests/unit/channel-island.test.js`, where there is no DOM to mount into.
if (typeof document !== 'undefined') {
  mountIsland(ChannelIsland, 'channel', 'Карточка канала');
}
