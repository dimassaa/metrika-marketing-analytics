import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatRatio } from '../../../src/lib/format.js';
import { chartTheme } from '../../lib/chartTheme.js';
import { ChartTooltip } from './ChartTooltip.jsx';

/**
 * Colour of one increment bar. Growth is the cyan accent; a negative contribution is muted stone rather than a status
 * colour, because status colours are reserved for health and alert semantics.
 * @param {number} delta Weekly customer increment.
 * @returns {string} Hex colour from the chart theme.
 */
export function incrementBarColor(delta) {
  return delta >= 0 ? chartTheme.seriesPrimary : chartTheme.seriesMuted;
}

/**
 * Horizontal per-channel customer increment (`forecast − current`).
 *
 * A waterfall would need intermediate cumulative values the model does not have; a bar per channel states the
 * contribution directly and keeps the sign. The zero line makes a negative channel readable without a second axis.
 *
 * @param {{ chart: { series: Array<{ channelId: string, name: string, delta: number }> } }} props
 */
export function IncrementBars({ chart }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        accessibilityLayer={false}
        data={chart.series}
        layout="vertical"
        margin={{ top: 4, right: 24, bottom: 0, left: 0 }}
      >
        <CartesianGrid stroke={chartTheme.grid} horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: chartTheme.fontSize, fill: chartTheme.axisText }}
          tickLine={false}
          axisLine={{ stroke: chartTheme.border }}
          tickFormatter={(value) => formatRatio(value, { decimals: 0 })}
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
        <ReferenceLine x={0} stroke={chartTheme.axisMuted} />
        <Tooltip
          content={<ChartTooltip unit="чел." names={{ delta: 'Прирост' }} signed />}
          cursor={{ fill: chartTheme.canvas }}
        />
        <Bar dataKey="delta" name="Прирост" isAnimationActive={false} radius={[0, 2, 2, 0]}>
          {chart.series.map((entry) => (
            <Cell key={entry.channelId} fill={incrementBarColor(entry.delta)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
