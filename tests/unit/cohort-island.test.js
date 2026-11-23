import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CohortsIsland } from '../../client/entries/cohorts.jsx';
import { buildCohortsScreen } from '../../src/services/metrics/screen-models.js';
import { buildCumulativeLtvCurve } from '../../src/services/metrics/chart-series.js';

/**
 * @returns {object} A cohorts screen model with a completed and a partial cohort.
 */
function model() {
  const matrix = {
    horizonMonths: 3,
    anchor: '2026-11-21',
    cohorts: [
      {
        cohortMonth: '2025-10-01',
        cohortLabel: 'окт 2025',
        cohortSize: 292,
        ltvCents: '14311',
        ltvLabel: '143,11',
        isComplete: true,
        monthsObserved: 3,
        cells: [
          { monthOffset: 0, retentionPct: 100, cumLtvCents: '5797' },
          { monthOffset: 1, retentionPct: 30.82, cumLtvCents: '7555' },
          { monthOffset: 2, retentionPct: 0, cumLtvCents: '9339' },
        ],
      },
      {
        cohortMonth: '2026-11-01',
        cohortLabel: 'ноя 2026',
        cohortSize: 179,
        ltvCents: null,
        ltvLabel: '—',
        isComplete: false,
        monthsObserved: 1,
        cells: [
          { monthOffset: 0, retentionPct: 100, cumLtvCents: '5875' },
          { monthOffset: 1, retentionPct: null, cumLtvCents: null },
          { monthOffset: 2, retentionPct: null, cumLtvCents: null },
        ],
      },
    ],
    excludedIncomplete: [
      {
        cohortMonth: '2026-11-01',
        cohortLabel: 'ноя 2026',
        cohortSize: 179,
        ltvCents: null,
        ltvLabel: '—',
        isComplete: false,
        monthsObserved: 1,
      },
    ],
    channelLtv: [],
  };

  return buildCohortsScreen({
    matrix,
    curve: buildCumulativeLtvCurve({ cohorts: matrix.cohorts, horizonMonths: matrix.horizonMonths }),
  });
}

describe('cohorts island structure', () => {
  it('renders a real heatmap table with a caption, row/column scopes and numeric cell text', () => {
    const html = renderToStaticMarkup(createElement(CohortsIsland, model()));

    expect(html).toContain('<table class="matrix"');
    expect(html).toContain('<caption class="u-visually-hidden">Удержание клиентов по когортам');
    expect((html.match(/scope="col"/g) ?? []).length).toBeGreaterThan(3);
    expect((html.match(/scope="row"/g) ?? []).length).toBe(2);
    // Colour is never the only signal: the percentage is visible text in the cell.
    expect(html).toContain('100,0%');
    expect(html).toContain('30,82%');
    expect(html).toContain('heat-4');
    expect(html).toContain('heat-0');
  });

  it('marks a partial cohort and shows a future cell as an empty dash', () => {
    const html = renderToStaticMarkup(createElement(CohortsIsland, model()));

    expect(html).toContain('is-partial');
    expect(html).toContain('неполная');
    expect(html).toContain('is-empty');
    expect(html).toContain('—');
    expect(html).toContain('Пунктиром');
    expect(html).toContain('не вошли в кривую');
  });

  it('keeps the curve values available in a duplicate table, not only in the tooltip', () => {
    const html = renderToStaticMarkup(createElement(CohortsIsland, model()));

    expect(html).toContain('Показать таблицу');
    expect(html).toContain('Средний накопленный LTV по завершённым когортам, 1 когорта');
    expect(html).toContain('57,97');
    expect(html).toContain('93,39');
  });

  it('renders an honest empty state when there are no cohorts', () => {
    const matrix = { horizonMonths: 3, anchor: '2026-11-21', cohorts: [], excludedIncomplete: [], channelLtv: [] };
    const screen = buildCohortsScreen({
      matrix,
      curve: buildCumulativeLtvCurve({ cohorts: [], horizonMonths: 3 }),
    });

    const html = renderToStaticMarkup(createElement(CohortsIsland, screen));

    expect(html).toContain('Когорт пока нет');
    expect(html).not.toContain('matrix__cell');
    expect(html).not.toContain('NaN');
  });
});
