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
 * Cumulative LTV curve: one cyan series over month offsets after the first order.
 *
 * A `null` point is a gap (`connectNulls={false}`), not a zero: the aggregation has no completed cohort at that
 * offset. A real measured zero is a numeric `0` and is drawn on the axis. Money stays in kopecks in the view-model;
 * the axis compacts to BYN and the tooltip/duplicate table use the shared exact formatter.
 *
 * @param {{ chart: {
 *   title: string,
 *   unit: 'BYN',
 *   series: Array<{ monthOffset: number, monthLabel: string, value: number | null }>,
 * } }} props
 */
export function CohortCurve({ chart }) {
  const stroke = chartTheme.seriesPrimary;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chart.series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={chartTheme.grid} vertical={false} />
        <XAxis
          dataKey="monthLabel"
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
          content={<ChartTooltip unit="BYN" names={{ value: chart.title }} />}
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
