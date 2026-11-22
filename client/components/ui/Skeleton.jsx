/**
 * Loading placeholder for an island. The EJS frame already contains a chart skeleton for the first paint; React
 * uses this one only when the mount node arrives without a usable model (an old cached page or a broken frame).
 */
export function Skeleton({ lines = 3 }) {
  return (
    <div className="stack stack--sm" aria-busy="true" aria-live="polite">
      <div className="skeleton skeleton--title" aria-hidden="true" />
      {Array.from({ length: lines }, (_, index) => (
        <div className="skeleton skeleton--text" key={index} aria-hidden="true" />
      ))}
      <span className="u-visually-hidden">Загрузка данных</span>
    </div>
  );
}
