import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCompactCents } from '../../../src/lib/format.js';
import { chartTheme } from '../../lib/chartTheme.js';
import { ChartTooltip } from './ChartTooltip.jsx';

/**
 * Legend wording names each attribution model, because the same channel revenue under three models is easy to
 * misread as three independent revenue streams.
 */
const SERIES_NAMES = {
  last_touch: 'Последнее касание',
  first_touch: 'Первое касание',
  linear: 'Линейная',
};

/**
 * Grouped revenue bars per channel for the three attribution models.
 *
 * Bars are grouped rather than stacked because the models are alternative allocations of the same revenue, not parts
 * of one total: a stack would suggest a sum that does not exist. The default model keeps the cyan accent; the other
 * two use stone so the eye can still follow the selected model without hiding the comparison.
 *
 * @param {{ chart: { series: Array<{
 *   channelId: string, channelCode: string, last_touch: number, first_touch: number, linear: number,
 * }> } }} props
 */
export function AttributionBars({ chart }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={chart.series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="24%">
        <CartesianGrid stroke={chartTheme.grid} vertical={false} />
        <XAxis
          dataKey="channelCode"
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
          dataKey="last_touch"
          name={SERIES_NAMES.last_touch}
          fill={chartTheme.seriesPrimary}
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
        />
        <Bar
          dataKey="first_touch"
          name={SERIES_NAMES.first_touch}
          fill={chartTheme.seriesMuted}
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
        />
        <Bar
          dataKey="linear"
          name={SERIES_NAMES.linear}
          // A darker stone than `seriesMuted` keeps the second comparison series distinguishable without a third hue.
          fill={chartTheme.axisText}
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
