import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChannelIsland } from '../../client/entries/channel.jsx';
import { RetentionGrid } from '../../client/components/charts/RetentionGrid.jsx';
import { buildFunnelSteps } from '../../src/services/metrics/chart-series.js';

/**
 * @returns {object} Smallest chart contract `ChartFrame` accepts.
 */
function emptyChart(id, title, unit) {
  return {
    id,
    title,
    caption: title,
    ariaLabel: title,
    unit,
    hasData: false,
    series: [],
    table: { columns: [], rows: [] },
  };
}

/**
 * @param {object} [overrides]
 * @returns {object} A passport model with enough fields for the whole island.
 */
function model({
  targets = [
    {
      metric: 'cac',
      label: 'Целевой CAC',
      targetLabel: '45,00',
      factLabel: '43,52',
      unit: 'BYN',
      targetSet: true,
      factSet: true,
      tone: 'good',
    },
    {
      metric: 'romi',
      label: 'Целевой ROMI',
      targetLabel: '120,0%',
      factLabel: '+635,5%',
      unit: null,
      targetSet: true,
      factSet: true,
      tone: 'good',
    },
  ],
  funnel = { impressions: 100, clicks: 10, leads: 5, newCustomers: 2, orders: 1 },
  campaigns = [],
  campaignsTruncated = false,
  isActive = true,
} = {}) {
  return {
    page: 'channel',
    channel: {
      id: '4',
      name: 'Instagram',
      kindLabel: 'Платный',
      isActive,
    },
    period: { from: '2026-10-23', to: '2026-11-21', days: 30, label: '30 дней' },
    health: {
      cacLabel: '43,52',
      cacCents: '4352',
      ltvLabel: '149,03',
      ltv12Cents: '14903',
      romiLabel: '+635,5%',
      romiPct: 635.46,
      paybackLabel: '3,5 мес.',
      ratioLabel: '3,424',
      spendCents: '295953',
      revenueCents: '2176622',
      status: 'healthy',
      statusLabel: 'В норме',
    },
    charts: {
      cac: emptyChart('cac', 'CAC по неделям', 'BYN'),
      romi: emptyChart('romi', 'ROMI по неделям', '%'),
      spendRevenue: emptyChart('spend-revenue', 'Расход и выручка по неделям', 'BYN'),
    },
    retention: { horizonMonths: 12, hasData: false, incompleteCount: 0, cohorts: [] },
    funnel: buildFunnelSteps(funnel),
    campaigns,
    campaignsTruncated,
    targets,
  };
}

describe('channel island structure', () => {
  it('separates a missing target from a target without a fact', () => {
    const missingFact = renderToStaticMarkup(
      createElement(
        ChannelIsland,
        model({
          targets: [
            {
              metric: 'cac',
              label: 'Целевой CAC',
              targetLabel: '45,00',
              factLabel: '—',
              unit: 'BYN',
              targetSet: true,
              factSet: false,
              tone: null,
            },
          ],
        }),
      ),
    );
    expect(missingFact).toContain('Нет данных для сравнения');
    expect(missingFact).toContain('45,00');

    const noTarget = renderToStaticMarkup(
      createElement(
        ChannelIsland,
        model({
          targets: [
            {
              metric: 'cac',
              label: 'Целевой CAC',
              targetLabel: '—',
              factLabel: '—',
              unit: 'BYN',
              targetSet: false,
              factSet: false,
              tone: null,
            },
          ],
        }),
      ),
    );
    expect(noTarget).toContain('Цель не задана');
    expect(noTarget).not.toContain('Нет данных для сравнения');
  });

  it('does not describe a zero-impression funnel as "— от показов"', () => {
    const html = renderToStaticMarkup(
      createElement(
        ChannelIsland,
        model({ funnel: { impressions: 0, clicks: 5, leads: 0, newCustomers: 0, orders: 0 } }),
      ),
    );

    expect(html).toContain('доля не определена');
    expect(html).toContain('показов нет');
    expect(html).not.toContain('— от показов');
  });

  it('does not tell a viewer to use a form that is not on the page', () => {
    const html = renderToStaticMarkup(createElement(ChannelIsland, model()));

    expect(html).toContain('Когда они появятся');
    expect(html).not.toContain('форме ниже');
  });

  it('renders the archive badge only in the server frame, not twice inside the island', () => {
    const html = renderToStaticMarkup(createElement(ChannelIsland, model({ isActive: false })));

    expect(html).toContain('Архивный канал');
    expect(html).not.toContain('badge--neutral');
  });

  it('tells the reader when the campaign table is capped', () => {
    const html = renderToStaticMarkup(
      createElement(
        ChannelIsland,
        model({
          campaigns: [
            { id: '1', code: 'ig_warm', name: 'Instagram тёплый', spendCents: '100', newCustomers: 1, cacCents: '100' },
          ],
          campaignsTruncated: true,
        }),
      ),
    );

    expect(html).toContain('Показаны первые 1 кампания');
  });

  it('names the retention money column with the actual horizon and its unit', () => {
    const html = renderToStaticMarkup(
      createElement(RetentionGrid, {
        retention: {
          horizonMonths: 6,
          anchor: '2026-11-21',
          hasData: true,
          incompleteCount: 0,
          cohorts: [
            {
              cohortMonth: '2026-01-01',
              cohortLabel: 'янв 2026',
              cohortSize: 10,
              ltvLabel: '100,00',
              isPartial: false,
              cells: [
                { monthOffset: 0, retentionLabel: '100,0%', heatClass: 'heat-4', cumLtvLabel: '40,00' },
              ],
            },
          ],
        },
      }),
    );

    expect(html).toContain('LTV6, BYN');
    expect(html).not.toContain('LTV12');
  });
});
