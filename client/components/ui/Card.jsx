/**
 * White card with a hairline border. `title` renders as the section heading; `meta` is the secondary line under it.
 * @param {{ title?: import('react').ReactNode, meta?: import('react').ReactNode, children: import('react').ReactNode,
 *   className?: string }} props
 */
export function Card({ title, meta, children, className = '' }) {
  return (
    <section className={`card ${className}`.trim()}>
      {(title || meta) && (
        <div className="stack stack--sm">
          {title && <h2 className="card__title">{title}</h2>}
          {meta && <p className="card__meta">{meta}</p>}
        </div>
      )}
      {children}
    </section>
  );
}
