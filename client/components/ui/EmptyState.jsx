/**
 * Honest empty state for a widget: it names what is missing instead of drawing a flat zero line. The action slot
 * lets a screen offer the next step (import, widen the period) without duplicating the layout.
 *
 * @param {{ title?: string, children?: import('react').ReactNode, action?: import('react').ReactNode }} props
 */
export function EmptyState({ title = 'Недостаточно данных', children, action = null }) {
  return (
    <div className="chart__empty">
      <p className="empty-state__title">{title}</p>
      {children && <p className="empty-state__text">{children}</p>}
      {action}
    </div>
  );
}
