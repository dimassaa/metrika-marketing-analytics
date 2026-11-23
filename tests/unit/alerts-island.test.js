import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AlertsIsland } from '../../client/entries/alerts.jsx';
import { buildAlertsScreen } from '../../src/services/decisions/screen-models.js';
import {
  buildAlertChannelChart,
  selectAlertChartChannel,
} from '../../src/services/decisions/alerts-charts.js';

const WEEK_STARTS = [
  '2026-08-24',
  '2026-08-31',
  '2026-09-07',
  '2026-09-14',
  '2026-09-21',
  '2026-09-28',
  '2026-10-05',
  '2026-10-12',
  '2026-10-19',
  '2026-10-26',
  '2026-11-02',
  '2026-11-09',
];

/**
 * @param {Array<string | null>} cacs Kopeck strings for twelve weeks.
 * @returns {object[]} `buildWeeklySeries` shape.
 */
function weeklySeries(cacs = WEEK_STARTS.map((_, index) => String(1000 + index * 100))) {
  return WEEK_STARTS.map((weekStart, index) => ({
    weekStart,
    weekLabel: weekStart.split('-').reverse().join('.'),
    spendCents: '50000',
    newCustomers: 5,
    cacCents: cacs[index] ?? null,
    romiPct: 40,
    attributedCents: '70000',
    attributedLabel: '700,00',
  }));
}

/**
 * @param {string} channelName
 * @returns {object} The alert model the controller passes into the island.
 */
function alertModel(channelName = 'Instagram') {
  const chart = buildAlertChannelChart({ channelName, weeklySeries: weeklySeries() });
  return buildAlertsScreen({
    window: {
      anchor: '2026-11-20',
      weeks: 4,
      now: { from: '2026-10-26', to: '2026-11-22', periodStart: '2026-10-26' },
    },
    rows: [
      {
        id: '11',
        channelId: '1',
        channelCode: 'instagram',
        channelName,
        rule: 'cac_spike',
        severity: 'critical',
        value: '15.0000',
        threshold: '9.0000',
        periodStart: '2026-10-26',
        status: 'active',
        detectedAt: '2026-11-20T10:00:00Z',
      },
    ],
    summary: {
      active: 1,
      critical: 1,
      warning: 0,
      resolved: 2,
      dismissed: 1,
      lastDetectedAt: '2026-11-20T10:00:00Z',
    },
    filters: { status: 'active', severity: 'all', channelId: null },
    filterOptions: { channels: [{ id: '1', name: channelName }] },
    chart,
    pagination: { page: 1, total: 1, hasMore: false },
    isStale: false,
  });
}

describe('alerts island structure', () => {
  it('renders the summary and one accessible CAC chart with a duplicate table', () => {
    const html = renderToStaticMarkup(createElement(AlertsIsland, alertModel()));

    expect(html).toContain('Сводка проверки');
    expect(html).toContain('Последняя проверка:');
    expect((html.match(/<figure class="card chart"/g) ?? []).length).toBe(1);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="CAC: Instagram');
    expect(html).toContain('<details class="chart__table"');
    expect(html).toContain('Показать таблицу');
    expect(html).toContain('CAC, BYN');
    expect(html).not.toContain('data-island');
    expect(html).not.toContain('/dismiss');
    expect(html).not.toContain('NaN');
  });

  it('renders the honest empty chart without a fabricated zero line', () => {
    const model = alertModel('Instagram');
    model.chart = buildAlertChannelChart({
      channelName: 'Instagram',
      weeklySeries: weeklySeries(WEEK_STARTS.map(() => null)),
    });

    const html = renderToStaticMarkup(createElement(AlertsIsland, model));

    expect(model.chart.hasData).toBe(false);
    expect(html).toContain('CAC: Instagram');
    expect(html).toContain('нет данных за 12 недель');
    expect(html).toContain('Таблица ниже перечисляет все недели');
    expect(html).not.toContain('Infinity');
  });
});

describe('alert problem-channel selection', () => {
  it('always honours an explicit channel filter', () => {
    expect(selectAlertChartChannel({
      rows: [],
      channelId: '3',
      channelName: 'Яндекс Директ',
    })).toEqual({ channelId: '3', channelName: 'Яндекс Директ' });
  });

  it('prefers critical severity over a larger warning delta', () => {
    const selected = selectAlertChartChannel({
      rows: [
        {
          channelId: '1',
          channelName: 'Instagram',
          rule: 'cac_spike',
          severity: 'warning',
          value: '14.0000',
          threshold: '10.0000',
        },
        {
          channelId: '2',
          channelName: 'Google Ads',
          rule: 'cac_spike',
          severity: 'critical',
          value: '15.0000',
          threshold: '9.0000',
        },
      ],
    });

    expect(selected.channelId).toBe('2');
  });

  it('breaks a severity tie by the larger CAC delta and then by the smaller id', () => {
    const largerDelta = selectAlertChartChannel({
      rows: [
        {
          channelId: '1',
          channelName: 'Instagram',
          rule: 'cac_spike',
          severity: 'warning',
          value: '14.0000',
          threshold: '10.0000',
        },
        {
          channelId: '2',
          channelName: 'Google Ads',
          rule: 'cac_spike',
          severity: 'warning',
          value: '15.0000',
          threshold: '10.0000',
        },
      ],
    });
    expect(largerDelta.channelId).toBe('2');

    const sameDelta = selectAlertChartChannel({
      rows: [
        {
          channelId: '10',
          channelName: 'Яндекс Директ',
          rule: 'cac_spike',
          severity: 'warning',
          value: '14.0000',
          threshold: '10.0000',
        },
        {
          channelId: '9',
          channelName: 'TikTok',
          rule: 'cac_spike',
          severity: 'warning',
          value: '14.0000',
          threshold: '10.0000',
        },
      ],
    });
    expect(sameDelta.channelId).toBe('9');
  });
});

describe('alert channel chart model', () => {
  it('builds a twelve-week conclusion, period caption, unit and table', () => {
    const chart = buildAlertChannelChart({ channelName: 'Instagram', weeklySeries: weeklySeries() });

    expect(chart.title).toContain('CAC: Instagram');
    expect(chart.title).toContain('+');
    expect(chart.caption).toContain('24.08–15.11.2026');
    expect(chart.caption).toContain('12 недель');
    expect(chart.unit).toBe('BYN');
    expect(chart.hasData).toBe(true);
    expect(chart.series).toHaveLength(12);
    expect(chart.table.columns.map((column) => column.key)).toEqual(['week', 'value']);
    expect(chart.table.rows).toHaveLength(12);
    expect(() => JSON.stringify(chart)).not.toThrow();
  });

  it('keeps a dash table when no weeks are supplied', () => {
    const chart = buildAlertChannelChart({ channelName: null, weeklySeries: [] });

    expect(chart.hasData).toBe(false);
    expect(chart.table.rows).toEqual([
      { key: 'empty', cells: { week: '—', value: '—' } },
    ]);
    expect(chart.title).toContain('нет данных');
    expect(JSON.stringify(chart)).not.toMatch(/NaN|Infinity/);
  });
});

describe('alerts frame and entry', () => {
  it('keeps the server-rendered actions with CSRF, reason and pagination', () => {
    const view = readFileSync('src/views/pages/alerts.ejs', 'utf8');

    expect(view).toContain('action="/app/alerts/recalculate"');
    expect(view).toContain('name="_csrf"');
    expect(view).toContain('name="reason"');
    expect(view).toContain('row.dismissHref');
    expect(view).toContain('model.pagination.prevHref');
    expect(view).toContain('model.pagination.nextHref');
    expect(view).toContain("can('alerts:manage')");
  });

  it('mounts exactly one island from the alerts entry', () => {
    const entry = readFileSync('client/entries/alerts.jsx', 'utf8');

    expect((entry.match(/mountIsland\s*\(/g) ?? []).length).toBe(1);
    expect(entry).toContain("mountIsland(AlertsIsland, 'alerts'");
  });
});
