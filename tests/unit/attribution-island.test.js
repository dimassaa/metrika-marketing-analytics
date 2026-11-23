import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttributionIsland } from '../../client/entries/attribution.jsx';
import { buildAttributionScreen } from '../../src/services/metrics/screen-models.js';

/**
 * @param {{
 *   model?: 'last_touch' | 'first_touch' | 'linear',
 *   totalRevenueCents?: string,
 * }} [options]
 * @returns {object} Screen model built by the same builder the controller uses.
 */
function model({ model = 'last_touch', totalRevenueCents = '13000' } = {}) {
  return buildAttributionScreen({
    report: {
      period: { from: '2026-10-23', to: '2026-11-21' },
      models: {
        last_touch: {
          revenueByChannel: [],
          totalRevenueCents,
          totalAttributedCents: '12500',
          totalSpendCents: '5000',
          romiPct: 150,
        },
        first_touch: {
          revenueByChannel: [],
          totalRevenueCents,
          totalAttributedCents: '12500',
          totalSpendCents: '5000',
          romiPct: 150,
        },
        linear: {
          revenueByChannel: [],
          totalRevenueCents,
          totalAttributedCents: '12000',
          totalSpendCents: '5000',
          romiPct: 140,
        },
      },
      comparison: [
        {
          channelId: '2',
          channelCode: 'email',
          lastTouchCents: '2500',
          firstTouchCents: '3500',
          linearCents: '4000',
          deltaModel: 'linear',
          deltaLinearVsLastCents: '1500',
          deltaLinearVsLastPct: 60,
        },
        {
          channelId: '1',
          channelCode: 'instagram',
          lastTouchCents: '10000',
          firstTouchCents: '9000',
          linearCents: '8000',
          deltaModel: 'linear',
          deltaLinearVsLastCents: '-2000',
          deltaLinearVsLastPct: -20,
        },
      ],
    },
    model,
    period: { from: '2026-10-23', to: '2026-11-21', days: 30 },
  });
}

describe('attribution island structure', () => {
  it('renders an accessible chart frame with a duplicate table outside the image slot', () => {
    const html = renderToStaticMarkup(createElement(AttributionIsland, model()));

    expect(html).toContain('<figure class="card chart" aria-labelledby=');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Выручка по моделям атрибуции');
    expect(html).toContain('Выручка по моделям атрибуции за период; окно касания — 30 дней');
    expect(html).toContain('Показать таблицу');
    expect(html).toContain('<caption class="u-visually-hidden">Выручка по моделям атрибуции');
  });

  it('renders the delta table with scopes and the named base of the delta', () => {
    const html = renderToStaticMarkup(createElement(AttributionIsland, model()));

    expect(html).toContain('table--attribution');
    expect(html).toContain('<caption class="u-visually-hidden">Сравнение моделей атрибуции');
    expect((html.match(/scope="col"/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect((html.match(/scope="row"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('Дельта: линейная − последнее касание');
    expect(html).toContain('+60,0%');
    expect(html).toContain('−20,0%');
  });

  it('marks the selected model link with aria-current and keeps all three visible', () => {
    const html = renderToStaticMarkup(createElement(AttributionIsland, model({ model: 'linear' })));

    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1);
    expect(html).toContain('Последнее касание');
    expect(html).toContain('Первое касание');
    expect(html).toContain('Линейная');
    // The selected summary is the linear model's own total, not a sum of the comparison.
    expect(html).toContain('120,00');
    expect(html).toContain('+140,0%');
  });

  it('shows the unattributed note from the selected model', () => {
    const html = renderToStaticMarkup(createElement(AttributionIsland, model({ model: 'linear' })));

    expect(html).toContain('Не вся выручка атрибутирована');
    expect(html).toContain('10,00');
  });

  it('renders an honest empty state without NaN', () => {
    const screen = model({ totalRevenueCents: '0' });
    screen.summary.totalAttributedCents = '0';
    screen.summary.totalAttributedLabel = '0,00';
    screen.summary.totalSpendCents = '0';
    screen.summary.romiPct = null;
    screen.summary.romiLabel = '—';
    screen.models = screen.models.map((entry) => ({
      ...entry,
      totalAttributedCents: '0',
      totalAttributedLabel: '0,00',
      totalSpendCents: '0',
      romiPct: null,
      romiLabel: '—',
    }));
    screen.charts.revenue = { ...screen.charts.revenue, hasData: false };

    const html = renderToStaticMarkup(createElement(AttributionIsland, screen));

    expect(html).toContain('Выручка по моделям атрибуции');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
  });
});
