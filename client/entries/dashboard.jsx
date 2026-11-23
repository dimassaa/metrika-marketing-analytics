import { mountIsland } from '../lib/mount.js';
import { Card } from '../components/ui/Card.jsx';
import { HealthBadge } from '../components/ui/HealthBadge.jsx';
import { Kpi } from '../components/ui/Kpi.jsx';
import { Skeleton } from '../components/ui/Skeleton.jsx';
import { CacLtvScatter } from '../components/charts/CacLtvScatter.jsx';
import { CacRomiLines } from '../components/charts/CacRomiLines.jsx';
import { ChannelSpendBars } from '../components/charts/ChannelSpendBars.jsx';
import { ChartErrorBoundary } from '../components/charts/ChartErrorBoundary.jsx';
import { ChartFrame } from '../components/charts/ChartFrame.jsx';
import { SpendRevenueBars } from '../components/charts/SpendRevenueBars.jsx';

/**
 * The whole dashboard island: four KPI, the verdict and five charts (CAC, ROMI, weekly spend/revenue, spend by
 * channel and CAC×LTV).
 *
 * One island per page, not one per chart: the page already has the full screen model, so a second fetch or a second
 * model would be a second source of truth. Each chart is wrapped in its own `ChartErrorBoundary` so one bad series
 * cannot take the KPI down.
 *
 * @param {{ kpis: object, verdict: object, charts: object, labels: object, filter: object }} props Screen model.
 */
export function DashboardIsland({ kpis, verdict, charts, labels, filter }) {
  // Defensive loading state: the EJS skeleton covers the normal first paint, but a stale page can mount without a
  // model, and an empty grid would look like broken data rather than loading.
  if (!kpis?.items) return <Skeleton lines={4} />;

  const filterNote = filter?.active ? labels.filter : null;

  return (
    <div className="stack stack--lg">
      <div className="grid grid--4">
        {kpis.items.map((item) => (
          <Kpi item={item} key={item.id} />
        ))}
      </div>

      <Card title="Вердикт" meta={filterNote ?? labels.filter}>
        <div className="verdict">
          <HealthBadge status={verdict.status} label={verdict.label} />
          <p className="verdict__reason">{verdict.reason}</p>
        </div>
      </Card>

      <div className="stack stack--lg">
        <ChartErrorBoundary island="dashboard" title={charts.cac.title} table={charts.cac.table}>
          <ChartFrame
            title={charts.cac.title}
            caption={charts.cac.caption}
            unit={charts.cac.unit}
            ariaLabel={charts.cac.ariaLabel}
            empty={!charts.cac.hasData}
            table={charts.cac.table}
            height="sm"
          >
            <CacRomiLines chart={charts.cac} />
          </ChartFrame>
        </ChartErrorBoundary>

        <ChartErrorBoundary island="dashboard" title={charts.romi.title} table={charts.romi.table}>
          <ChartFrame
            title={charts.romi.title}
            caption={charts.romi.caption}
            unit={charts.romi.unit}
            ariaLabel={charts.romi.ariaLabel}
            empty={!charts.romi.hasData}
            table={charts.romi.table}
            height="sm"
          >
            <CacRomiLines chart={charts.romi} />
          </ChartFrame>
        </ChartErrorBoundary>

        <ChartErrorBoundary
          island="dashboard"
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

        <ChartErrorBoundary
          island="dashboard"
          title={charts.channelSpend.title}
          table={charts.channelSpend.table}
        >
          <ChartFrame
            title={charts.channelSpend.title}
            caption={charts.channelSpend.caption}
            unit={charts.channelSpend.unit}
            ariaLabel={charts.channelSpend.ariaLabel}
            empty={!charts.channelSpend.hasData}
            table={charts.channelSpend.table}
            height="md"
          >
            <ChannelSpendBars chart={charts.channelSpend} />
          </ChartFrame>
        </ChartErrorBoundary>

        <ChartErrorBoundary island="dashboard" title={charts.cacLtv.title} table={charts.cacLtv.table}>
          <ChartFrame
            title={charts.cacLtv.title}
            caption={charts.cacLtv.caption}
            unit={charts.cacLtv.unit}
            ariaLabel={charts.cacLtv.ariaLabel}
            empty={!charts.cacLtv.hasData}
            emptyText="Ни у одного канала нет одновременно CAC и LTV12: точку на графике построить не из чего. Значения — в таблице ниже."
            table={charts.cacLtv.table}
            height="md"
          >
            <CacLtvScatter chart={charts.cacLtv} />
          </ChartFrame>
        </ChartErrorBoundary>
      </div>
    </div>
  );
}

mountIsland(DashboardIsland, 'dashboard');
