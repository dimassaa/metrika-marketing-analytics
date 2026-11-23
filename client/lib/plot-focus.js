import { useEffect, useRef } from 'react';

/**
 * Recharts renders tooltip/legend/layer portals into bare SVG `<g>` elements. React attaches its delegated
 * `focusin`/`focusout` listeners to each portal container, and this Chromium treats an element with focus listeners
 * as sequentially focusable — so every `g.recharts-zIndex-layer_*` becomes a phantom Tab stop even with
 * `accessibilityLayer={false}` and no `tabindex` attribute.
 *
 * `tabindex="-1"` removes them from sequential navigation without disabling pointer events, which `inert` would do
 * (and that would kill the hover tooltips). A one-shot pass after mount is not enough: Recharts re-creates these
 * layers on resize and on some tooltip state changes, and each new `<g>` starts without the attribute. The hook
 * therefore re-applies it through a MutationObserver for the lifetime of the plot.
 *
 * Selector: the class is generated as `recharts-zIndex-layer_<number>`, and Recharts gives the element no other
 * class. `[class^=...]` is used instead of a substring match so an unrelated class name cannot be swept in.
 */
const PORTAL_LAYER_SELECTOR = 'g[class^="recharts-zIndex-layer"]';

/**
 * Marks every Recharts portal layer under `root` as removed from sequential focus.
 *
 * @param {{ querySelectorAll: (selector: string) => ArrayLike<{ setAttribute: (name: string, value: string) => void }> } | null} root
 * @returns {number} How many layers were marked (0 when the root is absent).
 */
export function markRechartsLayersNonFocusable(root) {
  if (!root?.querySelectorAll) return 0;

  const layers = root.querySelectorAll(PORTAL_LAYER_SELECTOR);
  for (const layer of layers) layer.setAttribute('tabindex', '-1');
  return layers.length;
}

/**
 * Ref for a chart plot or sparkline wrapper: keeps Recharts portal layers out of the Tab order while leaving
 * pointer events (and therefore tooltips) intact.
 *
 * @returns {import('react').RefObject<HTMLDivElement>}
 */
export function usePlotFocusGuard() {
  const ref = useRef(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;

    markRechartsLayersNonFocusable(root);
    if (typeof MutationObserver === 'undefined') return undefined;

    // Only re-scan when a new portal layer appears. Recharts mutates its tooltip text on every pointer move; scanning
    // the whole plot for every such mutation would do needless work while the mouse moves.
    const observer = new MutationObserver((mutations) => {
      const addedLayer = mutations.some((mutation) =>
        [...mutation.addedNodes].some(
          (node) =>
            node.nodeType === 1 &&
            (node.matches?.(PORTAL_LAYER_SELECTOR) || node.querySelector?.(PORTAL_LAYER_SELECTOR)),
        ),
      );
      if (addedLayer) markRechartsLayersNonFocusable(root);
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return ref;
}
