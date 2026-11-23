import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCompactCents, formatRatio } from '../../../src/lib/format.js';
import { chartTheme } from '../../lib/chartTheme.js';
import { ChartTooltip } from './ChartTooltip.jsx';

/**
 * Grouped bars for a scenario comparison: today's measured value next to the planned one.
 *
 * Both bars share one axis because both are the same measure — weekly spend in BYN or weekly customers. The current
 * bar is muted stone and the plan is cyan, so the direction of the change is visible before reading the numbers.
 * Channels are laid out horizontally because their names are long and a rotation would hurt the 390px layout.
 *
 * @param {{ chart: {
 *   unit: 'BYN' | 'чел.',
 *   compareKey: 'planned' | 'forecast',
 *   compareLabel: string,
 *   series: Array<{
 *     channelId: string, name: string, current: number, compare: number, plannedMissing: boolean,
 *   }>,
 * } }} props
 */
export function ComparisonBars({ chart }) {
  const isMoney = chart.unit === 'BYN';
  const names = { current: 'Сейчас', compare: chart.compareLabel };

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        accessibilityLayer={false}
        data={chart.series}
        layout="vertical"
        margin={{ top: 4, right: 24, bottom: 0, left: 0 }}
        barGap={2}
      >
        <CartesianGrid stroke={chartTheme.grid} horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: chartTheme.fontSize, fill: chartTheme.axisText }}
          tickLine={false}
          axisLine={{ stroke: chartTheme.border }}
          tickFormatter={(value) =>
            isMoney ? formatCompactCents(Math.round(value)) : formatRatio(value, { decimals: 0 })
          }
        />
        <YAxis
          type="category"
          dataKey="name"
          width={128}
          interval={0}
          tick={{ fontSize: chartTheme.fontSize, fill: chartTheme.axisText }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          content={<ChartTooltip unit={chart.unit} names={names} />}
          cursor={{ fill: chartTheme.canvas }}
        />
        <Legend
          formatter={(value) => <span className="chart__legend-label">{value}</span>}
          iconType="square"
          iconSize={8}
        />
        <Bar
          dataKey="current"
          name={names.current}
          fill={chartTheme.seriesMuted}
          radius={[0, 2, 2, 0]}
          isAnimationActive={false}
        />
        <Bar
          dataKey="compare"
          name={names.compare}
          fill={chartTheme.seriesPrimary}
          radius={[0, 2, 2, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
