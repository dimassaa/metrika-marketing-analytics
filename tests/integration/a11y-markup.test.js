import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { seed } from '../../db/seed/seed.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';
import { loginAs, makeApp } from '../helpers/app.js';
import { getAppCsrf } from '../helpers/csrf.js';
import { ChartFrame } from '../../client/components/charts/ChartFrame.jsx';

/**
 * Markup contract for every authenticated screen.
 *
 * The checks run against the real Express render, not against template source, so a partial that stops being included
 * or a page that forgets `aria-current` fails here. Chart frames live in React islands and are covered by rendering
 * `ChartFrame` directly at the bottom of the file; the server render deliberately contains only the skeleton.
 */
const ADMIN = 'admin@metrika.by';
const NO_ASSETS = { assets: { assets: () => ({ scripts: [], preloads: [] }) } };

/** @type {import('pg').Pool} */
let pool;
/** @type {import('express').Express} */
let app;
/** @type {import('supertest').SuperAgentTest} */
let agent;

const STATIC_PAGES = [
  '/app/dashboard',
  '/app/channels',
  '/app/campaigns',
  '/app/cohorts',
  '/app/attribution',
  '/app/alerts',
  '/app/scenarios',
  '/app/goals',
  '/app/import',
  '/app/audit',
  '/app/admin/users',
  '/app/profile',
];

beforeAll(async () => {
  await resetTestDatabase();
  await seed();
  pool = getTestPool();
  app = makeApp(NO_ASSETS);
  agent = request.agent(app);
  const login = await loginAs(agent, ADMIN);
  expect(login.status).toBe(302);
});

afterAll(async () => {
  await closeTestPool();
});

/**
 * @param {string} html
 * @returns {number}
 */
function h1Count(html) {
  return (html.match(/<h1\b/gi) ?? []).length;
}

/**
 * Parses attributes from an opening tag (class, id, role, aria-*, tabindex).
 *
 * @param {string} tag Tag text without the closing `>`.
 * @returns {Record<string, string>} Lower-cased attribute name → raw value.
 */
function attributes(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)]
      .filter((match) => match[2] !== undefined || /^(required|disabled|multiple|checked|hidden)$/.test(match[1]))
      .map((match) => [match[1].toLowerCase(), match[2] ?? '']),
  );
}

/**
 * @param {string} html
 * @returns {Array<{ tag: string, attrs: Record<string, string> }>}
 */
function elements(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((match) => ({
    tag: match[0],
    attrs: attributes(match[0]),
  }));
}

/**
 * Every table must be named for a screen reader. The caption may be visually hidden; the name may also sit on the
 * table itself.
 *
 * @param {string} html
 * @returns {string[]} A human-readable problem per unnamed table.
 */
function tableProblems(html) {
  const problems = [];
  const tables = [...html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)];
  tables.forEach((match, index) => {
    const attrs = attributes(`<table${match[1]}>`);
    const hasCaption = /<caption\b[^>]*>[\s\S]*?\S[\s\S]*?<\/caption>/i.test(match[2]);
    if (!hasCaption && !attrs['aria-label'] && !attrs['aria-labelledby']) {
      problems.push(`table #${index + 1} has neither <caption> nor an accessible name`);
    }
  });
  return problems;
}

/**
 * Scrollable table wrappers need a name, a region role and a keyboard entry point, otherwise a keyboard user cannot
 * scroll a table that is wider than the card.
 *
 * @param {string} html
 * @returns {string[]} A human-readable problem per incomplete wrapper.
 */
function tableWrapProblems(html) {
  const problems = [];
  for (const element of elements(html, 'div')) {
    if (!/\btable-wrap\b/.test(element.attrs.class ?? '')) continue;
    const attrs = element.attrs;
    if (attrs.role !== 'region') problems.push('table-wrap without role="region"');
    if ((attrs.tabindex ?? '').toLowerCase() !== '0') problems.push('table-wrap without tabindex="0"');
    if (!attrs['aria-label'] && !attrs['aria-labelledby']) problems.push('table-wrap without aria-label');
  }
  return problems;
}

/**
 * Finds controls whose accessible name cannot be derived. Hidden inputs and buttons are not labelled fields; file
 * inputs inside their own `<label>` are. Every other control must be wrapped in a label or point at one with `for`,
 * `aria-label` or `aria-labelledby`.
 *
 * @param {string} html
 * @returns {string[]} A human-readable problem per unnamed control.
 */
function unlabelledControls(html) {
  const labelRanges = [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)].map((match) => ({
    attrs: attributes(`<label${match[1]}>`),
    start: match.index,
    end: match.index + match[0].length,
  }));
  const forIds = new Set(labelRanges.map((label) => label.attrs.for).filter(Boolean));

  const problems = [];
  for (const match of html.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const type = (attrs.type ?? '').toLowerCase();
    if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset') continue;

    const insideLabel = labelRanges.some((label) => match.index >= label.start && match.index < label.end);
    const labelledByAttribute = Boolean(attrs['aria-label'] || attrs['aria-labelledby']);
    const labelledByFor = (attrs.id && forIds.has(attrs.id)) || false;
    if (!insideLabel && !labelledByAttribute && !labelledByFor) {
      problems.push(`<${match[1]} name="${attrs.name ?? '?'}"> has no label`);
    }
  }
  return problems;
}

/**
 * @param {string} html
 * @returns {string[]} A human-readable problem per image without an alt attribute.
 */
function imageProblems(html) {
  return [...html.matchAll(/<img\b[^>]*>/gi)]
    .filter((match) => !/\balt="/i.test(match[0]))
    .map(() => 'img without alt');
}

/**
 * Every `aria-describedby` target must exist in the same document, otherwise a screen reader announces a broken
 * reference instead of the error text.
 *
 * @param {string} html
 * @returns {string[]}
 */
function describedByProblems(html) {
  const ids = new Set(
    [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]),
  );
  const problems = [];
  for (const match of html.matchAll(/\baria-describedby="([^"]+)"/g)) {
    for (const id of match[1].split(/\s+/).filter(Boolean)) {
      if (!ids.has(id)) problems.push(`aria-describedby="${id}" has no target`);
    }
  }
  return problems;
}

describe.each(STATIC_PAGES)('a11y markup: %s', (path) => {
  /** @type {import('supertest').Response} */
  let response;

  beforeAll(async () => {
    response = await agent.get(path);
  });

  it('renders successfully', () => {
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
  });

  it('has exactly one h1 and a skip link to #main', () => {
    expect(h1Count(response.text)).toBe(1);
    expect(response.text).toMatch(/<a class="skip-link" href="#main">/);
    expect(response.text).toMatch(/<main id="main"[^>]*>/);
    // The CSS-only mobile disclosure needs this small keyboard bridge for Enter/Escape.
    expect(response.text).toContain('src="/js/app-nav.js"');
  });

  it('marks the active navigation item with aria-current', () => {
    expect(response.text).toMatch(/aria-current="page"/);
    // The attribute must sit on a link, not on an unrelated decorative element.
    expect(response.text).toMatch(/<a\b[^>]*aria-current="page"/);
  });

  it('names every table and every scroll wrapper', () => {
    expect(tableProblems(response.text)).toEqual([]);
    expect(tableWrapProblems(response.text)).toEqual([]);
  });

  it('labels form controls and image alternatives', () => {
    expect(unlabelledControls(response.text)).toEqual([]);
    expect(imageProblems(response.text)).toEqual([]);
  });

  it('keeps every aria-describedby target resolvable', () => {
    expect(describedByProblems(response.text)).toEqual([]);
  });

  it('uses no inline styles', () => {
    expect(response.text).not.toMatch(/\sstyle="/);
  });
});

describe('a11y markup: channel passport', () => {
  it('passes the same contract as the static pages', async () => {
    const { rows } = await pool.query('SELECT id::text AS id FROM channels ORDER BY code LIMIT 1');
    const response = await agent.get(`/app/channels/${rows[0].id}`);

    expect(response.status).toBe(200);
    expect(h1Count(response.text)).toBe(1);
    expect(response.text).toMatch(/aria-current="page"/);
    expect(tableProblems(response.text)).toEqual([]);
    expect(tableWrapProblems(response.text)).toEqual([]);
    expect(unlabelledControls(response.text)).toEqual([]);
    expect(describedByProblems(response.text)).toEqual([]);
  });
});

describe('a11y markup: form errors', () => {
  it('marks the scenario budget field invalid and describes it with the error text', async () => {
    const response = await agent.get('/app/scenarios?budgetByn=abc');

    expect(response.status).toBe(400);
    const budget = /<input\b[^>]*id="budgetByn"[^>]*>/.exec(response.text)?.[0] ?? '';
    expect(budget).toContain('aria-invalid="true"');
    const describedBy = /\baria-describedby="([^"]+)"/.exec(budget)?.[1] ?? '';
    expect(describedBy.split(/\s+/)).toContain('scenario-budget-error');
    expect(response.text).toMatch(/id="scenario-budget-error"/);
  });

  it('marks the rejected campaign form and points every field at the error summary', async () => {
    const csrf = await getAppCsrf(agent, '/app/campaigns');
    const response = await agent
      .post('/app/campaigns')
      .type('form')
      .send({
        _csrf: csrf,
        channelId: '999999',
        code: 'НЕ-КОД',
        name: '',
        status: 'active',
        startedOn: 'not-a-date',
        endedOn: '',
        budgetByn: '-1',
      });

    expect(response.status).toBe(400);
    expect(response.text).toMatch(/id="campaign-create-error"/);
    const form = /<form class="inline-form" method="post" action="\/app\/campaigns">([\s\S]*?)<\/form>/.exec(
      response.text,
    )?.[1];
    expect(form).toBeTruthy();
    const controls = [...form.matchAll(/<(input|select|textarea)\b[^>]*>/gi)]
      .map((match) => match[0])
      .filter((tag) => !/type="hidden"/.test(tag));
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control).toContain('aria-invalid="true"');
      expect(control).toMatch(/aria-describedby="campaign-create-error"/);
    }
    expect(describedByProblems(response.text)).toEqual([]);
  });
});

describe('a11y markup: chart frame', () => {
  it('renders a labelled figure whose duplicate table sits outside role="img"', () => {
    const table = {
      columns: [
        { key: 'week', label: 'Неделя', numeric: false },
        { key: 'value', label: 'CAC', numeric: true },
      ],
      rows: [{ key: '2026-11-16', cells: { week: '16.11.2026', value: '43,76' } }],
    };
    const html = renderToStaticMarkup(
      createElement(
        ChartFrame,
        {
          title: 'CAC по неделям',
          caption: 'CAC по неделям · 12 недель',
          unit: 'BYN',
          ariaLabel: 'CAC по неделям: 12 недель',
          empty: false,
          table,
        },
        createElement('span', null, 'plot'),
      ),
    );

    const titleId = /<figure class="card chart" aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(titleId).toBeTruthy();
    expect(html).toContain(`<h3 class="chart__title" id="${titleId}">`);
    expect(html).toContain('role="img" aria-label="CAC по неделям: 12 недель"');
    expect(html).toContain('class="table-wrap" role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html.indexOf('<details class="chart__table"')).toBeGreaterThan(html.indexOf('role="img"'));
    expect(html.indexOf('</details>')).toBeGreaterThan(html.indexOf('role="img"'));
    expect(html).toMatch(/<caption class="u-visually-hidden">CAC по неделям: таблица данных<\/caption>/);
  });
});
