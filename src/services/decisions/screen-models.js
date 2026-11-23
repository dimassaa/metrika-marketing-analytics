import { METRICS_CONFIG } from '../../config/metrics.js';
import { formatDateRu } from '../../lib/dates.js';
import {
  formatCentsToByn,
  formatDateTimeRu,
  formatInteger,
  formatMonths,
  formatPercent,
  formatRatio,
} from '../../lib/format.js';
import { centsToApi, roundNumber } from '../../lib/metrics-math.js';
import { buildQueryString } from '../../lib/query.js';

/**
 * Screen models for the decisions screens.
 *
 * This module is the only place where a service result becomes the object the page and `/api/v1` both receive.
 * React renders from it, and every number arrives as a ready formatted string; the island never re-derives money,
 * percentages or month counts. The full chart model lands with Task 7; this version keeps the same top-level shape
 * so the page and the API cannot drift while the charts are still basic.
 */

const RULE_LABELS = Object.freeze({
  cac_spike: 'Всплеск CAC',
  romi_below_target: 'ROMI ниже цели',
  romi_negative: 'Отрицательный ROMI',
  payback_long: 'Долгая окупаемость',
  ltv_cac_low: 'Низкий LTV:CAC',
});

const SEVERITY_LABELS = Object.freeze({ warning: 'Предупреждение', critical: 'Критично' });
const STATUS_LABELS = Object.freeze({ active: 'Активен', resolved: 'Закрыт', dismissed: 'Скрыт' });
const CURVE_LABELS = Object.freeze({
  saturation: 'Насыщение',
  linear: 'Линейная',
  no_data: 'Нет данных',
});

const STATUS_OPTIONS = Object.freeze([
  { value: 'active', label: 'Активные' },
  { value: 'all', label: 'Все' },
  { value: 'resolved', label: 'Закрытые' },
  { value: 'dismissed', label: 'Скрытые' },
]);

const SEVERITY_OPTIONS = Object.freeze([
  { value: 'all', label: 'Все важности' },
  { value: 'warning', label: 'Предупреждения' },
  { value: 'critical', label: 'Критичные' },
]);

/**
 * Converts a NUMERIC(14,4) BYN decimal string to whole kopecks without a float round trip. * @param {string | null | undefined} value Decimal BYN amount as stored in `alerts.value`/`threshold`.
 * @returns {bigint | null} Kopecks, or null when the value is absent.
 */
function bynDecimalToCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(text);
  if (!match) throw new TypeError(`alert decimal is not a BYN amount: ${JSON.stringify(value)}`);

  const [, whole, fraction = ''] = match;
  const centsDigits = fraction.padEnd(3, '0').slice(0, 3);
  const fourth = Number(fraction[3] ?? '0');
  let cents = BigInt(whole) * 100n + BigInt(centsDigits);
  if (fourth >= 5) cents += 1n;
  return cents;
}

/**
 * Formats one alert trace value in the unit its rule uses.
 * @param {string} rule Rule code from the `alerts` table.
 * @param {string | null | undefined} raw Stored NUMERIC value.
 * @returns {{ label: string, unit: string | null }} Ready-to-display value and its separate unit.
 */
function formatRuleValue(rule, raw) {
  if (raw === null || raw === undefined || raw === '') return { label: '—', unit: null };

  switch (rule) {
    case 'cac_spike':
      return { label: formatCentsToByn(bynDecimalToCents(raw)), unit: 'BYN' };
    case 'romi_below_target':
    case 'romi_negative':
      return { label: formatPercent(raw), unit: null };
    case 'payback_long':
      return { label: formatMonths(raw), unit: 'мес.' };
    case 'ltv_cac_low':
      return { label: formatRatio(raw, { decimals: 2 }), unit: null };
    default:
      return { label: String(raw), unit: null };
  }
}

/**
 * @param {string | Date | null | undefined} value
 * @returns {string} `DD.MM.YYYY HH:mm` in Minsk, or the honest empty-state label.
 */
function lastRecalculatedLabel(value) {
  return value ? formatDateTimeRu(value) : 'Ещё не проверяли';
}

/**
 * Alert list and summary model.
 *
 * `lastRecalculatedLabel` is an absolute `MAX(detected_at)` timestamp, never the request time. `isStale` only reports
 * whether that stored check is older than the session throttle; it is a hint for the analyst, not the throttle itself.
 *
 * @param {{
 *   window: object,
 *   rows: object[],
 *   summary: object,
 *   filters: { status: string, severity: string, channelId: string | null },
 *   filterOptions?: { channels?: object[] },
 *   isStale?: boolean,
 * }} input
 * @returns {object} Screen model shared by the page and `/api/v1/alerts`.
 */
export function buildAlertsScreen({
  window,
  rows,
  summary,
  filters,
  filterOptions = {},
  chart = null,
  pagination = null,
  isStale,
}) {
  const now = window.now ?? window;
  const channelId = filters.channelId ?? null;
  const status = filters.status ?? 'active';
  const severity = filters.severity ?? 'all';
  const page = pagination?.page ?? summary.page ?? 1;
  const total = pagination?.total ?? summary.total ?? rows.length;
  const hasMore = pagination?.hasMore ?? summary.hasMore === true;
  const lastDetectedAt = summary.lastDetectedAt ?? null;
  const stale = isStale ?? (
    lastDetectedAt === null ||
    Date.now() - new Date(lastDetectedAt).getTime() > METRICS_CONFIG.alerts.autoRecalcMs
  );
  const query = { status, severity, channelId };

  const mappedRows = rows.map((row) => {
    const value = formatRuleValue(row.rule, row.value);
    const threshold = formatRuleValue(row.rule, row.threshold);
    return {
      id: row.id,
      channelId: row.channelId,
      channelCode: row.channelCode,
      channelName: row.channelName,
      rule: row.rule,
      ruleLabel: RULE_LABELS[row.rule] ?? row.rule,
      severity: row.severity,
      severityLabel: SEVERITY_LABELS[row.severity] ?? row.severity,
      value: row.value,
      valueLabel: value.label,
      valueUnit: value.unit,
      threshold: row.threshold,
      thresholdLabel: threshold.label,
      thresholdUnit: threshold.unit,
      periodStart: row.periodStart,
      periodLabel: formatDateRu(row.periodStart),
      status: row.status,
      statusLabel: STATUS_LABELS[row.status] ?? row.status,
      detectedAt: row.detectedAt,
      detectedAtLabel: formatDateTimeRu(row.detectedAt),
      dismissHref: `/app/alerts/${row.id}/dismiss`,
    };
  });

  const statusOptions = STATUS_OPTIONS.map((option) => ({
    ...option,
    selected: option.value === status,
  }));
  const severityOptions = SEVERITY_OPTIONS.map((option) => ({
    ...option,
    selected: option.value === severity,
  }));
  const channelOptions = (filterOptions.channels ?? []).map((channel) => ({
    value: channel.id,
    label: channel.name,
    selected: channel.id === channelId,
  }));

  const prevHref = page > 1
    ? `/app/alerts?${buildQueryString(query, { page: page - 1 })}`
    : null;
  const nextHref = hasMore
    ? `/app/alerts?${buildQueryString(query, { page: page + 1 })}`
    : null;

  return {
    page: 'alerts',
    window: {
      anchor: window.anchor,
      weeks: window.weeks,
      periodStart: now.periodStart,
      from: now.from,
      to: now.to,
      label: `${formatDateRu(now.from)} — ${formatDateRu(now.to)}`,
    },
    filters: {
      status,
      severity,
      channelId,
      active: status !== 'active' || severity !== 'all' || channelId !== null,
      resetHref: '/app/alerts',
    },
    filterOptions: {
      status: statusOptions,
      severity: severityOptions,
      channels: channelOptions,
    },
    summary: {
      active: summary.active ?? 0,
      activeLabel: formatInteger(summary.active ?? 0),
      critical: summary.critical ?? 0,
      criticalLabel: formatInteger(summary.critical ?? 0),
      warning: summary.warning ?? 0,
      warningLabel: formatInteger(summary.warning ?? 0),
      resolved: summary.resolved ?? 0,
      resolvedLabel: formatInteger(summary.resolved ?? 0),
      dismissed: summary.dismissed ?? 0,
      dismissedLabel: formatInteger(summary.dismissed ?? 0),
      lastDetectedAt: lastDetectedAt instanceof Date ? lastDetectedAt.toISOString() : lastDetectedAt,
      lastRecalculatedLabel: summary.lastRecalculatedLabel ?? lastRecalculatedLabel(lastDetectedAt),
      isStale: stale,
    },
    rows: mappedRows,
    // Charts are Task 7; a caller can pass a built chart now and keep the same model contract.
    chart,
    pagination: {
      page,
      total,
      hasMore,
      totalPages: Math.max(1, Math.ceil(total / 50)),
      prevHref,
      nextHref,
    },
    empty: mappedRows.length === 0,
  };
}

/**
 * @param {number | null | undefined} value Fractional customer count.
 * @returns {string} One decimal with a comma, or `—`.
 */
function customersLabel(value) {
  if (value === null || value === undefined) return '—';
  return roundNumber(value, 1).toFixed(1).replace('.', ',');
}

/**
 * @param {bigint} cents
 * @returns {string} Dot-decimal input value for `<input type="number">`.
 */
function centsToInput(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

/**
 * @param {object} side `{ spendCents, customers }` from a stored scenario side.
 * @returns {{ spendCents: string, spendLabel: string, customers: number, customersLabel: string }}
 */
function mapSide(side) {
  return {
    spendCents: String(side.spendCents),
    spendLabel: formatCentsToByn(side.spendCents),
    customers: side.customers,
    customersLabel: customersLabel(side.customers),
  };
}

/**
 * @param {object | null} forecast Stored forecast block.
 * @returns {object | null}
 */
function mapForecast(forecast) {
  if (!forecast) return null;
  return {
    customers: forecast.customers,
    customersLabel: customersLabel(forecast.customers),
    revenue12Cents: forecast.revenue12Cents,
    revenue12Label: forecast.revenue12Cents === null ? '—' : formatCentsToByn(forecast.revenue12Cents),
    cacCents: forecast.cacCents,
    cacLabel: forecast.cacCents === null ? '—' : formatCentsToByn(forecast.cacCents),
    romi12: forecast.romi12,
    romiLabel: forecast.romi12 === null ? '—' : formatPercent(forecast.romi12, { signed: true }),
  };
}

/**
 * @param {object} channel Stored scenario channel row.
 * @returns {object} Channel row for the island table.
 */
function mapScenarioChannel(channel) {
  return {
    channelId: channel.channelId,
    channelCode: channel.channelCode,
    channelName: channel.channelName,
    model: channel.model,
    modelLabel: CURVE_LABELS[channel.model] ?? channel.model,
    note: channel.note,
    current: mapSide(channel.current),
    planned: channel.planned ? mapSide(channel.planned) : null,
    forecast: mapForecast(channel.forecast),
  };
}

/**
 * Builds the budget block from the current weekly baseline and the resolved plan budget.
 * @param {{ baselineCents: bigint, budgetCents: bigint }} input
 * @returns {object}
 */
function buildBudget({ baselineCents, budgetCents }) {
  const capCents = baselineCents * BigInt(METRICS_CONFIG.scenarios.maxBudgetMultiplier);
  const warnAboveCents = baselineCents * BigInt(METRICS_CONFIG.scenarios.warnBudgetMultiplier);
  const forecast12mCents = budgetCents * 52n;

  return {
    weeklyCents: centsToApi(budgetCents),
    weeklyLabel: formatCentsToByn(budgetCents),
    weeklyInput: centsToInput(budgetCents),
    forecast12mCents: centsToApi(forecast12mCents),
    forecast12mLabel: formatCentsToByn(forecast12mCents),
    capCents: centsToApi(capCents),
    capLabel: formatCentsToByn(capCents),
    capInput: centsToInput(capCents),
    warnAboveCents: centsToApi(warnAboveCents),
    warnAboveLabel: formatCentsToByn(warnAboveCents),
    isAboveWarn: budgetCents > warnAboveCents,
    period: 'week',
  };
}

/**
 * @param {object[]} rows Saved scenarios list rows.
 * @returns {object[]} Rows with display labels and their detail links.
 */
function mapScenarioList(rows) {
  return rows.map((row) => ({
    ...row,
    createdAtLabel: formatDateTimeRu(row.createdAt),
    anchorLabel: row.anchor ? formatDateRu(row.anchor) : null,
    budgetLabel: row.budgetCents === null ? '—' : formatCentsToByn(row.budgetCents),
    channelCountLabel: row.channelCount === null ? '—' : formatInteger(row.channelCount),
    href: `/app/scenarios/${row.id}`,
  }));
}

/**
 * @param {object} result Stored scenario result.
 * @returns {object} Totals block with labels.
 */
function mapTotals(result) {
  return {
    current: mapSide(result.totals.current),
    planned: mapSide(result.totals.planned),
    forecast: mapForecast(result.totals.forecast),
  };
}

/**
 * Builder screen model: the current plan, its channel table and the saved-scenario list.
 *
 * @param {{
 *   scenario: object,
 *   list: { rows: object[], page: number, total: number, hasMore: boolean },
 *   query: { budgetByn?: unknown, channelIds?: string[] | null, curveChannelId?: string | null, page?: number },
 *   anchor: string,
 *   channels?: object[],
 *   mode?: 'builder',
 * }} input
 * @returns {object} Screen model shared by the page and `/api/v1/scenarios`.
 */
export function buildScenariosScreen({
  scenario,
  list = { rows: [], page: 1, total: 0, hasMore: false },
  query = {},
  anchor = null,
  channels = [],
  mode = 'builder',
}) {
  const baselineCents = BigInt(scenario.totals.current.spendCents);
  const budgetCents = BigInt(scenario.totals.planned.spendCents);
  const mappedChannels = scenario.channels.map(mapScenarioChannel);
  const selected = new Set(query.channelIds ?? scenario.channels.map((channel) => channel.channelId));

  const dimension = channels.length > 0
    ? channels
    : scenario.channels.map((channel) => ({
        id: channel.channelId,
        code: channel.channelCode,
        name: channel.channelName,
      }));

  const controls = {
    budgetPeriod: 'week',
    budgetInput: centsToInput(budgetCents),
    budgetValue: centsToApi(budgetCents),
    budgetLabel: formatCentsToByn(budgetCents),
    curveChannelId: query.curveChannelId ?? null,
    channels: dimension.map((channel) => ({
      value: channel.id,
      label: channel.name,
      code: channel.code,
      selected: selected.has(channel.id),
    })),
  };
  controls.selectedChannels = controls.channels.filter((channel) => channel.selected);

  return {
    page: 'scenarios',
    mode,
    budgetPeriod: 'week',
    anchor,
    history: {
      weeks: METRICS_CONFIG.saturation.historyWeeks,
      label: `${METRICS_CONFIG.saturation.historyWeeks} недель`,
    },
    budget: buildBudget({ baselineCents, budgetCents }),
    controls,
    channels: mappedChannels,
    totals: mapTotals(scenario),
    warnings: scenario.warnings ?? [],
    // The four charts (spend, customers, saturation, increment) land in Task 7; the tables above keep the screen
    // usable and every number comes from the same snapshot.
    charts: null,
    list: {
      rows: mapScenarioList(list.rows),
      page: list.page,
      total: list.total,
      hasMore: list.hasMore,
    },
    empty: list.total === 0,
    error: null,
  };
}

/**
 * Detail screen model. Renders exactly the stored snapshot; it never refits a curve or reads live metrics.
 *
 * @param {{ scenario: object }} input `scenario` is `getScenarioDetail` output.
 * @returns {object} Screen model shared by the page and `/api/v1/scenarios/:id`.
 */
export function buildScenarioDetailScreen({ scenario }) {
  const base = {
    page: 'scenarios',
    mode: 'detail',
    budgetPeriod: 'week',
    id: scenario.id,
    name: scenario.name,
    authorLabel: scenario.authorLabel,
    createdAt: scenario.createdAt,
    createdAtLabel: formatDateTimeRu(scenario.createdAt),
    savedAnchor: scenario.savedAnchor ?? null,
    savedAnchorLabel: scenario.savedAnchor ? formatDateRu(scenario.savedAnchor) : null,
    invalid: scenario.invalid === true,
    invalidReason: scenario.invalidReason ?? null,
    error: null,
  };

  if (scenario.invalid || !scenario.result || !scenario.params) {
    return {
      ...base,
      budget: null,
      controls: null,
      history: null,
      channels: [],
      totals: null,
      warnings: [],
      charts: null,
      list: null,
      empty: false,
    };
  }

  const result = scenario.result;
  const baselineCents = BigInt(result.totals.current.spendCents);
  const budgetCents = BigInt(scenario.params.budgetCents);
  const budget = buildBudget({ baselineCents, budgetCents });

  return {
    ...base,
    history: {
      weeks: scenario.params.history.weeks,
      from: scenario.params.history.from,
      to: scenario.params.history.to,
      label: `${scenario.params.history.weeks} недель`,
    },
    budget,
    controls: null,
    channels: result.channels.map(mapScenarioChannel),
    totals: mapTotals(result),
    warnings: result.warnings ?? [],
    charts: null,
    list: null,
    empty: false,
    repeatHref: `/app/scenarios?${buildQueryString({}, {
      budgetByn: budget.weeklyInput,
      channelIds: result.channels.map((channel) => channel.channelId),
    })}`,
  };
}
