import { formatCentsToByn, formatRatio, formatRomi } from '../../../src/lib/format.js';

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
 *   label?: string | number,
 *   unit: 'BYN' | '%' | 'чел.',
 *   names?: Record<string, string>,
 *   signed?: boolean,
 *   labelFormatter?: (label: string | number) => string,
 * }} props
 */
export function ChartTooltip({
  active,
  payload,
  label,
  unit,
  names = {},
  signed = false,
  labelFormatter = null,
}) {
  if (!active || !payload || payload.length === 0) return null;

  const present = payload.filter((entry) => entry.value !== null && entry.value !== undefined);
  if (present.length === 0) return null;

  return (
    <div className="chart__tooltip">
      <p className="chart__tooltip-label">
        {labelFormatter && label !== undefined && label !== null ? labelFormatter(label) : label}
      </p>
      <ul className="chart__tooltip-list">
        {present.map((entry) => (
          <li className="chart__tooltip-row" key={entry.dataKey}>
            <span
              className={`chart__tooltip-dot chart__tooltip-dot--${entry.dataKey}`}
              aria-hidden="true"
            />
            <span className="chart__tooltip-name">{names[entry.dataKey] ?? entry.name}</span>
            <strong className="chart__tooltip-value">{formatValue(entry.value, unit, signed)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * @param {number | null | undefined} value Chart value.
 * @param {'BYN' | '%' | 'чел.'} unit
 * @param {boolean} signed
 * @returns {import('react').ReactNode} `1 234,56 BYN` with the official glyph, `+12,4%`, `+12,3` клиента, or `—`.
 *   The glyph goes through `.byn` like every other money label in the app.
 */
function formatValue(value, unit, signed) {
  if (value === null || value === undefined) return '—';
  if (unit === 'BYN') {
    return (
      <>
        {formatCentsToByn(Math.round(value))} <span className="byn">BYN</span>
      </>
    );
  }
  if (unit === 'чел.') {
    const text = formatRatio(value, { decimals: 1 });
    return signed && value > 0 ? `+${text}` : text;
  }
  return formatRomi(value);
}
