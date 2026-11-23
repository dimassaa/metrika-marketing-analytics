import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sparkline } from '../../client/components/charts/Sparkline.jsx';

describe('Sparkline', () => {
  it('mounts a fixed-size Recharts wrapper for a measured series', () => {
    const html = renderToStaticMarkup(
      createElement(Sparkline, {
        values: [
          { weekLabel: '03.11.2026', value: 1000 },
          { weekLabel: '10.11.2026', value: null },
          { weekLabel: '17.11.2026', value: 1200 },
        ],
      }),
    );

    // Recharts draws the SVG after layout in the browser; the server render fixes the geometry and proves the line
    // component was used instead of a hand-written path.
    expect(html).toContain('recharts-wrapper');
    expect(html).toContain('width:72px');
    expect(html).toContain('height:20px');
  });

  it('shows a dash when fewer than two weeks are measured', () => {
    const html = renderToStaticMarkup(
      createElement(Sparkline, {
        values: [
          { weekLabel: '03.11.2026', value: null },
          { weekLabel: '10.11.2026', value: 1000 },
        ],
      }),
    );

    expect(html).toBe(
      '<div class="sparkline sparkline--empty" title="Недостаточно недель для тренда">—</div>',
    );
  });
});
