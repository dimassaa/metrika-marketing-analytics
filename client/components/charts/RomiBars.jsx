import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { chartTheme } from '../../lib/chartTheme.js';
import { ChartTooltip } from './ChartTooltip.jsx';

/**
 * Horizontal ROMI bars, one per channel.
 *
 * ROMI is a percentage and shares no axis with money: this chart has its own frame below the table. Only the leader
 * is cyan; every other bar is muted stone so the eye finds the best return without a legend. Values are the plain
 * percent numbers from the screen model and are formatted through the shared formatter.
 *
 * @param {{ chart: { series: Array<{ channelId: string, name: string, romi: number, highlight: boolean }> } }} props
 */
export function RomiBars({ chart }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart accessibilityLayer={false} data={chart.series} layout="vertical" margin={{ top: 4, right: 24, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={chartTheme.grid} horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: chartTheme.fontSize, fill: chartTheme.axisText }}
          tickLine={false}
          axisLine={{ stroke: chartTheme.border }}
          tickFormatter={(value) => `${Math.round(value)}%`}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={128}
          tick={{ fontSize: chartTheme.fontSize, fill: chartTheme.axisText }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip content={<ChartTooltip unit="%" names={{ romi: 'ROMI' }} />} cursor={{ fill: chartTheme.canvas }} />
        <Bar dataKey="romi" name="ROMI" isAnimationActive={false} radius={[0, 2, 2, 0]}>
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
