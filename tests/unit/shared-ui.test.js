import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChartFrame } from '../../client/components/charts/ChartFrame.jsx';
import { ChartFallback } from '../../client/components/charts/ChartErrorBoundary.jsx';
import { DashboardIsland } from '../../client/entries/dashboard.jsx';
import { ChannelsIsland } from '../../client/entries/channels.jsx';
import { ChannelIsland } from '../../client/entries/channel.jsx';
import { CohortsIsland } from '../../client/entries/cohorts.jsx';
import { AttributionIsland } from '../../client/entries/attribution.jsx';

const TABLE = {
  columns: [
    { key: 'week', label: 'Неделя', numeric: false },
    { key: 'value', label: 'CAC', numeric: true },
  ],
  rows: [
    { key: '2026-11-09', cells: { week: '09.11.2026', value: '43,76' } },
    { key: '2026-11-16', cells: { week: '16.11.2026', value: '—' } },
  ],
};

/**
 * @param {object} [overrides]
 * @returns {object} Props for a non-empty chart frame.
 */
function frameProps(overrides = {}) {
  return {
    title: 'CAC по неделям',
    caption: 'CAC по неделям · 12 недель',
    unit: 'BYN',
    ariaLabel: 'CAC по неделям: 12 недель',
    empty: false,
    table: TABLE,
    height: 'sm',
    ...overrides,
  };
}

describe('chart frame accessibility', () => {
  it('labels the figure and keeps the duplicate table outside the image subtree', () => {
    const html = renderToStaticMarkup(
      createElement(ChartFrame, frameProps(), createElement('span', null, 'plot')),
    );

    const labelId = /<figure class="card chart" aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelId).toBeTruthy();
    expect(html).toContain(`<h3 class="chart__title" id="${labelId}">CAC по неделям</h3>`);
    expect(html).toContain(`role="img" aria-label="CAC по неделям: 12 недель"`);

    // The table must be a sibling of the image, not inside it: a screen reader has to read it as data.
    expect(html.indexOf('<details class="chart__table"')).toBeGreaterThan(html.indexOf('role="img"'));
    expect(html.indexOf('</details>')).toBeGreaterThan(html.indexOf('role="img"'));
    expect(html).toContain('<summary>Показать таблицу</summary>');
    expect(html).toContain('<span class="byn">BYN</span>');
  });

  it('makes the duplicate table a labelled scroll region with a keyboard entry point', () => {
    const html = renderToStaticMarkup(
      createElement(ChartFrame, frameProps(), createElement('span', null, 'plot')),
    );

    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toMatch(/aria-label="CAC по неделям: таблица данных"/);
  });

  it('explains an empty chart and offers the table as the next action', () => {
    const html = renderToStaticMarkup(
      createElement(ChartFrame, frameProps({ empty: true, emptyText: 'За период нет недель.' }), null),
    );

    expect(html).toContain('За период нет недель.');
    expect(html).not.toContain('role="img"');
    // The action is real: it opens the already-rendered table instead of inventing a fetch.
    expect(html).toContain('Показать таблицу');
    expect(html).toContain('<details class="chart__table"');
  });

  it('always renders the duplicate table, even when the chart is empty', () => {
    const html = renderToStaticMarkup(createElement(ChartFrame, frameProps({ empty: true }), null));

    expect(html).toContain('09.11.2026');
    expect(html).toContain('43,76');
  });
});

describe('chart error fallback', () => {
  it('names the failure, offers a real retry and keeps the table', () => {
    const html = renderToStaticMarkup(createElement(ChartFallback, { title: 'CAC по неделям', table: TABLE }));

    expect(html).toContain('График не построился');
    expect(html).toContain('Перезагрузить страницу');
    expect(html).toContain('Показать таблицу');
    expect(html).toContain('09.11.2026');
    expect(html).toContain('aria-live="polite"');
  });

  it('explains a missing table instead of leaving an empty collapsed control', () => {
    const html = renderToStaticMarkup(createElement(ChartFallback, { title: 'CAC по неделям' }));

    expect(html).toContain('Таблица недоступна');
    expect(html).not.toContain('<details');
  });
});

describe('island loading states', () => {
  it.each([
    ['dashboard', DashboardIsland],
    ['channels', ChannelsIsland],
    ['channel', ChannelIsland],
    ['cohorts', CohortsIsland],
    ['attribution', AttributionIsland],
  ])('%s island renders the shared skeleton when the model is missing', (name, Island) => {
    const html = renderToStaticMarkup(createElement(Island, {}));

    expect(html, name).toContain('aria-busy="true"');
    expect(html, name).toContain('Загрузка данных');
    expect(html, name).toContain('skeleton--title');
    expect(html, name).not.toContain('NaN');
  });
});
