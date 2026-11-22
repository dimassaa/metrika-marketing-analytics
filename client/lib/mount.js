import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ChartErrorBoundary } from '../components/charts/ChartErrorBoundary.jsx';

/**
 * Mounts one island into exactly one `[data-island]` node.
 *
 * Zero nodes means the EJS frame forgot the mount point; two mean a duplicated partial. Both are markup bugs, and
 * picking the first would hide them until someone notices a chart that "sometimes" does not update. The error is
 * therefore thrown, not logged.
 *
 * `hydrateRoot` is not used: the server does not render island markup, it renders a skeleton that React replaces.
 *
 * @param {import('react').ComponentType<object>} Component
 * @param {string} name Island name as written into `data-island`.
 * @returns {void}
 * @throws {Error} When the mount node is missing, duplicated, or its `data-props` is not valid JSON.
 */
export function mountIsland(Component, name) {
  const nodes = document.querySelectorAll(`[data-island="${name}"]`);
  if (nodes.length !== 1) {
    throw new Error(`island "${name}" must have exactly one mount node, found ${nodes.length}`);
  }

  const node = nodes[0];
  let props = {};
  if (node.dataset.props) {
    try {
      props = JSON.parse(node.dataset.props);
    } catch (error) {
      throw new Error(`island "${name}" has invalid data-props`, { cause: error });
    }
  }

  createRoot(node).render(
    createElement(
      ChartErrorBoundary,
      { island: name, title: 'Дашборд' },
      createElement(Component, props),
    ),
  );
}
