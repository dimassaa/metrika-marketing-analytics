/**
 * One KPI tile. The value is a server-formatted string, so the island never re-implements money or percent rules.
 * `unit` is `BYN` for money tiles and absent for counts and already-suffixed percentages; the glyph is rendered
 * through `.byn` so the official sign comes from the bundled font.
 *
 * @param {{ item: { id: string, label: string, value: string, unit: string | null, hint: string,
 *   tone: 'bad' | null } }} props
 */
export function Kpi({ item }) {
  return (
    <article className={`kpi${item.tone === 'bad' ? ' kpi--bad' : ''}`}>
      <p className="kpi__label">{item.label}</p>
      <p className="kpi__value">
        {item.value}
        {item.unit && (
          <>
            {' '}
            <span className="byn">{item.unit}</span>
          </>
        )}
      </p>
      <p className="kpi__hint">{item.hint}</p>
    </article>
  );
}
