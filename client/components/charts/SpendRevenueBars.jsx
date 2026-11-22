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
import { formatCompactCents } from '../../../src/lib/format.js';
import { chartTheme } from '../../lib/chartTheme.js';
import { ChartTooltip } from './ChartTooltip.jsx';

/** Legend wording names the attribution model, so a revenue bar is never mistaken for raw order revenue. */
const SERIES_NAMES = { spend: 'Расход', revenue: 'Выручка (атрибуция, последнее касание)' };

/**
 * Grouped weekly bars: spend in stone, attributed revenue in cyan.
 *
 * Bars are grouped rather than stacked because spend and revenue are compared, not summed; a stack would suggest a
 * total that has no meaning. Values are kopecks in the view-model and the Y axis compacts them to BYN thousands.
 *
 * @param {{ chart: {
 *   title: string,
 *   series: Array<{ weekStart: string, weekLabel: string, spend: number, revenue: number }>,
 * } }} props
 */
export function SpendRevenueBars({ chart }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={chart.series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
        <CartesianGrid stroke={chartTheme.grid} vertical={false} />
        <XAxis
          dataKey="weekLabel"
          tick={{ fontSize: chartTheme.fontSize, fill: chartTheme.axisText }}
          tickLine={false}
          axisLine={{ stroke: chartTheme.border }}
          minTickGap={16}
        />
        <YAxis
          tick={{ fontSize: chartTheme.fontSize, fill: chartTheme.axisText }}
          tickLine={false}
          axisLine={false}
          width={64}
          tickFormatter={(value) => formatCompactCents(Math.round(value))}
        />
        <Tooltip
          content={<ChartTooltip unit="BYN" names={SERIES_NAMES} />}
          cursor={{ fill: chartTheme.canvas }}
        />
        <Legend
          wrapperStyle={{ fontSize: chartTheme.fontSize, color: chartTheme.axisText }}
          iconType="square"
          iconSize={8}
        />
        <Bar
          dataKey="spend"
          name={SERIES_NAMES.spend}
          fill={chartTheme.seriesMuted}
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
        />
        <Bar
          dataKey="revenue"
          name={SERIES_NAMES.revenue}
          fill={chartTheme.seriesPrimary}
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
