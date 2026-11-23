import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCompactCents } from '../../../src/lib/format.js';
import { chartTheme } from '../../lib/chartTheme.js';
import { ChartTooltip } from './ChartTooltip.jsx';

/**
 * One weekly line chart: CAC in BYN or ROMI in percent.
 *
 * CAC and ROMI are never on one axis. Their magnitudes differ by two orders, and the design rules forbid a second
 * Y axis; the dashboard therefore renders two small charts that share the x-axis weeks.
 *
 * A `null` point is a gap (`connectNulls={false}`), not a zero. `isAnimationActive={false}` keeps a screenshot
 * deterministic and respects the reduced-motion preference without a second code path.
 *
 * @param {{ chart: {
 *   id: string, title: string, unit: 'BYN' | '%',
 *   series: Array<{ weekStart: string, weekLabel: string, value: number | null }>,
 * } }} props
 */
export function CacRomiLines({ chart }) {
  const isMoney = chart.unit === 'BYN';
  const stroke = chartTheme.seriesPrimary;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart accessibilityLayer={false} data={chart.series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
          tickFormatter={(value) => (isMoney ? formatCompactCents(Math.round(value)) : `${value}`)}
        />
        <Tooltip
          content={<ChartTooltip unit={chart.unit} names={{ value: chart.title }} />}
          cursor={{ stroke: chartTheme.border }}
        />
        <Line
          type="monotone"
          dataKey="value"
          name={chart.title}
          stroke={stroke}
          strokeWidth={chartTheme.strokeWidth}
          dot={{ r: 3, strokeWidth: 0, fill: stroke }}
          activeDot={{ r: 4 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
