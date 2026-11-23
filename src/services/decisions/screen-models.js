import { DECISIONS_CONFIG } from '../../config/decisions.js';
import { METRICS_CONFIG } from '../../config/metrics.js';
import { addDays, formatDateRu } from '../../lib/dates.js';
import {
  formatCentsToByn,
  formatDateTimeRu,
  formatInteger,
  formatMonths,
  formatPercent,
  formatRatio,
} from '../../lib/format.js';
import { centsToApi, roundHalfUp, roundNumber } from '../../lib/metrics-math.js';
import { parseBynToCents } from '../../lib/money.js';
import { buildQueryString } from '../../lib/query.js';
import { resolveWeekRange } from '../metrics/weekly-series.js';
import { buildScenarioCharts } from './scenario-charts.js';

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
 * Converts a NUMERIC(14,4) BYN decimal string to whole kopecks without a float round trip.
 *
 * The stored fraction is a BYN fraction (four decimals), not kopecks. Treating its first three digits as kopecks
 * (the previous bug) turns `58.6850` into `6485` instead of `5869`. Scaling the four-digit fraction to kopecks and
 * adding half a kopeck before the integer division implements half-up rounding at the fourth decimal.
 *
 * @param {string | null | undefined} value Decimal BYN amount as stored in `alerts.value`/`threshold`.
 * @returns {bigint | null} Kopecks, or null when the value is absent.
 */
export function bynDecimalToCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(text);
  if (!match) throw new TypeError(`alert decimal is not a BYN amount: ${JSON.stringify(value)}`);

  const [, whole, fraction = ''] = match;
  const fractionCents = (BigInt(fraction.padEnd(4, '0')) + 50n) / 100n;
  return BigInt(whole) * 100n + fractionCents;
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
 * @returns {string} `DD.MM.YYYY HH:mm` in Minsk, or the honest no-trigger label.
 */
function lastTriggeredLabel(value) {
  return value ? formatDateTimeRu(value) : 'Срабатываний ещё не было';
}

/**
 * Alert list and summary model.
 *
 * `lastTriggeredLabel` is an absolute `MAX(detected_at)` timestamp, never the request time. That column records the
 * last time a rule fired, not a heartbeat: a recalculation with no triggers leaves it unchanged. `isStale` is decided
 * by the controller from that stored check and only reports the age; this builder deliberately has no clock.
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
  // Staleness belongs to the controller: it knows when the check ran and must not make the screen model depend on the
  // system clock, which would make one model render differently on two identical requests.
  const stale = isStale === true;
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
  const anyAlerts =
    (summary.active ?? 0) + (summary.resolved ?? 0) + (summary.dismissed ?? 0) > 0;
  const filterActive = status !== 'active' || severity !== 'all' || channelId !== null;
  const filteredEmpty = mappedRows.length === 0 && filterActive && anyAlerts;
  const emptyState = filteredEmpty
    ? {
        title: 'По фильтру ничего не найдено',
        text: 'Смените статус, важность или канал: сводка выше считает все алерты, а таблица следует фильтру.',
      }
    : {
        title: 'Алертов пока нет',
        text:
          'Правила молчат, когда в обоих окнах есть расход и новые клиенты, а пороги не превышены. ' +
          'Пересчитайте алерты или загрузите статистику.',
      };

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
      lastTriggeredLabel: summary.lastTriggeredLabel ?? lastTriggeredLabel(lastDetectedAt),
      isStale: stale,
    },
    rows: mappedRows,
    // Charts are Task 7; a caller can pass a built chart now and keep the same model contract.
    chart,
    pagination: {
      page,
      total,
      hasMore,
      totalPages: Math.max(1, Math.ceil(total / DECISIONS_CONFIG.alertsPageSize)),
      prevHref,
      nextHref,
    },
    empty: mappedRows.length === 0,
    emptyState,
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
 * @returns {string} Dot-decimal BYN value accepted by both the range and the error-state number input (the form
 *   submits decimal BYN, never kopecks).
 */
function centsToInput(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

/**
 * The 26 complete weeks a scenario fits, derived from the data anchor rather than the system clock.
 * @param {string | null | undefined} anchor `YYYY-MM-DD` or null when the builder could not compute.
 * @returns {{ weeks: number, label: string, from?: string, to?: string }}
 */
function scenarioHistory(anchor) {
  const weeks = METRICS_CONFIG.saturation.historyWeeks;
  if (typeof anchor !== 'string' || anchor === '') return { weeks, label: `${weeks} недель` };

  const { firstWeekStart, lastWeekStart } = resolveWeekRange(anchor, weeks);
  return { weeks, label: `${weeks} недель`, from: firstWeekStart, to: addDays(lastWeekStart, 6) };
}

/**
 * Current weekly spend of the channels the optimizer can allocate. This is the single base for the cap, the
 * extrapolation warning and the chart's "current" reference. A linear/no_data channel stays in `totals.current` — it
 * is real spend — but its spend must not raise a ceiling for a plan it cannot receive.
 *
 * @param {object[]} channels Stored scenario channel rows.
 * @returns {bigint}
 */
function optimizableBaselineCents(channels) {
  return channels.reduce(
    (sum, channel) => (channel.model === 'saturation' ? sum + BigInt(channel.current.spendCents) : sum),
    0n,
  );
}

/** @param {object[]} channels @returns {number} */
function optimizableChannelCount(channels) {
  return channels.filter((channel) => channel.model === 'saturation').length;
}

/**
 * Budget shortcuts for the builder. They are links, not JavaScript handlers, so the slider and the presets share one
 * server-rendered GET contract.
 *
 * @param {{
 *   baselineCents: bigint,
 *   budgetCents: bigint,
 *   capCents: bigint,
 *   channelIds: string[],
 *   curveChannelId: string | null,
 * }} input
 * @returns {Array<{ key: string, label: string, href: string, active: boolean }>}
 */
function budgetPresets({ baselineCents, budgetCents, capCents, channelIds, curveChannelId }) {
  const candidates = [
    { key: 'current', label: 'Как сейчас', cents: baselineCents },
    { key: 'plus20', label: '+20 %', cents: (baselineCents * 120n + 50n) / 100n },
    { key: 'double', label: '×2', cents: baselineCents * 2n },
  ];

  return candidates.map((candidate) => {
    const cents = candidate.cents > capCents ? capCents : candidate.cents;
    return {
      key: candidate.key,
      label: candidate.label,
      href: `/app/scenarios?${buildQueryString({}, {
        budgetByn: centsToInput(cents),
        channelIds,
        curveChannelId,
      })}`,
      active: cents === budgetCents,
    };
  });
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
 * Builds the budget block from the optimizable baseline and the resolved plan budget.
 *
 * `minCents` is the feasible minimum the optimizer accepts: one kopeck per optimizable channel. The slider used to
 * start at a hard-coded `0.01`, which is below that minimum whenever two or more curves exist and made the keyboard
 * Home position submit an invalid budget.
 *
 * @param {{ baselineCents: bigint, budgetCents: bigint, optimizableCount: number }} input
 * @returns {object}
 */
function buildBudget({ baselineCents, budgetCents, optimizableCount }) {
  const capCents = baselineCents * BigInt(METRICS_CONFIG.scenarios.maxBudgetMultiplier);
  const warnAboveCents = baselineCents * BigInt(METRICS_CONFIG.scenarios.warnBudgetMultiplier);
  const forecast12mCents = budgetCents * BigInt(DECISIONS_CONFIG.weeksPerYear);
  const minCents = BigInt(Math.max(1, optimizableCount));

  return {
    weeklyCents: centsToApi(budgetCents),
    weeklyLabel: formatCentsToByn(budgetCents),
    weeklyInput: centsToInput(budgetCents),
    forecast12mCents: centsToApi(forecast12mCents),
    forecast12mLabel: formatCentsToByn(forecast12mCents),
    weeksPerYear: DECISIONS_CONFIG.weeksPerYear,
    maxMultiplier: METRICS_CONFIG.scenarios.maxBudgetMultiplier,
    warnMultiplier: METRICS_CONFIG.scenarios.warnBudgetMultiplier,
    baselineCents: centsToApi(baselineCents),
    baselineLabel: formatCentsToByn(baselineCents),
    minCents: centsToApi(minCents),
    minInput: centsToInput(minCents),
    minLabel: formatCentsToByn(minCents),
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
 * Saved-scenario list block. The page lists at most `scenariosPageSize` snapshots, so it must say how many of the
 * total it is showing and offer the next page instead of silently truncating the history.
 *
 * @param {{ rows: object[], page: number, total: number, hasMore: boolean }} list
 * @param {object} [query] Current builder query, replayed on the pager links.
 * @returns {object}
 */
function buildScenarioList(list, query = {}) {
  const rows = mapScenarioList(list.rows);
  const pageHref = (page) => `/app/scenarios?${buildQueryString(query, { page })}`;

  return {
    rows,
    page: list.page,
    pageSize: DECISIONS_CONFIG.scenariosPageSize,
    total: list.total,
    hasMore: list.hasMore,
    shownLabel: list.total > rows.length ? `Показаны ${rows.length} из ${list.total}` : null,
    prevHref: list.page > 1 ? pageHref(list.page - 1) : null,
    nextHref: list.hasMore ? pageHref(list.page + 1) : null,
  };
}

/**
 * @param {object} result Stored scenario result.
 * @returns {object} Totals block with labels.
 */
function mapTotals(result) {
  const current = mapSide(result.totals.current);
  // The current CAC is derivable from the same four-week average the table shows; leaving it as a dash next to a
  // nonzero spend and customer count would imply "not measured" when the numbers are right there.
  const currentCacCents = result.totals.current.customers > 0
    ? roundHalfUp(Number(result.totals.current.spendCents) / result.totals.current.customers)
    : null;

  return {
    current: {
      ...current,
      cacCents: centsToApi(currentCacCents),
      cacLabel: currentCacCents === null ? '—' : formatCentsToByn(currentCacCents),
    },
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
 *   history?: object | null,
 *   curveFallback?: boolean,
 *   mode?: 'builder',
 * }} input `curveFallback` marks that a stale curve selector was ignored; it only changes an explanatory note.
 * @returns {object} Screen model shared by the page and `/api/v1/scenarios`.
 */
export function buildScenariosScreen({
  scenario,
  list = { rows: [], page: 1, total: 0, hasMore: false },
  query = {},
  anchor = null,
  channels = [],
  history = null,
  curveFallback = false,
  mode = 'builder',
}) {
  const baselineCents = optimizableBaselineCents(scenario.channels);
  const budgetCents = BigInt(scenario.totals.planned.spendCents);
  const mappedChannels = scenario.channels.map(mapScenarioChannel);
  const selected = new Set(query.channelIds ?? scenario.channels.map((channel) => channel.channelId));
  const historyWindow = history ?? scenarioHistory(anchor);

  const dimension = channels.length > 0
    ? channels
    : scenario.channels.map((channel) => ({
        id: channel.channelId,
        code: channel.channelCode,
        name: channel.channelName,
      }));

  const requestedCurve = query.curveChannelId === null || query.curveChannelId === undefined
    ? null
    : String(query.curveChannelId);
  const curveChannel =
    scenario.channels.find((channel) => channel.channelId === requestedCurve) ??
    scenario.channels.find((channel) => channel.model === 'saturation') ??
    scenario.channels[0] ??
    null;

  const controls = {
    budgetPeriod: 'week',
    budgetInput: centsToInput(budgetCents),
    budgetValue: centsToApi(budgetCents),
    budgetLabel: formatCentsToByn(budgetCents),
    curveChannelId: curveChannel?.channelId ?? null,
    curveChannelName: curveChannel?.channelName ?? null,
    curveNote: curveFallback
      ? 'Выбранный канал кривой не входит в набор — показываем первую доступную кривую.'
      : null,
    channels: dimension.map((channel) => ({
      value: channel.id,
      label: channel.name,
      code: channel.code,
      selected: selected.has(channel.id),
    })),
  };
  controls.selectedChannels = controls.channels.filter((channel) => channel.selected);
  // The service rejects a curve channel outside the selected set; limiting the select to the same set makes that
  // validation unreachable from the form instead of turning a stale option into a 400.
  controls.curveOptions = controls.selectedChannels;
  controls.presets = budgetPresets({
    baselineCents,
    budgetCents,
    capCents: baselineCents * BigInt(METRICS_CONFIG.scenarios.maxBudgetMultiplier),
    channelIds: controls.selectedChannels.map((channel) => channel.value),
    curveChannelId: controls.curveChannelId,
  });

  return {
    page: 'scenarios',
    mode,
    budgetPeriod: 'week',
    weeksPerYear: DECISIONS_CONFIG.weeksPerYear,
    anchor,
    history: historyWindow,
    budget: buildBudget({
      baselineCents,
      budgetCents,
      optimizableCount: optimizableChannelCount(scenario.channels),
    }),
    controls,
    channels: mappedChannels,
    totals: mapTotals(scenario),
    warnings: scenario.warnings ?? [],
    charts: buildScenarioCharts({
      channels: scenario.channels,
      history: historyWindow,
      curveChannelId: controls.curveChannelId,
    }),
    list: buildScenarioList(list, query),
    empty: list.total === 0,
    error: null,
  };
}

/**
 * Builder model for an empty stand: channels exist but no channel has 26 complete weeks with spend and customers,
 * so the service cannot fit a curve. The page renders this state instead of a 400 because the person did not send a
 * malformed request; there is simply nothing to plan yet.
 *
 * The saved-scenario list is still shown: old snapshots stay readable after the fact data changes.
 *
 * @param {{
 *   anchor?: string | null,
 *   list?: { rows: object[], page: number, total: number, hasMore: boolean },
 *   channels?: object[],
 *   error?: string | null,
 * }} input
 * @returns {object} Builder-shaped model with `unavailable: true`.
 */
export function buildScenariosUnavailableScreen({
  anchor = null,
  list = { rows: [], page: 1, total: 0, hasMore: false },
  channels = [],
  error = null,
}) {
  return {
    page: 'scenarios',
    mode: 'builder',
    budgetPeriod: 'week',
    weeksPerYear: DECISIONS_CONFIG.weeksPerYear,
    anchor,
    history: scenarioHistory(anchor),
    budget: null,
    controls: {
      budgetPeriod: 'week',
      budgetInput: '',
      budgetValue: null,
      budgetLabel: '—',
      curveChannelId: null,
      curveChannelName: null,
      curveNote: null,
      channels: channels.map((channel) => ({
        value: channel.id,
        label: channel.name,
        code: channel.code,
        selected: false,
      })),
      selectedChannels: [],
      curveOptions: [],
      presets: [],
    },
    channels: [],
    totals: null,
    warnings: [],
    charts: null,
    list: buildScenarioList(list),
    empty: true,
    unavailable: true,
    error:
      error ??
      'Кривая насыщения не построена: ни один выбранный канал не набрал восьми недель одновременно с расходом и ' +
        'новыми клиентами.',
  };
}

/**
 * Builder model for a rejected calculation: the query or the service refused the budget, the channel set or the
 * baseline. The page renders the parameter form with the entered values plus a styled error card, so a person can
 * correct the input instead of reading a bare-text 400.
 *
 * The model carries no budget or chart block: inventing a zeroed one would show numbers the server did not compute.
 *
 * @param {{
 *   anchor?: string | null,
 *   list?: { rows: object[], page: number, total: number, hasMore: boolean },
 *   channels?: object[],
 *   query?: object,
 *   baselineScenario?: object | null,
 *   error?: string,
 * }} input `baselineScenario` is a successful default-budget build used only to derive the feasible min/cap bounds.
 * @returns {object} Builder-shaped model with `builderError: true`.
 */
export function buildScenariosErrorScreen({
  anchor = null,
  list = { rows: [], page: 1, total: 0, hasMore: false },
  channels = [],
  query = {},
  baselineScenario = null,
  error = 'Не удалось рассчитать сценарий с этими параметрами.',
}) {
  const requestedIds = query.channelIds ?? null;
  const selected = new Set(
    (requestedIds ?? channels.map((channel) => channel.id)).map((id) => String(id)),
  );
  const dimension = channels.map((channel) => ({
    value: channel.id,
    label: channel.name,
    code: channel.code,
    selected: selected.has(String(channel.id)),
  }));
  const requestedCurve = query.curveChannelId === null || query.curveChannelId === undefined
    ? null
    : String(query.curveChannelId);
  const rawBudget = query.budgetByn === null || query.budgetByn === undefined
    ? ''
    : String(query.budgetByn).trim();
  const enteredCents = rawBudget === ''
    ? null
    : (() => {
        try {
          return parseBynToCents(rawBudget);
        } catch {
          return null;
        }
      })();

  const baselineCents = baselineScenario ? optimizableBaselineCents(baselineScenario.channels) : 0n;
  const optimizableCount = baselineScenario
    ? optimizableChannelCount(baselineScenario.channels)
    : 0;
  const minCents = BigInt(Math.max(1, optimizableCount));
  const capCents = baselineScenario
    ? baselineCents * BigInt(METRICS_CONFIG.scenarios.maxBudgetMultiplier)
    : 0n;
  // The error form must show the value it rejected: a browser would clamp a range at its default 100 when `max` is
  // absent, and an empty/`abc` value has no numeric bound at all. The max therefore covers both the cap and the
  // entered amount; a non-numeric entry becomes a text input below so it stays visible and editable.
  const maxCents = [enteredCents ?? 0n, capCents, minCents].reduce(
    (largest, value) => (value > largest ? value : largest),
    0n,
  );
  const numericEntry = /^\d+(?:[.,]\d+)?$/.test(rawBudget);

  return {
    page: 'scenarios',
    mode: 'builder',
    budgetPeriod: 'week',
    weeksPerYear: DECISIONS_CONFIG.weeksPerYear,
    anchor,
    history: scenarioHistory(anchor),
    budget: null,
    controls: {
      budgetPeriod: 'week',
      budgetInput: numericEntry ? rawBudget.replace(',', '.') : '',
      budgetEntry: rawBudget,
      budgetInputType: numericEntry ? 'number' : 'text',
      budgetMinInput: centsToInput(minCents),
      budgetMinLabel: formatCentsToByn(minCents),
      budgetMaxInput: centsToInput(maxCents),
      budgetMaxLabel: formatCentsToByn(maxCents),
      budgetValue: null,
      budgetLabel: '—',
      curveChannelId: requestedCurve,
      curveChannelName: null,
      curveNote: null,
      channels: dimension,
      selectedChannels: dimension.filter((channel) => channel.selected),
      curveOptions: dimension.filter((channel) => channel.selected),
      presets: [],
    },
    channels: [],
    totals: null,
    warnings: [],
    charts: null,
    list: buildScenarioList(list, query),
    empty: list.total === 0,
    builderError: true,
    error,
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
    weeksPerYear: DECISIONS_CONFIG.weeksPerYear,
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
  const baselineCents = optimizableBaselineCents(result.channels);
  const budgetCents = BigInt(scenario.params.budgetCents);
  const budget = buildBudget({
    baselineCents,
    budgetCents,
    optimizableCount: optimizableChannelCount(result.channels),
  });
  const history = {
    weeks: scenario.params.history.weeks,
    from: scenario.params.history.from,
    to: scenario.params.history.to,
    label: `${scenario.params.history.weeks} недель`,
  };

  return {
    ...base,
    history,
    budget,
    controls: null,
    channels: result.channels.map(mapScenarioChannel),
    totals: mapTotals(result),
    warnings: result.warnings ?? [],
    charts: buildScenarioCharts({
      channels: result.channels,
      history,
      // A saved snapshot may have been planned on a subset; the first fitted curve is the stable default for a page
      // that has no query state and must not refit anything.
      curveChannelId: null,
    }),
    list: null,
    empty: false,
    repeatHref: `/app/scenarios?${buildQueryString({}, {
      budgetByn: budget.weeklyInput,
      channelIds: result.channels.map((channel) => channel.channelId),
    })}`,
  };
}
