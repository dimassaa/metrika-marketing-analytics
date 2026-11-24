import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/**
 * Finds the form that posts to an exact action. Attribute order is not assumed: the opening tag is matched first,
 * then the block is cut at the first closing tag because no app form nests another form.
 *
 * @param {string} html
 * @param {string} action Exact `action` value.
 * @returns {string | null} The form markup including its opening and closing tags.
 */
function formByAction(html, action) {
  const opening = [...html.matchAll(/<form\b[^>]*>/gi)].find(
    (match) => /method="post"/i.test(match[0]) && match[0].includes(`action="${action}"`),
  );
  if (!opening) return null;
  const close = html.indexOf('</form>', opening.index);
  return close === -1 ? null : html.slice(opening.index, close + '</form>'.length);
}

/**
 * Asserts the shared error contract: a named alert and every visible control of the rejected form pointing at it.
 *
 * @param {string} html Rendered error page.
 * @param {{ alertId: string, action: string }} input Expected summary id and the posting form.
 */
function expectErrorForm(html, { alertId, action }) {
  expect(html).toContain(`id="${alertId}"`);
  const form = formByAction(html, action);
  expect(form, `form posting to ${action}`).toBeTruthy();
  const controls = [...form.matchAll(/<(input|select|textarea)\b[^>]*>/gi)]
    .map((match) => match[0])
    .filter((tag) => !/type="hidden"/.test(tag));
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(control, control).toContain('aria-invalid="true"');
    expect(control, control).toContain(`aria-describedby="${alertId}"`);
  }
  expect(describedByProblems(html)).toEqual([]);
}

/**
 * The full page contract reused by pages that only exist after a detail row is created.
 *
 * @param {string} html
 * @param {{ inlineStyles?: boolean }} [options]
 */
function expectPageContract(html, { inlineStyles = true } = {}) {
  expect(h1Count(html)).toBe(1);
  expect(html).toMatch(/<a class="skip-link" href="#main">/);
  expect(html).toMatch(/<main id="main"[^>]*>/);
  expect(html).toContain('src="/js/app-nav.js"');
  expect(html).toMatch(/<a\b[^>]*aria-current="page"/);
  expect(tableProblems(html)).toEqual([]);
  expect(tableWrapProblems(html)).toEqual([]);
  expect(unlabelledControls(html)).toEqual([]);
  expect(imageProblems(html)).toEqual([]);
  expect(describedByProblems(html)).toEqual([]);
  if (inlineStyles) expect(html).not.toMatch(/\sstyle\s*=\s*["']/i);
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
    // Accept single or double quotes and arbitrary whitespace around `=`: a minifier or a hand edit must not slip past.
    expect(response.text).not.toMatch(/\sstyle\s*=\s*["']/i);
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
    expectErrorForm(response.text, { alertId: 'campaign-create-error', action: '/app/campaigns' });
  });

  it('marks the rejected channel create form', async () => {
    const csrf = await getAppCsrf(agent, '/app/channels');
    const response = await agent
      .post('/app/channels')
      .type('form')
      .send({
        _csrf: csrf,
        code: 'НЕ-КОД',
        name: '',
        kind: 'paid',
        targetCacByn: 'abc',
        targetRomiPct: '-5',
      });

    expect(response.status).toBe(400);
    expectErrorForm(response.text, { alertId: 'channel-create-error', action: '/app/channels' });
  });

  it('marks the rejected admin user form', async () => {
    const csrf = await getAppCsrf(agent, '/app/admin/users');
    const response = await agent
      .post('/app/admin/users')
      .type('form')
      .send({
        _csrf: csrf,
        email: 'not-an-email',
        fullName: '',
        role: 'viewer',
        password: 'short',
      });

    expect(response.status).toBe(400);
    expectErrorForm(response.text, { alertId: 'user-create-error', action: '/app/admin/users' });
  });

  it('marks the rejected goal create form', async () => {
    const csrf = await getAppCsrf(agent, '/app/goals');
    const response = await agent
      .post('/app/goals')
      .type('form')
      .send({
        _csrf: csrf,
        metric: 'cac',
        channelId: '',
        targetValue: 'abc',
        periodStart: '2027-01-01',
        periodEnd: '2027-01-31',
      });

    expect(response.status).toBe(400);
    expectErrorForm(response.text, { alertId: 'goal-create-error', action: '/app/goals' });
  });

  it('marks the rejected password form', async () => {
    const csrf = await getAppCsrf(agent, '/app/profile');
    const response = await agent
      .post('/app/profile/password')
      .type('form')
      .send({
        _csrf: csrf,
        currentPassword: 'wrong-password',
        newPassword: 'another-valid-password',
      });

    expect(response.status).toBe(400);
    expectErrorForm(response.text, { alertId: 'profile-password-error', action: '/app/profile/password' });
  });

  it('marks the rejected channel settings form', async () => {
    const { rows } = await pool.query('SELECT id::text AS id FROM channels ORDER BY code LIMIT 1');
    const channelId = rows[0].id;
    const csrf = await getAppCsrf(agent, `/app/channels/${channelId}`);
    const response = await agent
      .post(`/app/channels/${channelId}`)
      .type('form')
      .send({
        _csrf: csrf,
        name: '',
        kind: 'broken',
        targetCacByn: 'abc',
        targetRomiPct: '-5',
      });

    expect(response.status).toBe(400);
    expectErrorForm(response.text, {
      alertId: 'channel-form-error',
      action: `/app/channels/${channelId}`,
    });
  });

  it('marks the rejected campaign edit form', async () => {
    const { rows } = await pool.query('SELECT id::text AS id FROM campaigns ORDER BY id LIMIT 1');
    const campaignId = rows[0].id;
    const csrf = await getAppCsrf(agent, `/app/campaigns?edit=${campaignId}`);
    const response = await agent
      .post(`/app/campaigns/${campaignId}`)
      .type('form')
      .send({
        _csrf: csrf,
        name: '',
        status: 'not-a-status',
        startedOn: 'not-a-date',
        endedOn: '',
        budgetByn: '-1',
      });

    expect(response.status).toBe(400);
    expectErrorForm(response.text, {
      alertId: 'campaign-edit-error',
      action: `/app/campaigns/${campaignId}`,
    });
  });

  it('marks the rejected goal edit form', async () => {
    const createCsrf = await getAppCsrf(agent, '/app/goals');
    const created = await agent
      .post('/app/goals')
      .type('form')
      .send({
        _csrf: createCsrf,
        metric: 'cac',
        channelId: '',
        targetValue: '42,50',
        periodStart: '2031-01-01',
        periodEnd: '2031-01-31',
      });
    expect(created.status).toBe(302);

    const { rows } = await pool.query(
      "SELECT id::text AS id FROM goals WHERE period_start = '2031-01-01' ORDER BY id DESC LIMIT 1",
    );
    const goalId = rows[0].id;
    const csrf = await getAppCsrf(agent, `/app/goals?edit=${goalId}`);
    const response = await agent
      .post(`/app/goals/${goalId}`)
      .type('form')
      .send({
        _csrf: csrf,
        targetValue: 'abc',
        periodStart: '2031-02-01',
        periodEnd: '2031-01-01',
      });

    expect(response.status).toBe(400);
    expectErrorForm(response.text, { alertId: 'goal-edit-error', action: `/app/goals/${goalId}` });
    await pool.query('DELETE FROM goals WHERE id = $1::bigint', [goalId]);
  });

  it('marks the rejected campaign quick-add on the channel passport', async () => {
    const { rows } = await pool.query('SELECT id::text AS id FROM channels ORDER BY code LIMIT 1');
    const channelId = rows[0].id;
    const csrf = await getAppCsrf(agent, `/app/channels/${channelId}`);
    const response = await agent
      .post('/app/campaigns')
      .type('form')
      .send({
        _csrf: csrf,
        channelId,
        from: 'channel',
        code: 'НЕ-КОД',
        name: '',
        status: 'active',
        startedOn: 'not-a-date',
        endedOn: '',
        budgetByn: '-1',
      });

    expect(response.status).toBe(400);
    expectErrorForm(response.text, {
      alertId: 'channel-campaign-error',
      action: '/app/campaigns',
    });
  });
});

describe('a11y markup: import file wiring', () => {
  it('starts neutral and only marks the file invalid for a server rejection', async () => {
    const response = await agent.get('/app/import');
    expect(response.status).toBe(200);
    const file = /<input\b[^>]*id="import-file"[^>]*>/.exec(response.text)?.[0] ?? '';
    expect(file).toBeTruthy();
    expect(file).not.toContain('aria-invalid');
    expect(response.text).toContain('id="import-status"');

    const script = readFileSync(
      fileURLToPath(new URL('../../public/js/upload-form.js', import.meta.url)),
      'utf8',
    );
    // A refused file (400/422) is the field's fault; a network error or 5xx is not and must not mark it invalid.
    expect(script).toMatch(/response\.status === 400 \|\| response\.status === 422/);
    expect(script).toMatch(/renderFailure\([\s\S]{0,160}rejectedFile/);
  });
});

describe('a11y markup: saved pages', () => {
  it('passes the page contract on an import batch with row errors', async () => {
    const { rows: users } = await pool.query('SELECT id::text AS id FROM users WHERE email = $1', [ADMIN]);
    const { rows } = await pool.query(
      `INSERT INTO import_batches
         (kind, filename, created_by, rows_total, rows_ok, rows_duplicate, rows_failed, committed, errors)
       VALUES ('daily_stats', 'a11y-batch.csv', $1::bigint, 3, 1, 0, 2, false,
               '[{"row":2,"field":"spend","message":"Сумма не число"}]'::jsonb)
       RETURNING id::text AS id`,
      [users[0].id],
    );
    const batchId = rows[0].id;
    const response = await agent.get(`/app/import/batches/${batchId}`);

    expect(response.status).toBe(200);
    expectPageContract(response.text);
    expect(response.text).toContain('Ошибки по строкам пакета импорта');
    await pool.query('DELETE FROM import_batches WHERE id = $1::bigint', [batchId]);
  });

  it('passes the page contract on a saved scenario snapshot', async () => {
    const csrf = await getAppCsrf(agent, '/app/scenarios');
    const saved = await agent
      .post('/app/scenarios')
      .type('form')
      .send({ _csrf: csrf, name: 'A11y snapshot', budgetByn: '1000' });

    expect(saved.status).toBe(302);
    const location = String(saved.headers.location ?? '');
    const match = /\/app\/scenarios\/(\d+)$/.exec(location);
    expect(match, `redirect after save was ${location}`).toBeTruthy();
    const scenarioId = match[1];

    const response = await agent.get(`/app/scenarios/${scenarioId}`);
    expect(response.status).toBe(200);
    expectPageContract(response.text);
    expect(response.text).toContain('data-island="scenarios"');
    await pool.query('DELETE FROM scenarios WHERE id = $1::bigint', [scenarioId]);
  });

  it('keeps aria-current on the active cohort horizon switch', async () => {
    const response = await agent.get('/app/cohorts');
    expect(response.status).toBe(200);
    const nav = /<nav class="segmented" aria-label="Горизонт когорт">([\s\S]*?)<\/nav>/.exec(response.text)?.[1] ?? '';
    expect(nav).toContain('is-active');
    expect(nav).toMatch(/<a\b[^>]*is-active[^>]*\saria-current="page"/);
  });

  it('keeps aria-current on the active scenario budget preset', async () => {
    const response = await agent.get('/app/scenarios');
    expect(response.status).toBe(200);
    const presets =
      /<div class="cluster" aria-label="Пресеты недельного бюджета">([\s\S]*?)<\/div>/.exec(response.text)?.[1] ?? '';
    expect(presets, 'default builder must render a preset).').toContain('Как сейчас');
    // The preset fragment is emitted raw; escaped output would turn the quotes into `&#34;` and fail this match.
    expect(presets).toMatch(/<a\b[^>]*\saria-current="true"/);
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
