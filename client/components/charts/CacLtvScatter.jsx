import {
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { formatCentsToByn, formatCompactCents, formatInteger } from '../../../src/lib/format.js';
import { chartTheme } from '../../lib/chartTheme.js';

/**
 * CAC×LTV12 scatter, one bubble per channel.
 *
 * CAC is the X axis and LTV12 the Y axis; the bubble size is the channel's new customer count. The axes carry
 * different meanings, so this is the one chart where two measures share a plot — there is still no third axis.
 * Channels missing either money value never reach `chart.series` (the server drops them), so every bubble is a
 * complete measurement.
 *
 * @param {{ chart: {
 *   title: string,
 *   series: Array<{
 *     channelId: string, name: string, cac: number, ltv: number, newCustomers: number,
 *   }>,
 * } }} props
 */
export function CacLtvScatter({ chart }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ScatterChart margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={chartTheme.grid} />
        <XAxis
          type="number"
          dataKey="cac"
          name="CAC"
          tick={{ fontSize: chartTheme.fontSize, fill: chartTheme.axisText }}
          tickLine={false}
          axisLine={{ stroke: chartTheme.border }}
          tickFormatter={(value) => formatCompactCents(Math.round(value))}
        />
        <YAxis
          type="number"
          dataKey="ltv"
          name="LTV12"
          width={64}
          tick={{ fontSize: chartTheme.fontSize, fill: chartTheme.axisText }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(value) => formatCompactCents(Math.round(value))}
        />
        {/* There is no visible third axis: Z only maps new customers to the bubble radius. */}
        <ZAxis type="number" dataKey="newCustomers" range={[60, 240]} name="Новые клиенты" />
        <Tooltip content={<ScatterTooltip />} cursor={{ strokeDasharray: '3 3', stroke: chartTheme.border }} />
        <Legend
          wrapperStyle={{ fontSize: chartTheme.fontSize, color: chartTheme.axisText }}
          iconType="circle"
          iconSize={8}
        />
        <Scatter
          name="Каналы"
          data={chart.series}
          fill={chartTheme.seriesPrimary}
          isAnimationActive={false}
        />
      </ScatterChart>
    </ResponsiveContainer>
  );
}

/**
 * Readable tooltip for a bubble: the channel name plus both money measures and the customer count that set its
 * size. Values are kopecks in the screen model, so the shared formatter keeps the tooltip identical to the table.
 *
 * @param {{
 *   active?: boolean,
 *   payload?: Array<{ payload: {
 *     name: string, cac: number, ltv: number, newCustomers: number,
 *   } }>,
 * }} props
 */
function ScatterTooltip({ active, payload }) {
  if (!active || !payload || payload.length === 0) return null;

  const point = payload[0].payload;

  return (
    <div className="chart__tooltip">
      <p className="chart__tooltip-label">{point.name}</p>
      <ul className="chart__tooltip-list">
        <li className="chart__tooltip-row">
          <span className="chart__tooltip-name">CAC</span>
          <strong className="chart__tooltip-value">{formatCentsToByn(point.cac)} BYN</strong>
        </li>
        <li className="chart__tooltip-row">
          <span className="chart__tooltip-name">LTV12</span>
          <strong className="chart__tooltip-value">{formatCentsToByn(point.ltv)} BYN</strong>
        </li>
        <li className="chart__tooltip-row">
          <span className="chart__tooltip-name">Новые клиенты</span>
          <strong className="chart__tooltip-value">{formatInteger(point.newCustomers)}</strong>
        </li>
      </ul>
    </div>
  );
}
