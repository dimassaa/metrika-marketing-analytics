import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCompactCents } from '../../../src/lib/format.js';
import { ATTRIBUTION_MODEL_LABELS } from '../../../src/lib/metrics-labels.js';
import { chartTheme } from '../../lib/chartTheme.js';
import { ChartTooltip } from './ChartTooltip.jsx';

/**
 * Legend wording comes from the shared model labels, because the same channel revenue under three models is easy to
 * misread as three independent revenue streams.
 */
const SERIES_NAMES = ATTRIBUTION_MODEL_LABELS;

/** Legend order follows the bars; Recharts' default content reorders payload, so the island renders its own list. */
const LEGEND_ORDER = ['last_touch', 'first_touch', 'linear'];

/**
 * Fill of one model series: the selected model keeps the cyan accent, the two comparison models stay muted so the eye
 * can still follow the chosen allocation without hiding the alternatives.
 *
 * @param {string} key Model data key.
 * @param {string} selectedModel Currently selected model.
 * @returns {string} Hex token from `chartTheme`.
 */
export function attributionBarColor(key, selectedModel) {
  if (key === selectedModel) return chartTheme.seriesPrimary;
  return key === LEGEND_ORDER.find((entry) => entry !== selectedModel) ? chartTheme.seriesMuted : chartTheme.seriesStoneDark;
}

/**
 * Legend swatch class that mirrors `attributionBarColor`; colours stay in the stylesheet, not in an inline style.
 *
 * @param {string} key Model data key.
 * @param {string} selectedModel Currently selected model.
 * @returns {string}
 */
export function attributionSwatchClass(key, selectedModel) {
  if (key === selectedModel) return 'chart-legend__swatch chart-legend__swatch--primary';
  return key === LEGEND_ORDER.find((entry) => entry !== selectedModel)
    ? 'chart-legend__swatch chart-legend__swatch--muted'
    : 'chart-legend__swatch chart-legend__swatch--stone';
}

/**
 * Legend as a real list: order is data-driven and the swatch colours come from stylesheet tokens, matching the bars.
 * Recharts' default legend is not used because it rendered the payload in reverse bar order.
 *
 * @param {{ selectedModel: string }} props
 * @returns {import('react').ReactElement}
 */
export function AttributionLegend({ selectedModel }) {
  return (
    <ul className="chart-legend" aria-label="Модели атрибуции">
      {LEGEND_ORDER.map((key) => (
        <li className="chart-legend__item" key={key}>
          <span className={attributionSwatchClass(key, selectedModel)} aria-hidden="true" />
          {SERIES_NAMES[key]}
        </li>
      ))}
    </ul>
  );
}

/**
 * Grouped revenue bars per channel for the three attribution models.
 *
 * Bars are grouped rather than stacked because the models are alternative allocations of the same revenue, not parts
 * of one total: a stack would suggest a sum that does not exist. The selected model gets the cyan accent; the other
 * two use stone so the eye can still follow the selected model without hiding the comparison.
 *
 * @param {{ chart: { selectedModel: string, series: Array<{
 *   channelId: string, channelCode: string, last_touch: number, first_touch: number, linear: number,
 * }> } }} props
 */
export function AttributionBars({ chart }) {
  const selectedModel = chart.selectedModel ?? 'last_touch';

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart accessibilityLayer={false} data={chart.series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="24%">
        <CartesianGrid stroke={chartTheme.grid} vertical={false} />
        <XAxis
          dataKey="channelName"
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
        <Legend content={<AttributionLegend selectedModel={selectedModel} />} />
        <Bar
          dataKey="last_touch"
          name={SERIES_NAMES.last_touch}
          fill={attributionBarColor('last_touch', selectedModel)}
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
        />
        <Bar
          dataKey="first_touch"
          name={SERIES_NAMES.first_touch}
          fill={attributionBarColor('first_touch', selectedModel)}
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
        />
        <Bar
          dataKey="linear"
          name={SERIES_NAMES.linear}
          fill={attributionBarColor('linear', selectedModel)}
          radius={[2, 2, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
