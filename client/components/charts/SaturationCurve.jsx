import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCentsToByn, formatCompactCents, formatRatio } from '../../../src/lib/format.js';
import { chartTheme } from '../../lib/chartTheme.js';
import { ChartTooltip } from './ChartTooltip.jsx';

const SERIES_NAMES = { curve: 'Кривая q(b)', observed: 'Наблюдённые недели' };

/**
 * Saturation curve with the observed weeks on top.
 *
 * The line is the fitted `q(b) = K(1 − e^{−b/S})`, the points are actual Monday–Sunday weeks. Both axes are
 * meaningful: X is weekly spend in BYN, so the shape answers "what does the next rouble buy". The duplicate table
 * carries the same observations, including the curve value the model did not see.
 *
 * @param {{ chart: {
 *   series: Array<{ spend: number, spendLabel: string, curve: number, observed: number | null }>,
 * } }} props
 */
export function SaturationCurve({ chart }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart
        accessibilityLayer={false}
        data={chart.series}
        margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
      >
        <CartesianGrid stroke={chartTheme.grid} vertical={false} />
        <XAxis
          type="number"
          dataKey="spend"
          domain={[0, 'dataMax']}
          tick={{ fontSize: chartTheme.fontSize, fill: chartTheme.axisText }}
          tickLine={false}
          axisLine={{ stroke: chartTheme.border }}
          tickFormatter={(value) => formatCompactCents(Math.round(value))}
        />
        <YAxis
          tick={{ fontSize: chartTheme.fontSize, fill: chartTheme.axisText }}
          tickLine={false}
          axisLine={false}
          width={56}
          tickFormatter={(value) => formatRatio(value, { decimals: 0 })}
        />
        <Tooltip
          content={
            <ChartTooltip
              unit="чел."
              names={SERIES_NAMES}
              labelFormatter={(value) => `${formatCentsToByn(Math.round(value))} BYN за неделю`}
            />
          }
          cursor={{ stroke: chartTheme.border }}
        />
        <Legend
          formatter={(value) => <span className="chart__legend-label">{value}</span>}
          iconType="square"
          iconSize={8}
        />
        <Line
          type="monotone"
          dataKey="curve"
          name={SERIES_NAMES.curve}
          stroke={chartTheme.seriesPrimary}
          strokeWidth={chartTheme.strokeWidth}
          dot={false}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
        <Scatter
          dataKey="observed"
          name={SERIES_NAMES.observed}
          fill={chartTheme.seriesStoneDark}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
