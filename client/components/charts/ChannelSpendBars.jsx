import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCompactCents } from '../../../src/lib/format.js';
import { chartTheme } from '../../lib/chartTheme.js';
import { ChartTooltip } from './ChartTooltip.jsx';

/**
 * Horizontal spend-by-channel bars.
 *
 * One series only: spend is the question, so the Y axis groups channels instead of stacking two measures. The
 * highlighted channel (largest when no filter is active, every shown channel when one is) is cyan; the rest are
 * muted stone. Values are kopecks and the axis compacts them to BYN thousands.
 *
 * @param {{ chart: {
 *   title: string,
 *   series: Array<{ channelId: string, name: string, spend: number, highlight: boolean }>,
 * } }} props
 */
export function ChannelSpendBars({ chart }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart accessibilityLayer={false}
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
          tickFormatter={(value) => formatCompactCents(Math.round(value))}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={128}
          tick={{ fontSize: chartTheme.fontSize, fill: chartTheme.axisText }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          content={<ChartTooltip unit="BYN" names={{ spend: 'Расход' }} />}
          cursor={{ fill: chartTheme.canvas }}
        />
        <Bar dataKey="spend" name="Расход" isAnimationActive={false} radius={[0, 2, 2, 0]}>
          {chart.series.map((entry) => (
            <Cell
              key={entry.channelId}
              fill={entry.highlight ? chartTheme.seriesPrimary : chartTheme.seriesMuted}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
