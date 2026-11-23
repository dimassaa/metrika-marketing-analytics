import { Line, LineChart } from 'recharts';
import { chartTheme } from '../../lib/chartTheme.js';
import { usePlotFocusGuard } from '../../lib/plot-focus.js';

/**
 * Tiny weekly CAC line inside a table cell.
 *
 * Fixed geometry is the point: a responsive chart would measure its cell on every row and could push the table
 * layout around while it mounts. There are no axes, grid lines, dots, tooltip or animation; `null` points are left
 * as gaps, because a week without customers is not a week with zero CAC. The trend is a companion to the formatted
 * CAC column, so the cell hides the decorative SVG from assistive technology and keeps the number readable. The
 * wrapper also runs the plot focus guard: Recharts' bare `<g>` layers become Tab stops in Chromium, and a decorative
 * trend must not steal focus from the channel link.
 *
 * @param {{ values: Array<{ weekLabel: string, value: number | null }> }} props Weekly CAC in kopecks.
 */
export function Sparkline({ values }) {
  const plotRef = usePlotFocusGuard();
  const measured = Array.isArray(values) ? values.filter((point) => typeof point.value === 'number').length : 0;

  if (measured < 2) {
    return (
      <div className="sparkline sparkline--empty" title="Недостаточно недель для тренда">
        —
      </div>
    );
  }

  return (
    <div ref={plotRef} className="sparkline" aria-hidden="true" title="CAC по неделям">
      <LineChart
        accessibilityLayer={false}
        data={values}
        width={72}
        height={20}
        margin={{ top: 2, right: 1, bottom: 2, left: 1 }}
      >
        <Line
          type="monotone"
          dataKey="value"
          stroke={chartTheme.seriesPrimary}
          strokeWidth={1.5}
          dot={false}
          activeDot={false}
          isAnimationActive={false}
          connectNulls={false}
        />
      </LineChart>
    </div>
  );
}
