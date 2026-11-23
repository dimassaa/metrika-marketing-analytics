import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChannelsIsland } from '../../client/entries/channels.jsx';

/**
 * @returns {object} The smallest screen model that exercises the table, the score stack and the excluded block.
 */
function model() {
  return {
    page: 'channels',
    period: { from: '2026-10-23', to: '2026-11-21', days: 30, label: '30 дней' },
    filters: { status: 'all', kind: 'all', active: false, label: 'Все каналы', resetHref: '/app/channels' },
    weights: { cac: 0.3, romi: 0.3, ltvCac: 0.25, newCustomers: 0.15 },
    weightsBasisPoints: { cac: 300, romi: 300, ltvCac: 250, newCustomers: 150 },
    rows: [
      {
        channelId: '1',
        code: 'instagram',
        name: 'Instagram',
        kind: 'paid',
        isActive: true,
        kindLabel: 'Платный',
        metaLabel: 'Платный',
        rank: 2,
        score: 68,
        status: 'healthy',
        statusLabel: 'В норме',
        spendCents: '100000',
        revenueCents: '200000',
        newCustomers: 5,
        cacCents: '20000',
        ltv12Cents: '60000',
        romiLabel: '+100,0%',
        paybackLabel: '4 мес.',
        ratioLabel: '3,000',
        stack: [
          { criterion: 'cac', label: 'CAC', value: 20, scored: 1, weight: 0.3 },
          { criterion: 'romi', label: 'ROMI', value: 18, scored: 0.6, weight: 0.3 },
          { criterion: 'ltvCac', label: 'LTV:CAC', value: 15, scored: 0.6, weight: 0.25 },
          { criterion: 'newCustomers', label: 'Новые клиенты', value: 15, scored: 1, weight: 0.15 },
        ],
      },
    ],
    excluded: [{ code: 'blended', name: 'Все каналы', reason: 'blended', reasonLabel: 'Сводная строка' }],
    sparklines: { 1: [{ weekLabel: '03.11.2026', value: 1000 }] },
    chart: {
      romi: {
        title: 'ROMI по каналам',
        caption: 'нет каналов с измеренным ROMI',
        ariaLabel: 'ROMI по каналам',
        unit: '%',
        hasData: false,
        series: [],
        table: { columns: [], rows: [] },
      },
    },
    labels: { period: '30 дней', channels: '1 канал', filter: 'Все каналы', sort: 'Место' },
    sortLinks: [
      { field: 'rank', label: 'Место', href: '/app/channels?sort=rank&dir=asc', active: true, dir: 'asc', ariaSort: 'ascending' },
      { field: 'cac', label: 'CAC', href: '/app/channels?sort=cac&dir=asc', active: false, dir: null, ariaSort: 'none' },
    ],
  };
}

describe('channels island structure', () => {
  it('marks the active header with aria-sort and keeps the sparkline cell phrasing-neutral', () => {
    const html = renderToStaticMarkup(createElement(ChannelsIsland, model()));

    expect(html).toContain('aria-sort="ascending"');
    expect(html).toContain('aria-sort="none"');
    expect(html).toContain('table__row--clickable');
    // The row is a mouse target; the channel link is the only keyboard tab stop in the row itself. The scroll
    // wrapper is separately focusable so a keyboard user can pan the wide table on a narrow screen.
    expect(html).not.toMatch(/<tr[^>]*tabindex/);
    expect(html).toContain('<div class="table-wrap" role="region" aria-label="Рейтинг каналов" tabindex="0">');
    // Recharts renders a div wrapper; never put it inside a span in a table cell.
    expect(html).toContain('<div class="sparkline');
    expect(html).not.toContain('<span class="sparkline');
  });

  it('shows a sub-percent weight instead of rounding it to zero', () => {
    const props = model();
    props.weights = { cac: 0.3, romi: 0.3, ltvCac: 0.25, newCustomers: 0.001 };

    const html = renderToStaticMarkup(createElement(ChannelsIsland, props));

    expect(html).toContain('Клиенты 0,1%');
    expect(html).not.toContain('Клиенты 0%');
  });

  it('shows a dash instead of a broken line for a one-point sparkline', () => {
    const html = renderToStaticMarkup(createElement(ChannelsIsland, model()));

    expect(html).toContain('sparkline--empty');
  });
});
