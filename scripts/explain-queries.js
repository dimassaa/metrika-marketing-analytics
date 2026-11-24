import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { env } from '../src/config/env.js';
import { METRICS_CONFIG } from '../src/config/metrics.js';
import { startOfMonth } from '../src/lib/dates.js';
import { resolvePeriod } from '../src/lib/periods.js';
import { createMetricsRepository } from '../src/repositories/metrics.repo.js';
import { createCohortsRepository } from '../src/repositories/cohorts.repo.js';
import { createAttributionRepository } from '../src/repositories/attribution.repo.js';
import { createChannelsRepository } from '../src/repositories/channels.repo.js';
import { createCampaignsRepository } from '../src/repositories/campaigns.repo.js';
import { createReferenceRepository } from '../src/repositories/reference.repo.js';
import { resolveWeekRange } from '../src/services/metrics/weekly-series.js';

/**
 * Read-only query evidence for the four heavy screens.
 *
 * The script never copies SQL: it builds the real repositories over a proxy that rewrites each statement into
 * `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. That is why a plan here cannot drift from the plan a page produces.
 * Everything runs inside one `BEGIN READ ONLY` transaction, and the proxy refuses any statement that is not a
 * single `SELECT`/`WITH … SELECT` before PostgreSQL sees it, so the measurement cannot write to the demo database.
 */

const EXPLAIN_PREFIX = 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ';

/**
 * Statements that can never appear in a read model. `FOR UPDATE` is included on purpose: a locking select is a
 * write-capable statement for this script's contract, and no read path uses one.
 */
const FORBIDDEN_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|LISTEN|NOTIFY|SET|RESET|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|LOCK|EXPLAIN)\b/i;

/**
 * Replaces comments, string literals and quoted identifiers with placeholders.
 *
 * The keyword scan must not reject `SELECT 'delete from users'`, and it must not accept a hidden write behind a
 * block comment. Quoted identifiers are stripped too, because a column named `"update"` is still a read.
 *
 * @param {string} sql
 * @returns {string} SQL with the same statement structure and no literal content.
 * @throws {TypeError} When a quoted string, identifier or comment is unterminated.
 */
function stripLiteralsAndComments(sql) {
  let output = '';

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index + 2);
      if (end === -1) break;
      output += ' ';
      index = end;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) throw new TypeError('unterminated block comment in SQL');
      output += ' ';
      index = end + 1;
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === quote && sql[cursor + 1] === quote) {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === quote) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      if (sql[cursor - 1] !== quote) throw new TypeError('unterminated quoted value in SQL');
      output += "''";
      index = cursor - 1;
      continue;
    }

    if (char === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
      if (tag) {
        const end = sql.indexOf(tag[0], index + tag[0].length);
        if (end === -1) throw new TypeError('unterminated dollar-quoted string in SQL');
        output += "''";
        index = end + tag[0].length - 1;
        continue;
      }
    }

    output += char;
  }

  return output;
}

/**
 * Turns one read statement into its `EXPLAIN` form, rejecting anything that is not a single read.
 *
 * @param {unknown} text SQL as written by a repository.
 * @returns {string} `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) <statement>`.
 * @throws {TypeError} When the input is not a string, is empty, contains more than one statement, starts with
 *   anything other than `SELECT`/`WITH`, or mentions a write/DDL/session keyword.
 */
export function toExplainStatement(text) {
  if (typeof text !== 'string') {
    throw new TypeError('explain proxy requires SQL text as a string');
  }

  const stripped = stripLiteralsAndComments(text).trim();
  if (stripped === '') throw new TypeError('explain proxy received an empty statement');

  const withoutTrailingSemicolon = stripped.replace(/;\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    throw new TypeError('explain proxy accepts exactly one statement');
  }
  if (!/^(SELECT|WITH)\b/i.test(withoutTrailingSemicolon)) {
    throw new TypeError('explain proxy only accepts SELECT or WITH … SELECT statements');
  }
  if (FORBIDDEN_KEYWORDS.test(withoutTrailingSemicolon)) {
    throw new TypeError('explain proxy rejected a statement with a write, DDL or session keyword');
  }

  return `${EXPLAIN_PREFIX}${text.trim()}`;
}

/**
 * Reads the plan document out of the one row `EXPLAIN … FORMAT JSON` returns. `pg` parses the `json` column, so the
 * value is usually already an array; a string is accepted only as a defensive fallback for older drivers.
 *
 * @param {{ rows?: Array<Record<string, unknown>> }} result
 * @returns {{ Plan: object, 'Planning Time'?: number, 'Execution Time'?: number }}
 * @throws {TypeError} When the result does not carry a JSON plan.
 */
function readPlanDocument(result) {
  const raw = result?.rows?.[0]?.['QUERY PLAN'];
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const document = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!document || typeof document !== 'object' || !document.Plan || typeof document.Plan !== 'object') {
    throw new TypeError('EXPLAIN did not return a JSON plan; check the PostgreSQL version (14+)');
  }
  return document;
}

/**
 * Creates the measurement proxy.
 *
 * The returned object deliberately exposes only `query`. Repositories get no transaction control and no way to reach
 * the raw client; the script owns `BEGIN READ ONLY`. The result is always an empty row set, because plan rows do not
 * have the repository's columns — the callers run for their SQL, not their data.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<any> }} db Injectable client or pool.
 * @param {{ onPlan: (entry: {
 *   sql: string, plan: object, planningMs: number | undefined, executionMs: number | undefined,
 * }) => void }} hooks
 * @returns {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[], rowCount: 0, command: string }> }}
 * @throws {TypeError} When the database or the callback is missing.
 */
export function createExplainProxy(db, { onPlan } = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('createExplainProxy requires a db object with a query(text, params) method');
  }
  if (typeof onPlan !== 'function') {
    throw new TypeError('createExplainProxy requires an onPlan(entry) callback');
  }

  return {
    // Not `async`: validation must throw before a promise is scheduled, so a rejected statement never reaches the
    // database even when the caller forgets to `await`.
    query(text, params) {
      const statement = toExplainStatement(text);
      return db.query(statement, params).then((result) => {
        const document = readPlanDocument(result);
        onPlan({
          sql: text,
          plan: document.Plan,
          planningMs: document['Planning Time'],
          executionMs: document['Execution Time'],
        });
        return { rows: [], rowCount: 0, command: 'EXPLAIN' };
      });
    },
  };
}

/**
 * Flattens a plan tree into one line per table access.
 *
 * @param {object} node
 * @returns {string[]} Entries such as `Index Scan using customers_first_order_idx on customers`.
 */
function describeScans(node) {
  const scans = [];
  const visit = (current) => {
    if (!current || typeof current !== 'object') return;
    const type = current['Node Type'];
    if (typeof type === 'string' && type.includes('Scan')) {
      const relation = current['Relation Name'] ?? current['Index Name'] ?? current['CTE Name'] ?? '?';
      const index = current['Index Name'] ? ` using ${current['Index Name']}` : '';
      scans.push(`${type}${index} on ${relation}`);
    }
    for (const child of current.Plans ?? []) visit(child);
    for (const child of current.InitiPlans ?? []) visit(child);
  };
  visit(node);
  return scans;
}

/**
 * @param {string} sql
 * @returns {string} Whitespace-normalised SQL, used as the dedupe key.
 */
function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * Repository bundles for each screen. The lists mirror the service fan-out; a screen's chart and the health report
 * share statements, so the runner deduplicates by SQL and counts repeated executions.
 */
function scenarioSteps(name, context, repositories) {
  const { period, weeklyPeriod, cohortFilters: cohorts, channelId } = context;
  const healthSteps = [
    { label: 'CAC inputs', run: () => repositories.metrics.listChannelCacInputs(period) },
    { label: 'cohort sizes', run: () => repositories.cohorts.listCohortSizes(cohorts) },
    { label: 'cohort margins', run: () => repositories.cohorts.listCohortMonthlyMargins(cohorts) },
    { label: 'cohort channel dimension', run: () => repositories.cohorts.listChannels({ channelId: null }) },
    { label: 'attribution orders', run: () => repositories.attribution.listOrdersInPeriod(period) },
    { label: 'attribution touchpoints', run: () => repositories.attribution.listTouchpointsForOrders(period) },
    { label: 'channel spend', run: () => repositories.metrics.listChannelSpend(period) },
    { label: 'channel dimension', run: () => repositories.channels.listChannels() },
  ];

  switch (name) {
    case 'dashboard':
      return [
        ...healthSteps,
        { label: 'weekly CAC series', run: () => repositories.metrics.listWeeklySeries(weeklyPeriod) },
        { label: 'weekly orders', run: () => repositories.attribution.listOrdersInPeriod(weeklyPeriod) },
        { label: 'weekly touchpoints', run: () => repositories.attribution.listTouchpointsForOrders(weeklyPeriod) },
      ];
    case 'channels':
      return [
        ...healthSteps,
        { label: 'channel list meta', run: () => repositories.channels.listChannels() },
        {
          label: 'weekly CAC sparklines',
          run: () => repositories.metrics.listChannelWeeklyCacInputs(weeklyPeriod),
        },
      ];
    case 'cohorts':
      return [
        { label: 'cohort sizes', run: () => repositories.cohorts.listCohortSizes(cohorts) },
        { label: 'cohort margins', run: () => repositories.cohorts.listCohortMonthlyMargins(cohorts) },
        { label: 'cohort channel dimension', run: () => repositories.cohorts.listChannels({ channelId: null }) },
      ];
    case 'attribution':
      return [
        { label: 'attribution orders', run: () => repositories.attribution.listOrdersInPeriod(period) },
        { label: 'attribution touchpoints', run: () => repositories.attribution.listTouchpointsForOrders(period) },
        { label: 'channel spend', run: () => repositories.metrics.listChannelSpend(period) },
        { label: 'channel dimension', run: () => repositories.channels.listChannels() },
      ];
    case 'passport':
      return [
        { label: 'channel card lookup', run: () => repositories.channels.findChannelById(channelId) },
        ...healthSteps,
        { label: 'weekly CAC series', run: () => repositories.metrics.listWeeklySeries(weeklyPeriod) },
        { label: 'weekly orders', run: () => repositories.attribution.listOrdersInPeriod(weeklyPeriod) },
        { label: 'weekly touchpoints', run: () => repositories.attribution.listTouchpointsForOrders(weeklyPeriod) },
        { label: 'channel funnel', run: () => repositories.metrics.getChannelFunnel({ ...period, channelId }) },
        {
          label: 'channel campaigns',
          run: () => repositories.campaigns.listCampaigns({ channelId }),
        },
        {
          label: 'campaign CAC inputs',
          run: () => repositories.metrics.listCampaignCacInputs({ ...period, channelId }),
        },
      ];
    default:
      throw new TypeError(`unknown query scenario: ${name}`);
  }
}

/** @type {ReadonlyArray<{ name: string, description: string }>} */
export const SCENARIOS = Object.freeze([
  { name: 'dashboard', description: 'health report + weekly series' },
  { name: 'channels', description: 'health report + channel dimension + sparklines' },
  { name: 'cohorts', description: 'cohort sizes, margins and dimension inside one snapshot query set' },
  { name: 'attribution', description: 'orders, touchpoints, spend and channel dimension' },
  { name: 'passport', description: 'channel card: health, funnel, campaigns' },
]);

/**
 * Parses `--query`, `--json` and `--help`. Unknown flags fail instead of being ignored, so a typo cannot silently
 * measure the default set.
 *
 * @param {string[]} argv
 * @returns {{ queries: string[], json: boolean, help: boolean }}
 * @throws {Error} When an option is unknown or a scenario name is not in {@link SCENARIOS}.
 */
export function parseArgs(argv) {
  const queries = [];
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--query') {
      const value = argv[index + 1];
      if (!value) throw new Error('--query требует имя сценария');
      queries.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
      index += 1;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${arg}`);
  }

  const known = new Set(SCENARIOS.map((scenario) => scenario.name));
  const selected = queries.length === 0 || queries.includes('all') ? [...known] : queries;
  for (const name of selected) {
    if (!known.has(name)) {
      throw new Error(`неизвестный сценарий "${name}"; доступны: all, ${[...known].join(', ')}`);
    }
  }

  return { queries: [...new Set(selected)], json, help };
}

/**
 * Runs every selected scenario and returns one record per unique statement.
 *
 * @param {import('pg').PoolClient} client Client already inside `BEGIN READ ONLY`.
 * @param {string[]} queries
 * @param {ReturnType<typeof referenceContext>} context
 * @returns {Promise<Array<{ name: string, description: string, queries: object[] }>>}
 */
async function measureScenarios(client, queries, context) {
  const results = [];

  for (const name of queries) {
    const scenario = SCENARIOS.find((item) => item.name === name);
    if (!scenario) throw new TypeError(`unknown query scenario: ${name}`);

    /** @type {Array<{ sql: string, label: string, plan: object, planningMs?: number, executionMs?: number }>} */
    const plans = [];
    let currentLabel = 'unknown';
    const proxy = createExplainProxy(client, {
      onPlan: (entry) => plans.push({ ...entry, label: currentLabel }),
    });
    const repositories = {
      metrics: createMetricsRepository(proxy),
      cohorts: createCohortsRepository(proxy),
      attribution: createAttributionRepository(proxy),
      channels: createChannelsRepository(proxy),
      campaigns: createCampaignsRepository(proxy),
    };

    for (const step of scenarioSteps(name, context, repositories)) {
      currentLabel = step.label;
      await step.run();
    }

    /** @type {Map<string, object>} */
    const unique = new Map();
    for (const entry of plans) {
      const key = normalizeSql(entry.sql);
      const existing = unique.get(key);
      if (existing) {
        existing.runs += 1;
        continue;
      }
      unique.set(key, {
        label: entry.label,
        sql: entry.sql.trim(),
        plan: entry.plan,
        planningMs: entry.planningMs,
        executionMs: entry.executionMs,
        runs: 1,
      });
    }

    results.push({ name, description: scenario.description, queries: [...unique.values()] });
  }

  return results;
}

/**
 * Turns a plan row into the columns the report prints.
 *
 * @param {{ plan: object, executionMs?: number, planningMs?: number }} entry
 * @returns {{ node: string, scans: string, rows: number | null, ms: number | null }}
 */
function summarizePlan(entry) {
  const plan = entry.plan;
  const scans = describeScans(plan);
  return {
    node: String(plan['Node Type'] ?? '?'),
    scans: scans.length > 0 ? scans.join('; ') : '—',
    rows: Number.isFinite(plan['Actual Rows']) ? plan['Actual Rows'] : null,
    ms: Number.isFinite(entry.executionMs) ? entry.executionMs : null,
  };
}

/**
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
function pad(text, width) {
  return String(text).length >= width ? String(text) : String(text).padEnd(width);
}

/**
 * @param {Array<{ name: string, description: string, queries: object[] }>} results
 * @returns {void}
 */
function printTable(results) {
  for (const scenario of results) {
    console.log(`\n${scenario.name} — ${scenario.description}`);
    console.log(
      `${pad('statement', 34)} ${pad('node', 18)} ${pad('access', 64)} ${pad('rows', 6)} ${pad('ms', 8)} runs`,
    );
    for (const entry of scenario.queries) {
      const summary = summarizePlan(entry);
      console.log(
        `${pad(entry.label ?? entry.sql.split('\n')[0].slice(0, 33), 34)} ` +
          `${pad(summary.node, 18)} ${pad(summary.scans, 64)} ` +
          `${pad(summary.rows ?? '—', 6)} ${pad(summary.ms === null ? '—' : summary.ms.toFixed(2), 8)} ${entry.runs}`,
      );
    }
  }
}

/**
 * @param {string} anchor
 * @param {string} channelId
 * @returns {{
 *   period: { from: string, to: string },
 *   weeklyPeriod: { from: string, to: string },
 *   cohortFilters: { fromCohortMonth: null, toCohortMonth: string, channelId: null, anchor: string },
 *   channelId: string,
 * }}
 */
function referenceContext(anchor, channelId) {
  const period = resolvePeriod({ anchor });
  const { firstWeekStart } = resolveWeekRange(period.to, METRICS_CONFIG.dashboard.weeks);
  return {
    period: { from: period.from, to: period.to },
    weeklyPeriod: { from: firstWeekStart, to: period.to },
    cohortFilters: {
      fromCohortMonth: null,
      toCohortMonth: startOfMonth(anchor),
      channelId: null,
      anchor,
    },
    channelId,
  };
}

const HELP = `Измерение планов запросов «Метрики» (read-only).

  node scripts/explain-queries.js [--query dashboard|channels|cohorts|attribution|passport|all,...] [--json]

  --query  сценарий или список через запятую; по умолчанию все
  --json   печатать полные планы и SQL вместо таблицы

Скрипт использует DATABASE_URL, открывает BEGIN READ ONLY и переписывает только одиночные
SELECT/WITH … SELECT в EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON). Любой другой оператор
отклоняется до отправки в PostgreSQL.`;

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP);
    return;
  }

  const pool = new pg.Pool({
    connectionString: env.databaseUrl,
    max: 1,
    application_name: 'metrika-explain',
  });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");

    const referenceRepository = createReferenceRepository(client);
    const anchor = await referenceRepository.getDataAnchor();
    if (!anchor) {
      throw new Error('нет данных daily_stats: нечего измерять, выполните npm run seed');
    }

    const context = referenceContext(anchor, '1');
    const results = await measureScenarios(client, options.queries, context);

    await client.query('ROLLBACK');

    if (options.json) {
      console.log(JSON.stringify({ anchor, scenarios: results }, null, 2));
    } else {
      console.log(`data anchor: ${anchor}`);
      printTable(results);
    }
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is the actionable one; a failed rollback on a broken connection must not mask it.
      }
    }
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

// Importing this module from a test must not connect to PostgreSQL; only a direct CLI invocation runs `main`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`explain-queries: ${error.message}`);
    process.exitCode = 1;
  });
}
