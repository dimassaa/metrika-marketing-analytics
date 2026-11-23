import { mountIsland } from '../lib/mount.js';
import { Card } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/EmptyState.jsx';
import { Kpi } from '../components/ui/Kpi.jsx';
import { Skeleton } from '../components/ui/Skeleton.jsx';
import { ChartErrorBoundary } from '../components/charts/ChartErrorBoundary.jsx';
import { ChartFrame } from '../components/charts/ChartFrame.jsx';
import { ComparisonBars } from '../components/charts/ComparisonBars.jsx';
import { IncrementBars } from '../components/charts/IncrementBars.jsx';
import { SaturationCurve } from '../components/charts/SaturationCurve.jsx';

/**
 * Scenarios island. One entry serves the builder and the saved detail because both render the same snapshot model:
 * the difference is `mode` and the absence of the relative budget block on a detail.
 *
 * The GET form, the save form and the repeat link are server-rendered in the EJS frames, so the screen works before
 * React executes. Every chart reads the same channel rows as the table, and every number is a ready server string.
 *
 * @param {{
 *   page: 'scenarios',
 *   mode: 'builder' | 'detail',
 *   name?: string,
 *   invalid?: boolean,
 *   invalidReason?: string | null,
 *   budget: object | null,
 *   history: { weeks: number, label: string } | null,
 *   channels: object[],
 *   totals: object | null,
 *   warnings: string[],
 *   charts: { spend: object, customers: object, saturation: object, increment: object } | null,
 *   empty: boolean,
 *   weeksPerYear: number,
 * }} props
 */
export function ScenariosIsland({
  mode,
  name,
  invalid,
  invalidReason,
  budget,
  history,
  channels,
  totals,
  warnings,
  charts,
  weeksPerYear,
}) {
  if (invalid) {
    return (
      <EmptyState title="Снимок не читается">
        {invalidReason ?? 'Сценарий сохранён другой версией схемы. Пересчитайте его из текущих данных.'}
      </EmptyState>
    );
  }
  if (!budget || !totals || !charts) return <Skeleton lines={4} />;

  const kpis = [
    {
      id: 'weekly',
      label: 'Недельный бюджет',
      value: budget.weeklyLabel,
      unit: 'BYN',
      hint: 'Распределён между каналами с кривой',
      tone: null,
    },
    {
      id: 'forecast',
      label: `За 12 месяцев ×${weeksPerYear}`,
      value: budget.forecast12mLabel,
      unit: 'BYN',
      hint: `Недельный бюджет × ${weeksPerYear}`,
      tone: null,
    },
    {
      id: 'current',
      label: 'Текущий расход',
      value: totals.current.spendLabel,
      unit: 'BYN',
      hint: `Все выбранные каналы · среднее за 4 недели${history ? ` · история ${history.label}` : ''}`,
      tone: null,
    },
    {
      id: 'planned',
      label: 'План: клиенты',
      value: totals.planned.customersLabel,
      unit: null,
      hint: 'Прогноз на неделю при текущем LTV',
      tone: null,
    },
  ];

  const beforeAfter = [
    {
      key: 'spend',
      label: 'Расход за неделю',
      before: totals.current.spendLabel,
      after: totals.planned.spendLabel,
      unit: 'BYN',
    },
    {
      key: 'customers',
      label: 'Новые клиенты за неделю',
      before: totals.current.customersLabel,
      after: totals.planned.customersLabel,
      unit: null,
    },
    {
      key: 'cac',
      label: 'CAC',
      before: totals.current.cacLabel,
      after: totals.forecast.cacLabel,
      unit: 'BYN',
    },
    {
      key: 'revenue',
      label: 'Выручка за 12 месяцев',
      before: '—',
      after: totals.forecast.revenue12Label,
      unit: 'BYN',
    },
    {
      key: 'romi',
      label: 'ROMI за 12 месяцев',
      before: '—',
      after: totals.forecast.romiLabel,
      unit: null,
    },
  ];

  return (
    <div className="stack stack--lg">
      <Card
        title={mode === 'detail' ? `Снимок: ${name}` : 'Результат расчёта'}
        meta={
          `Потолок бюджета: ${budget.capLabel} BYN (${budget.maxMultiplier}× базы оптимизации ` +
          `${budget.baselineLabel} BYN) · предупреждение выше ${budget.warnAboveLabel} BYN ` +
          `(${budget.warnMultiplier}×)`
        }
      >
        <div className="grid grid--4">
          {kpis.map((item) => (
            <Kpi item={item} key={item.id} />
          ))}
        </div>
      </Card>

      <Card
        title="До и после"
        meta={
          'Сейчас — все выбранные каналы, план — только каналы с кривой (база оптимизации). ' +
          'Прогноз на 12 месяцев при текущем LTV; CAC и ROMI появляются только там, где модель предсказывает клиентов.'
        }
      >
        <div className="table-wrap" role="region" aria-label="Сравнение до и после" tabIndex={0}>
          <table className="table">
            <caption className="u-visually-hidden">Сценарий: текущее состояние и план</caption>
            <thead>
              <tr>
                <th scope="col">Показатель</th>
                <th scope="col" className="u-right">Сейчас</th>
                <th scope="col" className="u-right">План</th>
              </tr>
            </thead>
            <tbody>
              {beforeAfter.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  <td className="u-right u-numeric u-nowrap">
                    {row.before}
                    {row.before !== '—' && row.unit === 'BYN' && <span className="byn"> BYN</span>}
                  </td>
                  <td className="u-right u-numeric u-nowrap">
                    {row.after}
                    {row.after !== '—' && row.unit === 'BYN' && <span className="byn"> BYN</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid--2">
        <ChartErrorBoundary island="scenarios" title={charts.spend.title} table={charts.spend.table}>
          <ChartFrame
            title={charts.spend.title}
            caption={charts.spend.caption}
            unit={charts.spend.unit}
            ariaLabel={charts.spend.ariaLabel}
            empty={!charts.spend.hasData}
            emptyText="Нет измеренного расхода: текущее среднее и план — нули. Таблица ниже перечисляет каналы."
            table={charts.spend.table}
            height="md"
          >
            <ComparisonBars chart={charts.spend} />
          </ChartFrame>
        </ChartErrorBoundary>

        <ChartErrorBoundary
          island="scenarios"
          title={charts.customers.title}
          table={charts.customers.table}
        >
          <ChartFrame
            title={charts.customers.title}
            caption={charts.customers.caption}
            unit={charts.customers.unit}
            ariaLabel={charts.customers.ariaLabel}
            empty={!charts.customers.hasData}
            emptyText="Нет измеренных клиентов: прогноз не из чего строить. Таблица ниже перечисляет каналы."
            table={charts.customers.table}
            height="md"
          >
            <ComparisonBars chart={charts.customers} />
          </ChartFrame>
        </ChartErrorBoundary>

        <ChartErrorBoundary
          island="scenarios"
          title={charts.saturation.title}
          table={charts.saturation.table}
        >
          <ChartFrame
            title={charts.saturation.title}
            caption={charts.saturation.caption}
            unit={charts.saturation.unit}
            ariaLabel={charts.saturation.ariaLabel}
            empty={!charts.saturation.hasData}
            emptyText="Кривая не построена: у канала линейная модель или нет недель с клиентами. Наблюдения остаются в таблице, а причина — в предупреждениях расчёта."
            table={charts.saturation.table}
            height="md"
          >
            <SaturationCurve chart={charts.saturation} />
          </ChartFrame>
        </ChartErrorBoundary>

        <ChartErrorBoundary
          island="scenarios"
          title={charts.increment.title}
          table={charts.increment.table}
        >
          <ChartFrame
            title={charts.increment.title}
            caption={charts.increment.caption}
            unit={charts.increment.unit}
            ariaLabel={charts.increment.ariaLabel}
            empty={!charts.increment.hasData}
            emptyText="Нет каналов с планом: прирост считать не из чего."
            table={charts.increment.table}
            height="sm"
          >
            <IncrementBars chart={charts.increment} />
          </ChartFrame>
        </ChartErrorBoundary>
      </div>

      <Card
        title="Каналы сценария"
        meta="Текущий расход — среднее за четыре полные недели, план — сумма, которую оптимизатор распределил по кривым."
      >
        <div className="table-wrap" role="region" aria-label="Каналы сценария" tabIndex={0}>
          <table className="table">
            <caption className="u-visually-hidden">План по каналам</caption>
            <thead>
              <tr>
                <th scope="col">Канал</th>
                <th scope="col">Кривая</th>
                <th scope="col" className="u-right">Сейчас</th>
                <th scope="col" className="u-right">План</th>
                <th scope="col" className="u-right">Клиенты</th>
                <th scope="col" className="u-right">CAC</th>
                <th scope="col" className="u-right">ROMI 12</th>
                <th scope="col">Примечание</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => (
                <tr key={channel.channelId}>
                  <th scope="row">{channel.channelName}</th>
                  <td>{channel.modelLabel}</td>
                  <td className="u-right u-numeric u-nowrap">
                    {channel.current.spendLabel} <span className="byn">BYN</span>
                  </td>
                  <td className="u-right u-numeric u-nowrap">
                    {channel.planned ? (
                      <>
                        {channel.planned.spendLabel} <span className="byn">BYN</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="u-right u-numeric">
                    {channel.forecast ? channel.forecast.customersLabel : '—'}
                  </td>
                  <td className="u-right u-numeric u-nowrap">
                    {channel.forecast ? channel.forecast.cacLabel : '—'}
                  </td>
                  <td className="u-right u-numeric">{channel.forecast ? channel.forecast.romiLabel : '—'}</td>
                  <td>{channel.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {warnings.length > 0 && (
        <Card title="Предупреждения расчёта" meta="Честные ограничения снимка, а не ошибки.">
          <ul className="stack stack--sm">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// The entry is also imported by SSR structure tests, where there is no DOM to mount into.
if (typeof document !== 'undefined') {
  mountIsland(ScenariosIsland, 'scenarios', 'Сценарии');
}
