import { Component } from 'react';
import { ChartTable } from './ChartFrame.jsx';

/**
 * Per-chart error boundary.
 *
 * A thrown render (bad data shape, a Recharts invariant) must not blank the whole dashboard: the offending chart is
 * replaced by a short message and its duplicate table, while the KPI tiles and the other charts keep working. React
 * needs a class component for `getDerivedStateFromError`, so this is the only class in the island tree.
 *
 * The retry is a page reload, not a refetch. The screen model is server-rendered and there is no endpoint to ask for
 * one chart again; reloading is the only action that can actually produce a different render, so the button says so
 * instead of pretending to be a local retry.
 *
 * The error object is logged for an operator but never rendered: an internal message can name a field or a query.
 */
export class ChartErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error('island chart render failed', {
      island: this.props.island,
      chart: this.props.title,
      error,
      componentStack: info?.componentStack,
    });
  }

  retry = () => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <ChartFallback title={this.props.title ?? 'График'} table={this.props.table} onRetry={this.retry} />
    );
  }
}

/**
 * Visible replacement for a chart that failed to render.
 *
 * Exported for the render test: a boundary's fallback state cannot be reached with `renderToStaticMarkup`, and the
 * copy plus the table are the part that matters to the person reading the screen.
 *
 * @param {{ title: string, table?: object, onRetry?: () => void }} props
 */
export function ChartFallback({ title, table, onRetry }) {
  const hasTable = Array.isArray(table?.columns) && table.columns.length > 0;

  return (
    <section className="card chart" aria-live="polite" aria-label={`${title}: график не построился`}>
      <div className="chart__head">
        <h3 className="chart__title">{title}</h3>
        <p className="chart__empty">
          График не построился. Данные не потеряны: те же числа остались в таблице ниже.
        </p>
      </div>

      <div className="cluster">
        <button className="btn btn--ghost btn--sm" type="button" onClick={onRetry}>
          Перезагрузить страницу
        </button>
      </div>

      {hasTable ? (
        <ChartTable table={table} caption={`${title}: таблица данных`} />
      ) : (
        <p className="chart__empty">
          Таблица недоступна: обновите страницу, чтобы получить данные заново.
        </p>
      )}
    </section>
  );
}
