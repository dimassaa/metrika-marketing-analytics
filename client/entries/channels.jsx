import { mountIsland } from '../lib/mount.js';
import { Card } from '../components/ui/Card.jsx';
import { EmptyState } from '../components/ui/EmptyState.jsx';
import { HealthBadge } from '../components/ui/HealthBadge.jsx';
import { Skeleton } from '../components/ui/Skeleton.jsx';
import { ChartErrorBoundary } from '../components/charts/ChartErrorBoundary.jsx';
import { ChartFrame } from '../components/charts/ChartFrame.jsx';
import { RomiBars } from '../components/charts/RomiBars.jsx';
import { ScoreStack, buildScoreStack } from '../components/charts/ScoreStack.jsx';
import { Sparkline } from '../components/charts/Sparkline.jsx';
import { formatCentsToByn, formatInteger, formatRatio } from '../../src/lib/format.js';

/**
 * The channels island: ranking table, health badges, weekly sparklines, the weighted-score stack and ROMI bars.
 *
 * The island neither fetches nor sorts. Every number, order and link comes from the screen model the server built,
 * so the page and `/api/v1/channels` are the same object and a sort is a normal GET navigation.
 *
 * @param {{
 *   page: 'channels',
 *   period: object,
 *   filters: object,
 *   weights: Record<string, number>,
 *   rows: object[],
 *   excluded: object[],
 *   sparklines: Record<string, Array<{ weekLabel: string, value: number | null }>>,
 *   chart: { romi: object },
 *   labels: object,
 *   sortLinks: Array<{ field: string, label: string, href: string, active: boolean,
 *     dir: 'asc' | 'desc' | null, ariaSort: string }>,
 * }} props Screen model.
 */
export function ChannelsIsland({ period, filters, weights, rows, excluded, sparklines, chart, labels, sortLinks }) {
  if (!Array.isArray(rows)) return <Skeleton lines={4} />;

  const sortByField = Object.fromEntries((sortLinks ?? []).map((link) => [link.field, link]));
  const stack = buildScoreStack(rows);
  const best = rows.find((row) => row.rank === 1) ?? null;
  const stackCaption =
    best === null
      ? 'Ни один канал не получил оценку: не хватает метрик за период.'
      : `Лучший результат — ${best.name}, ${formatRatio(best.score, { decimals: 1 })} из 100. Сумма вкладов равна оценке; для CAC больше баллов у дешёвого канала.`;
  const weightLabel = ['cac', 'romi', 'ltvCac', 'newCustomers']
    .map((key) => `${WEIGHT_LABELS[key]} ${Math.round(weights[key] * 100)}%`)
    .join(' · ');

  return (
    <div className="stack stack--lg">
      <Card
        title="Рейтинг каналов"
        meta={`${labels.period} · ${filters.label} · ${labels.channels} · ${weightLabel}`}
      >
        {rows.length === 0 ? (
          <EmptyState
            action={
              filters.active ? (
                <a className="btn btn--ghost btn--sm" href={filters.resetHref}>
                  Сбросить фильтры
                </a>
              ) : null
            }
          >
            По этому фильтру каналов нет. Измените статус или тип — или вернитесь к полному списку.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table--channels">
              <thead>
                <tr>
                  <SortableTh field="rank" sorts={sortByField} numeric>
                    Место
                  </SortableTh>
                  <th scope="col">Канал</th>
                  <th scope="col" className="u-right">
                    Расход
                  </th>
                  <SortableTh field="revenue" sorts={sortByField} numeric>
                    Выручка
                  </SortableTh>
                  <SortableTh field="newCustomers" sorts={sortByField} numeric>
                    Новые клиенты
                  </SortableTh>
                  <SortableTh field="cac" sorts={sortByField} numeric>
                    CAC
                  </SortableTh>
                  <th scope="col" className="u-right">
                    LTV12
                  </th>
                  <th scope="col" className="u-right">
                    ROMI
                  </th>
                  <th scope="col" className="u-right">
                    Payback
                  </th>
                  <th scope="col" className="u-right">
                    LTV:CAC
                  </th>
                  <SortableTh field="health" sorts={sortByField}>
                    Статус
                  </SortableTh>
                  <th scope="col">
                    <span className="u-visually-hidden">CAC по неделям</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.channelId}>
                    <td className="u-right">
                      <span className="table__rank">{row.rank === null ? '—' : row.rank}</span>
                      {row.score !== null && (
                        <span className="table__score">
                          {formatRatio(row.score, { decimals: 1 })}
                        </span>
                      )}
                    </td>
                    <td>
                      <a className="table__channel" href={`/app/channels/${row.channelId}`}>
                        {row.name}
                      </a>
                      <span className="table__meta">
                        {row.metaLabel ?? 'Канал'} <span className="u-muted">· {row.code}</span>
                      </span>
                    </td>
                    <td className="u-right">
                      <Money value={row.spendCents} />
                    </td>
                    <td className="u-right">
                      <Money value={row.revenueCents} />
                    </td>
                    <td className="u-right">{formatInteger(row.newCustomers)}</td>
                    <td className="u-right">
                      <Money value={row.cacCents} />
                    </td>
                    <td className="u-right">
                      <Money value={row.ltv12Cents} />
                    </td>
                    <td className="u-right">{row.romiLabel}</td>
                    <td className="u-right">{row.paybackLabel}</td>
                    <td className="u-right">{row.ratioLabel}</td>
                    <td>
                      <HealthBadge status={row.status} label={row.statusLabel} />
                    </td>
                    <td className="table__spark">
                      <Sparkline values={sparklines[row.channelId] ?? []} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ChartErrorBoundary island="channels" title="Вклад критериев в оценку" table={stack.table}>
        <ChartFrame
          title="Вклад критериев в оценку"
          caption={stackCaption}
          unit={null}
          ariaLabel={`Вклад критериев в оценку: ${stackCaption}`}
          empty={stack.series.length === 0}
          emptyText="Нечего складывать: ни один канал не получил оценку за этот период. Причины — в блоке ниже."
          table={stack.table}
          height="md"
        >
          <ScoreStack series={stack.series} />
        </ChartFrame>
      </ChartErrorBoundary>

      <ChartErrorBoundary island="channels" title={chart.romi.title} table={chart.romi.table}>
        <ChartFrame
          title={chart.romi.title}
          caption={chart.romi.caption}
          unit={chart.romi.unit}
          ariaLabel={chart.romi.ariaLabel}
          empty={!chart.romi.hasData}
          emptyText="Ни у одного канала нет измеренного ROMI: расход или клиенты за период нулевые. Значения — в таблице выше."
          table={chart.romi.table}
          height="md"
        >
          <RomiBars chart={chart.romi} />
        </ChartFrame>
      </ChartErrorBoundary>

      {excluded.length > 0 && (
        <Card title="Кто не попал в рейтинг" meta="Ранжирование считается по всем каналам; здесь — причины исключения.">
          <ul className="excluded">
            {excluded.map((entry) => (
              <li className="excluded__row" key={`${entry.channelId ?? entry.code}`}>
                {entry.channelId ? (
                  <a className="table__channel" href={`/app/channels/${entry.channelId}`}>
                    {entry.name ?? entry.code}
                  </a>
                ) : (
                  <span className="table__channel">{entry.name ?? entry.code}</span>
                )}
                <span className="excluded__reason">{entry.reasonLabel}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

const WEIGHT_LABELS = Object.freeze({
  cac: 'CAC',
  romi: 'ROMI',
  ltvCac: 'LTV:CAC',
  newCustomers: 'Клиенты',
});

/**
 * Sortable header. The link is a plain GET URL built by the server; the active column carries `aria-sort`, and the
 * arrow is decorative because the attribute already announces the state.
 *
 * @param {{ field: string, sorts: Record<string, object>, numeric?: boolean,
 *   children: import('react').ReactNode }} props
 */
function SortableTh({ field, sorts, numeric = false, children }) {
  const sort = sorts[field];
  const ariaSort = sort?.ariaSort ?? 'none';
  return (
    <th scope="col" aria-sort={ariaSort} className={numeric ? 'u-right' : undefined}>
      {sort ? (
        <a className={`table__sort${sort.active ? ' table__sort--active' : ''}`} href={sort.href}>
          {children}
          {sort.active && (
            <span className="table__sort-arrow" aria-hidden="true">
              {sort.dir === 'asc' ? ' ↑' : ' ↓'}
            </span>
          )}
        </a>
      ) : (
        children
      )}
    </th>
  );
}

/**
 * Money cell: formatted kopecks plus the BYN glyph from the single font. A missing amount is a dash, not zero.
 * @param {{ value: string | null }} props
 */
function Money({ value }) {
  if (value === null || value === undefined) return '—';
  return (
    <>
      {formatCentsToByn(value)} <span className="byn">BYN</span>
    </>
  );
}

mountIsland(ChannelsIsland, 'channels', 'Каналы');
