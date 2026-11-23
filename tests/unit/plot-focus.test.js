import { describe, expect, it, vi } from 'vitest';
import { markRechartsLayersNonFocusable } from '../../client/lib/plot-focus.js';

/**
 * The plot focus guard is the only thing keeping Recharts portal `<g>` layers out of the Tab order without `inert`.
 * A DOM cannot be rendered in this test environment (no jsdom by design), so the helper is driven with a minimal
 * `querySelectorAll` stand-in; the browser pass (`T8`) checks the real Recharts output and the hover tooltips.
 */
describe('plot focus guard', () => {
  it('sets tabindex=-1 on every Recharts portal layer under the plot', () => {
    /** @type {Array<{ attributes: Record<string, string>, setAttribute: (name: string, value: string) => void }>} */
    const layers = [
      {
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      },
      {
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      },
    ];
    const root = { querySelectorAll: vi.fn(() => layers) };

    const marked = markRechartsLayersNonFocusable(root);

    expect(marked).toBe(2);
    expect(root.querySelectorAll).toHaveBeenCalledWith('g[class^="recharts-zIndex-layer"]');
    for (const layer of layers) expect(layer.attributes.tabindex).toBe('-1');
  });

  it('is a no-op when the mount node is absent', () => {
    expect(markRechartsLayersNonFocusable(null)).toBe(0);
  });
});
