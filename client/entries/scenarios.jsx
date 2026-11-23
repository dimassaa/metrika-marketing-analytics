import { mountIsland } from '../lib/mount.js';
import { Card } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/EmptyState.jsx';
import { Kpi } from '../components/ui/Kpi.jsx';
import { Skeleton } from '../components/ui/Skeleton.jsx';

/**
 * Scenarios island. One entry serves the builder and the saved detail because both render the same snapshot model:
 * the difference is `mode` and the absence of the relative budget block on a detail.
 *
 * The island shows the budget summary and the channel table. The GET form, the save form and the repeat link are
 * server-rendered in the EJS frames, so the screen works before React executes.
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
 *   empty: boolean,
 * }} props
 */
export function ScenariosIsland({ mode, name, invalid, invalidReason, budget, history, channels, totals, warnings }) {
  if (invalid) {
    return (
      <EmptyState title="Снимок не читается">
        {invalidReason ?? 'Сценарий сохранён другой версией схемы. Пересчитайте его из текущих данных.'}
      </EmptyState>
    );
  }
  if (!budget || !totals) return <Skeleton lines={4} />;

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
      label: 'За 12 месяцев',
      value: budget.forecast12mLabel,
      unit: 'BYN',
      hint: 'Недельный бюджет × 52',
      tone: null,
    },
    {
      id: 'current',
      label: 'Текущий расход',
      value: totals.current.spendLabel,
      unit: 'BYN',
      hint: `Среднее за 4 недели${history ? ` · история ${history.label}` : ''}`,
      tone: null,
    },
    {
      id: 'planned',
      label: 'План: клиенты',
      value: totals.planned.customersLabel,
      unit: null,
      hint: 'Прогноз на неделю',
      tone: null,
    },
  ];

  return (
    <div className="stack stack--lg">
      <Card
        title={mode === 'detail' ? `Снимок: ${name}` : 'Результат расчёта'}
        meta={
          budget.isAboveWarn
            ? 'Бюджет выше фактического более чем в 2 раза — прогноз за пределами наблюдённых расходов.'
            : `Потолок бюджета: ${budget.capLabel} BYN · текущий расход ${budget.warnAboveLabel} BYN × 2`
        }
      >
        <div className="grid grid--4">
          {kpis.map((item) => (
            <Kpi item={item} key={item.id} />
          ))}
        </div>
      </Card>

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
