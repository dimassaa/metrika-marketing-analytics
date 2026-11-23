import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { RANKING_CRITERIA } from '../../../src/lib/contributions.js';
import { formatRatio } from '../../../src/lib/format.js';
import { chartTheme } from '../../lib/chartTheme.js';

/**
 * Turns ranked rows into one stacked-bar series and its duplicate table.
 *
 * The server already sent `stack` segments (contribution per criterion, CAC inverted). This helper only reshapes
 * them for Recharts and marks the largest segment of each channel, which gets the single cyan accent.
 *
 * @param {object[]} rows Channel rows from the screen model.
 * @returns {{
 *   series: Array<{ channelId: string, name: string, score: number, cac: number, romi: number,
 *     ltvCac: number, newCustomers: number, largest: string }>,
 *   table: { columns: Array<{ key: string, label: string, numeric: boolean }>,
 *     rows: Array<{ key: string, cells: Record<string, string> }> },
 *   best: { channelId: string, name: string, score: number } | null,
 * }}
 */
export function buildScoreStack(rows) {
  const ranked = rows.filter((row) => row.rank !== null && Array.isArray(row.stack) && row.stack.length > 0);

  const series = ranked.map((row) => {
    const values = Object.fromEntries(row.stack.map((segment) => [segment.criterion, segment.value]));
    const largest = row.stack.reduce(
      (best, segment) => (segment.value > best.value ? segment : best),
      row.stack[0],
    );
    return {
      channelId: row.channelId,
      name: row.name,
      score: row.score,
      cac: values.cac ?? 0,
      romi: values.romi ?? 0,
      ltvCac: values.ltvCac ?? 0,
      newCustomers: values.newCustomers ?? 0,
      largest: largest.criterion,
    };
  });

  const best = series.reduce(
    (current, entry) => (current === null || entry.score > current.score ? entry : current),
    null,
  );

  return {
    best,
    series,
    table: {
      columns: [
        { key: 'channel', label: 'Канал', numeric: false },
        ...RANKING_CRITERIA.map((criterion) => ({
          key: criterion.criterion,
          label: criterion.label,
          numeric: true,
        })),
        { key: 'score', label: 'Оценка', numeric: true },
      ],
      rows: ranked.map((row) => {
        const cells = { channel: row.name, score: formatRatio(row.score, { decimals: 1 }) };
        for (const segment of row.stack) {
          cells[segment.criterion] = formatRatio(segment.value, { decimals: 1 });
        }
        return { key: row.channelId, cells };
      }),
    },
  };
}

/**
 * Caption for the score-stack card.
 *
 * The best row is derived from the rows the chart actually draws, never from a separate `rank === 1` lookup: when
 * the top-ranked channel is filtered out, the remaining bars still need a truthful summary. An empty series is the
 * only state that says "no scores".
 *
 * @param {ReturnType<typeof buildScoreStack>} stack Drawn bars and their best entry.
 * @returns {string}
 */
export function scoreStackCaption({ series, best }) {
  if (series.length === 0 || !best) {
    return 'Ни один канал не получил оценку: не хватает метрик за период.';
  }
  return `Лучший результат — ${best.name}, ${formatRatio(best.score, { decimals: 1 })} из 100. Сумма вкладов равна оценке с точностью до 0,1 п.п.; для CAC больше баллов у дешёвого канала.`;
}

/**
 * Stacked horizontal bars explaining the weighted score of each ranked channel.
 *
 * One BarChart for the whole card, categories are channels, and the four segments are the criteria. The largest
 * contribution of each bar is cyan; the rest are muted, so "where does the score mostly come from" is readable
 * without a legend or a second colour scale.
 *
 * @param {{ series: ReturnType<typeof buildScoreStack>['series'] }} props
 */
export function ScoreStack({ series }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart accessibilityLayer={false} data={series} layout="vertical" margin={{ top: 4, right: 24, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={chartTheme.grid} horizontal={false} />
        <XAxis
          type="number"
          domain={[0, 100]}
          tick={{ fontSize: chartTheme.fontSize, fill: chartTheme.axisText }}
          tickLine={false}
          axisLine={{ stroke: chartTheme.border }}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={128}
          tick={{ fontSize: chartTheme.fontSize, fill: chartTheme.axisText }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip content={<ScoreStackTooltip />} cursor={{ fill: chartTheme.canvas }} />
        {RANKING_CRITERIA.map((criterion) => (
          <Bar
            key={criterion.criterion}
            dataKey={criterion.criterion}
            name={criterion.label}
            stackId="score"
            isAnimationActive={false}
            fill={chartTheme.seriesMuted}
            stroke={chartTheme.surface}
            strokeWidth={1}
          >
            {series.map((entry) => (
              <Cell
                key={entry.channelId}
                fill={entry.largest === criterion.criterion ? chartTheme.seriesPrimary : chartTheme.seriesMuted}
              />
            ))}
          </Bar>
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Tooltip for score points, not money or percent: `30,0` without a unit.
 *
 * @param {{ active?: boolean, payload?: Array<{ dataKey: string, name?: string, value: number }>,
 *   label?: string }} props Recharts tooltip payload.
 */
function ScoreStackTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="chart__tooltip">
      <p className="chart__tooltip-label">{label}</p>
      <ul className="chart__tooltip-list">
        {payload.map((entry) => (
          <li className="chart__tooltip-row" key={entry.dataKey}>
            <span className="chart__tooltip-dot" aria-hidden="true" />
            <span className="chart__tooltip-name">{entry.name}</span>
            <strong className="chart__tooltip-value">{formatRatio(entry.value, { decimals: 1 })}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
