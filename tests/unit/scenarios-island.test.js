import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScenariosIsland } from '../../client/entries/scenarios.jsx';
import { incrementBarColor } from '../../client/components/charts/IncrementBars.jsx';
import { chartTheme } from '../../client/lib/chartTheme.js';
import {
  buildScenarioDetailScreen,
  buildScenariosScreen,
} from '../../src/services/decisions/screen-models.js';

/** @returns {object} The same two-channel snapshot the model tests use. */
function scenarioFixture() {
  return {
    channels: [
      {
        channelId: '1',
        channelCode: 'instagram',
        channelName: 'Instagram',
        model: 'saturation',
        K: 12.5,
        S: 20,
        r2: 0.7,
        observed: [
          { spendCents: '40000', customers: 3 },
          { spendCents: '100000', customers: 5 },
        ],
        current: { spendCents: '100000', customers: 4 },
        planned: { spendCents: '120000', customers: 6.5 },
        forecast: { customers: 6.5, revenue12Cents: '250000', cacCents: '18462', romi12: 100.2 },
        note: null,
      },
      {
        channelId: '2',
        channelCode: 'email',
        channelName: 'Email',
        model: 'linear',
        K: null,
        S: null,
        r2: null,
        observed: [{ spendCents: '0', customers: 2 }],
        current: { spendCents: '0', customers: 2 },
        planned: null,
        forecast: null,
        note: 'Линейная кривая — без оптимума',
      },
    ],
    totals: {
      current: { spendCents: '100000', customers: 4 },
      planned: { spendCents: '120000', customers: 6.5 },
      forecast: { customers: 6.5, revenue12Cents: '250000', cacCents: '18462', romi12: 100.2 },
    },
    warnings: ['Email: Линейная кривая — без оптимума'],
  };
}

/** @returns {object} Builder screen model. */
function builderModel() {
  const result = scenarioFixture();
  return buildScenariosScreen({
    scenario: result,
    list: {
      rows: [
        {
          id: '7',
          name: 'Проверка',
          authorLabel: 'Аналитик',
          createdAt: '2026-11-20T10:00:00Z',
          anchor: '2026-11-20',
          budgetCents: '120000',
          channelCount: 2,
          invalid: false,
        },
      ],
      page: 1,
      total: 1,
      hasMore: false,
    },
    query: {},
    anchor: '2026-11-20',
  });
}

describe('scenarios island structure', () => {
  it('renders four chart frames with an image slot and a duplicate table each', () => {
    const html = renderToStaticMarkup(createElement(ScenariosIsland, builderModel()));

    expect((html.match(/<figure class="card chart"/g) ?? []).length).toBe(4);
    expect((html.match(/role="img"/g) ?? []).length).toBe(4);
    expect((html.match(/<details class="chart__table"/g) ?? []).length).toBe(4);
    expect((html.match(/Показать таблицу/g) ?? []).length).toBe(4);
    expect(html).toContain('Расход по каналам:');
    expect(html).toContain('Кривая насыщения: Instagram');
    expect(html).toContain('Прирост клиентов:');
    expect(html).toContain('aria-label="Расход по каналам сценария');
  });

  it('renders before/after rows and the channel table with scopes and captions', () => {
    const html = renderToStaticMarkup(createElement(ScenariosIsland, builderModel()));

    expect(html).toContain('До и после');
    expect(html).toContain('Сравнение до и после');
    expect(html).toContain('Показатель');
    expect(html).toContain('<caption class="u-visually-hidden">Сценарий: текущее состояние и план</caption>');
    expect(html).toContain('Каналы сценария');
    expect(html).toContain('<th scope="row">Instagram</th>');
    expect(html).toContain('Линейная');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
  });

  it('renders the detail mode heading from the stored snapshot', () => {
    const result = scenarioFixture();
    const detail = buildScenarioDetailScreen({
      scenario: {
        id: '7',
        name: 'Снимок ноября',
        authorLabel: 'Аналитик',
        createdAt: '2026-11-20T10:00:00Z',
        savedAnchor: '2026-11-20',
        invalid: false,
        invalidReason: null,
        params: {
          budgetCents: '120000',
          history: { weeks: 26, from: '2026-05-18', to: '2026-11-15' },
        },
        result,
      },
    });

    const html = renderToStaticMarkup(createElement(ScenariosIsland, detail));

    expect(detail.mode).toBe('detail');
    expect(html).toContain('Снимок: Снимок ноября');
    expect((html.match(/role="img"/g) ?? []).length).toBe(4);
  });

  it('keeps a reader without a chart model on the loading state instead of crashing', () => {
    const html = renderToStaticMarkup(
      createElement(ScenariosIsland, { mode: 'builder', charts: null, budget: null, totals: null }),
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('NaN');
  });
});

describe('scenario chart components', () => {
  it('draws two comparison series and signs the increment bars', () => {
    const comparison = readFileSync('client/components/charts/ComparisonBars.jsx', 'utf8');
    expect(comparison).toContain('dataKey="current"');
    expect(comparison).toContain('dataKey="compare"');
    expect((comparison.match(/<Bar\s/g) ?? []).length).toBe(2);

    const saturation = readFileSync('client/components/charts/SaturationCurve.jsx', 'utf8');
    expect(saturation).toContain('<Line');
    expect(saturation).toContain('dataKey="curve"');
    expect(saturation).toContain('<Scatter');
    expect(saturation).toContain('dataKey="observed"');

    const increment = readFileSync('client/components/charts/IncrementBars.jsx', 'utf8');
    expect(increment).toContain('dataKey="delta"');
    expect(increment).toContain('ReferenceLine');

    expect(incrementBarColor(2)).toBe(chartTheme.seriesPrimary);
    expect(incrementBarColor(-2)).toBe(chartTheme.seriesMuted);
    expect(incrementBarColor(0)).toBe(chartTheme.seriesPrimary);
  });

  it('mounts exactly one island from the scenarios entry', () => {
    const entry = readFileSync('client/entries/scenarios.jsx', 'utf8');

    expect((entry.match(/mountIsland\s*\(/g) ?? []).length).toBe(1);
    expect(entry).toContain("mountIsland(ScenariosIsland, 'scenarios'");
  });
});

describe('scenarios frame contract', () => {
  it('binds the slider max to the model cap and labels the weekly and 12-month budgets', () => {
    const view = readFileSync('src/views/pages/scenarios.ejs', 'utf8');

    expect(view).toContain('type="range"');
    expect(view).toContain('min="0.01"');
    expect(view).toContain('step="0.01"');
    expect(view).toContain('max="<%= model.budget.capInput %>"');
    expect(view).toContain('Недельный бюджет');
    expect(view).toContain('за 12 месяцев ×<%= model.budget.weeksPerYear %>');
    expect(view).toContain('максимум');
    expect(view).toContain('<%= model.budget.maxMultiplier %>× текущего бюджета');
    expect(view).not.toContain('×52');
    expect(view).not.toContain('3× текущего бюджета');
    expect(view).toContain('model.controls.presets');
    expect(view).toContain('name="_csrf"');
    expect(view).toContain('name="channelIds"');
  });

  it('has the designed empty builder branch and no literal cap', () => {
    const view = readFileSync('src/views/pages/scenarios.ejs', 'utf8');

    expect(view).toContain('model.unavailable');
    expect(view).toContain('Нет данных для расчёта сценария');
    expect(view).not.toMatch(/max="[0-9]/);
  });

  it('collapses the two-column chart grid on a narrow screen', () => {
    const css = readFileSync('public/css/app.css', 'utf8');

    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.grid--2/);
    expect(css).toContain('.range');
    expect(css).toContain('accent-color: var(--color-cyan-edge)');
  });
});
