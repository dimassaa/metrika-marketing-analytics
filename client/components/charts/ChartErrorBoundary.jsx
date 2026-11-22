import { Component } from 'react';
import { ChartTable } from './ChartFrame.jsx';

/**
 * Per-chart error boundary.
 *
 * A thrown render (bad data shape, a Recharts invariant) must not blank the whole dashboard: the offending chart is
 * replaced by a short message and its duplicate table, while the KPI tiles and the other charts keep working. React
 * needs a class component for `getDerivedStateFromError`, so this is the only class in the island tree.
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

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <section className="card chart" aria-live="polite">
        <div className="chart__head">
          <h3 className="chart__title">{this.props.title}</h3>
          <p className="chart__empty">График не построился. Данные остались в таблице ниже.</p>
        </div>
        <ChartTable table={this.props.table} caption={`${this.props.title}: таблица данных`} />
      </section>
    );
  }
}
