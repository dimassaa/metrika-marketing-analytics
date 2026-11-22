import { formatCentsToByn, formatRomi } from '../../../src/lib/format.js';

/**
 * Recharts tooltip as a white hairline card.
 *
 * Values arrive in the units of the screen model: kopecks for money, percent for ROMI. Formatting through the shared
 * server formatter keeps the tooltip identical to the duplicate table and to the KPI tiles; the island never does
 * its own money math.
 *
 * @param {{
 *   active?: boolean,
 *   payload?: Array<{ dataKey: string, name?: string, value: number }>,
 *   label?: string,
 *   unit: 'BYN' | '%',
 *   names?: Record<string, string>,
 * }} props
 */
export function ChartTooltip({ active, payload, label, unit, names = {} }) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="chart__tooltip">
      <p className="chart__tooltip-label">{label}</p>
      <ul className="chart__tooltip-list">
        {payload.map((entry) => (
          <li className="chart__tooltip-row" key={entry.dataKey}>
            <span className={`chart__tooltip-dot chart__tooltip-dot--${entry.dataKey}`} aria-hidden="true" />
            <span className="chart__tooltip-name">{names[entry.dataKey] ?? entry.name}</span>
            <strong className="chart__tooltip-value">{formatValue(entry.value, unit)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * @param {number | null | undefined} value Chart value.
 * @param {'BYN' | '%'} unit
 * @returns {string} `1 234,56 BYN`, `+12,4%`, or `—` for a missing point.
 */
function formatValue(value, unit) {
  if (value === null || value === undefined) return '—';
  if (unit === 'BYN') return `${formatCentsToByn(Math.round(value))} BYN`;
  return formatRomi(value);
}
