import { METRICS_CONFIG } from '../../config/metrics.js';
import { formatDateRu } from '../../lib/dates.js';
import { buildQueryString } from '../../lib/query.js';
import { CHANNEL_SORT_FIELDS } from '../../lib/sort-rows.js';
import {
  buildCacChart,
  buildCacLtvScatter,
  buildChannelSpendChart,
  buildRomiChart,
  buildSpendRevenueChart,
  daysLabel,
  weeksLabel,
} from './chart-series.js';

/**
 * Screen models: the one place where a service result becomes the object the page and the API both receive.
 *
 * The EJS shell renders no metric values; React is the only renderer. Sharing the model between `data-props` and
 * `/api/v1/*` means the SSR test and the API test compare the same object, and a field added here cannot appear on
 * one path and not the other.
 */

/**
 * Builds the dashboard screen model.
 *
 * @param {{
 *   summary: Awaited<ReturnType<import('./dashboard.service.js').createDashboardService['getDashboardSummary']>>,
 *   channelIds?: string[] | null,
 * }} input `channelIds` is the validated filter, or null for every channel.
 * @returns {{
 *   page: 'dashboard',
 *   period: { from: string, to: string, days: number, anchor: string, label: string },
 *   filter: { channelIds: string[] | null, selected: string[], active: boolean },
 *   channelOptions: Array<{ value: string, label: string, selected: boolean }>,
 *   channels: object[],
 *   kpis: object,
 *   verdict: object,
 *   charts: object,
 *   labels: { period: string, weeks: string, anchor: string, filter: string },
 * }}
 */
export function buildDashboardScreen({ summary, channelIds = null }) {
  const periods = daysLabel(summary.period.days);
  const weeks = weeksLabel(summary.weeklySeries.length);
  const selected = channelIds ?? [];
  const selectedSet = new Set(selected);
  const { kpis } = summary;

  const filterLabel =
    selected.length === 0
      ? 'Все каналы'
      : `Выбрано ${selected.length} из ${summary.availableChannels.length}`;

  return {
    page: 'dashboard',
    period: { ...summary.period, label: periods },
    filter: {
      channelIds: channelIds === null ? null : [...selected],
      selected: [...selected],
      active: selected.length > 0,
    },
    channelOptions: summary.availableChannels.map((channel) => ({
      value: channel.channelId,
      label: channel.name,
      selected: selectedSet.has(channel.channelId),
    })),
    // The selected health rows are kept for the per-channel views of the dashboard (T2); the full dimension above
    // keeps the multi-select usable after a filter hides some options.
    channels: summary.channels,
    kpis: {
      ...kpis,
      items: [        {
          id: 'spend',
          label: 'Расход',
          value: kpis.spendLabel,
          unit: 'BYN',
          hint: `За ${periods}`,
          tone: null,
        },
        {
          id: 'new-customers',
          label: 'Новые клиенты',
          value: kpis.newCustomersLabel,
          unit: null,
          hint: `За ${periods}`,
          tone: null,
        },
        {
          id: 'cac',
          label: 'CAC',
          value: kpis.cacLabel,
          unit: kpis.cacCents === null ? null : 'BYN',
          hint: 'Стоимость нового клиента',
          tone: null,
        },
        {
          id: 'romi',
          label: 'ROMI',
          value: kpis.romiLabel,
          unit: null,
          hint: 'Возврат на маркетинг',
          // A negative ROMI is a loss, not a neutral number; the tile is the only KPI that can carry a "bad" tone
          // without duplicating the verdict badge.
          tone: kpis.romiPct !== null && kpis.romiPct < 0 ? 'bad' : null,
        },
      ],
    },
    verdict: { ...summary.verdict },
    charts: {
      cac: buildCacChart({ weeklySeries: summary.weeklySeries, channelIds }),
      romi: buildRomiChart({ weeklySeries: summary.weeklySeries, channelIds }),
      spendRevenue: buildSpendRevenueChart({ weeklySeries: summary.weeklySeries, channelIds }),
      // The two per-channel charts read `health.rows` from the same summary, so the filter, the KPI and these cards
      // cannot disagree and the dashboard adds no query.
      channelSpend: buildChannelSpendChart({ channels: summary.channels, channelIds }),
      cacLtv: buildCacLtvScatter({ channels: summary.channels }),
    },
    labels: {
      period: periods,
      weeks,
      anchor: summary.period.anchor,
      filter: filterLabel,
    },
  };
}

/**
 * Builds the topbar period control for a page that has a daily window.
 *
 * `preserve` keeps every other query key as a hidden input, so changing the period does not silently drop the
 * channel filter or a sort order. Arrays are emitted as repeated inputs, which is exactly how `<select multiple>`
 * submits them. `from`/`to` are deliberately dropped: the topbar submits `days`, and the schema rejects an explicit
 * range together with `days`, so replaying an old range would make the generated form return a 400.
 * A page without a daily window (cohorts) passes `period: null` and renders no select at all.
 *
 * A request with an explicit `from`/`to` range has no matching option in the days select. Pretending it is the
 * default 30 days would mislabel a bookmarked October range; the control then reports the real range and offers one
 * link back to the default window instead of a select with a false value.
 *
 * @param {{
 *   query?: Record<string, unknown>,
 *   period?: { from: string, to: string, days: number } | null,
 * }} [input] Validated query object and, when available, the resolved period.
 * @returns {{
 *   days: number,
 *   options: Array<{ value: number, label: string, selected: boolean }>,
 *   preserve: Array<{ name: string, value: string }>,
 *   customRange: { from: string | null, to: string | null, label: string, href: string } | null,
 * }}
 */
export function buildPeriodControl({ query = {}, period = null } = {}) {
  const days = Number(query.days ?? METRICS_CONFIG.periods.defaultDays);

  const preserve = [];
  for (const [name, value] of Object.entries(query)) {
    // `days` is the value this form sets; `from`/`to` conflict with it. Everything else is replayed.
    if (name === 'days' || name === 'from' || name === 'to') continue;
    if (Array.isArray(value)) {
      for (const item of value) preserve.push({ name, value: String(item) });
    } else if (value !== undefined && value !== null && value !== '') {
      preserve.push({ name, value: String(value) });
    }
  }

  const explicitRange = (query.days === undefined || query.days === null || query.days === '') && Boolean(
    period?.from || period?.to || query.from || query.to,
  );
  const from = period?.from ?? (typeof query.from === 'string' ? query.from : null);
  const to = period?.to ?? (typeof query.to === 'string' ? query.to : null);
  const customRange = explicitRange && from !== null && to !== null
    ? {
        from,
        to,
        label: `${formatDateRu(from)} — ${formatDateRu(to)}`,
        href: (() => {
          const queryString = buildQueryString(query, {
            days: METRICS_CONFIG.periods.defaultDays,
            from: null,
            to: null,
          });
          return queryString === '' ? '?' : `?${queryString}`;
        })(),
      }
    : null;

  return {
    days,
    options: METRICS_CONFIG.periods.options.map((option) => ({
      value: option,
      label: daysLabel(option),
      selected: option === days,
    })),
    preserve,
    customRange,
  };
}

/**
 * Builds the channel table screen model from the channel list service result.
 *
 * The service owns the numbers and the order; this builder adds only presentation metadata: the period label, the
 * sort links (with `aria-sort` state) and the filter description. The API returns this exact object, so a sort link
 * or a label cannot exist on the page and be missing from JSON.
 *
 * @param {{ list: Awaited<ReturnType<import('./channel-list.service.js').createChannelListService['getChannelList']>>,
 *   query?: Record<string, unknown> }} input `query` is the validated page query.
 * @returns {object} Screen model used by `data-props` and `/api/v1/channels`.
 */
export function buildChannelsScreen({ list, query = {} }) {
  const sort = typeof query.sort === 'string' ? query.sort : 'rank';
  const dir = query.dir === 'asc' || query.dir === 'desc' ? query.dir : CHANNEL_SORT_FIELDS[sort].defaultDir;
  const weightsCustom = query.weightsCustom === true;
  const current = buildChannelsQueryState({ query, filters: list.filters, sort, dir, weights: list.weights, weightsCustom });

  const withoutFilters = { ...current };
  delete withoutFilters.status;
  delete withoutFilters.kind;
  const resetQuery = buildQueryString(withoutFilters);

  const sortLinks = Object.entries(CHANNEL_SORT_FIELDS).map(([field, meta]) => {
    const active = field === sort;
    const nextDir = active ? (dir === 'asc' ? 'desc' : 'asc') : meta.defaultDir;
    const queryString = buildQueryString(current, { sort: field, dir: nextDir });
    return {
      field,
      label: meta.label,
      href: queryString === '' ? '/app/channels' : `/app/channels?${queryString}`,
      active,
      dir: active ? dir : null,
      ariaSort: active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none',
    };
  });

  return {
    page: 'channels',
    period: { ...list.period, label: list.labels.period },
    filters: {
      ...list.filters,
      active: list.filters.status !== 'all' || list.filters.kind !== 'all',
      label: list.labels.filter,
      resetHref: resetQuery === '' ? '/app/channels' : `/app/channels?${resetQuery}`,
    },
    weights: list.weights,
    weightsBasisPoints: list.weightsBasisPoints,
    rows: list.rows,
    blended: list.blended,
    excluded: list.excluded,
    sparklines: list.sparklines,
    chart: list.chart,
    labels: list.labels,
    sortLinks,
  };
}

/**
 * Page-only hidden fields and field models for the two GET forms of the channel screen.
 *
 * The filter form must not silently reset the period, the sort or custom weights; the weights form must not reset
 * the M2 filters. Both are built from the same normalised query, so the two forms cannot disagree.
 *
 * @param {{
 *   query?: Record<string, unknown>,
 *   filters: { status: string, kind: string },
 *   sort?: string,
 *   dir?: string,
 *   weights: Record<string, number>,
 *   weightsCustom?: boolean,
 * }} input
 * @returns {{
 *   action: string,
 *   hiddenFields: Array<{ name: string, value: string }>,
 *   resetHref: string,
 * }}
 */
export function buildChannelsFilterControl({ query = {}, filters, sort = 'rank', dir, weights, weightsCustom = false }) {
  const current = buildChannelsQueryState({ query, filters, sort, dir, weights, weightsCustom });
  const hidden = [];
  addPeriodFields(hidden, query);
  if (current.sort !== undefined) hidden.push({ name: 'sort', value: current.sort });
  if (current.dir !== undefined) hidden.push({ name: 'dir', value: current.dir });
  addWeightFields(hidden, current);

  const withoutFilters = { ...current };
  delete withoutFilters.status;
  delete withoutFilters.kind;
  const resetQuery = buildQueryString(withoutFilters);

  return {
    action: '/app/channels',
    hiddenFields: hidden,
    resetHref: resetQuery === '' ? '/app/channels' : `/app/channels?${resetQuery}`,
  };
}

/**
 * Page-only model for the weights form. Values are percentages (0–100) because that is what a person types; the
 * service converts them back to fractions through `parseWeightParams`.
 *
 * @param {{
 *   query?: Record<string, unknown>,
 *   filters: { status: string, kind: string },
 *   sort?: string,
 *   dir?: string,
 *   weights: Record<string, number>,
 * }} input
 * @returns {{
 *   action: string,
 *   hiddenFields: Array<{ name: string, value: string }>,
 *   fields: Array<{ name: string, label: string, value: string, hint: string }>,
 *   resetHref: string,
 * }}
 */
export function buildChannelsWeightsControl({ query = {}, filters, sort = 'rank', dir, weights }) {
  const current = buildChannelsQueryState({ query, filters, sort, dir, weights, weightsCustom: true });

  const hidden = [];
  addPeriodFields(hidden, query);
  if (filters.status !== 'all') hidden.push({ name: 'status', value: filters.status });
  if (filters.kind !== 'all') hidden.push({ name: 'kind', value: filters.kind });
  if (current.sort !== undefined) hidden.push({ name: 'sort', value: current.sort });
  if (current.dir !== undefined) hidden.push({ name: 'dir', value: current.dir });

  const withoutWeights = { ...current };
  for (const name of ['wCac', 'wRomi', 'wLtvCac', 'wNewCustomers']) delete withoutWeights[name];
  const resetQuery = buildQueryString(withoutWeights);

  const raw = rawWeightParams(query);
  const display = {
    wCac: raw?.wCac ?? percentOf(weights.cac),
    wRomi: raw?.wRomi ?? percentOf(weights.romi),
    wLtvCac: raw?.wLtvCac ?? percentOf(weights.ltvCac),
    wNewCustomers: raw?.wNewCustomers ?? percentOf(weights.newCustomers),
  };

  return {
    action: '/app/channels',
    hiddenFields: hidden,
    fields: [
      { name: 'wCac', label: 'CAC', value: display.wCac, hint: 'Дешевле — больше баллов' },
      { name: 'wRomi', label: 'ROMI', value: display.wRomi, hint: 'Возврат на маркетинг' },
      { name: 'wLtvCac', label: 'LTV:CAC', value: display.wLtvCac, hint: 'Окупаемость клиента' },
      {
        name: 'wNewCustomers',
        label: 'Новые клиенты',
        value: display.wNewCustomers,
        hint: 'Объём привлечения',
      },
    ],
    resetHref: resetQuery === '' ? '/app/channels' : `/app/channels?${resetQuery}`,
  };
}

/**
 * Normalises the URL state of the channel screen into the keys the sort links and the forms replay.
 *
 * Defaults are omitted, so an untouched page keeps a short URL, while every non-default filter survives a sort or a
 * weight change. `channelIds` is not part of this screen, but `buildQueryString` still supports arrays for the
 * filters of other use cases.
 *
 * @param {{
 *   query?: Record<string, unknown>,
 *   filters: { status: string, kind: string },
 *   sort: string,
 *   dir?: string,
 *   weights: Record<string, number>,
 *   weightsCustom?: boolean,
 * }} input
 * @returns {Record<string, unknown>}
 */
export function buildChannelsQueryState({ query = {}, filters, sort, dir, weights, weightsCustom = false }) {
  const state = {};
  addPeriodFields(state, query, true);
  if (filters.status !== 'all') state.status = filters.status;
  if (filters.kind !== 'all') state.kind = filters.kind;
  const field = CHANNEL_SORT_FIELDS[sort];
  if (sort !== 'rank') state.sort = sort;
  const direction = dir ?? field.defaultDir;
  // Replay `dir` whenever the order is not the untouched default: `sort=cac` + `dir=asc` must survive a status
  // change even though `asc` happens to be CAC's default today.
  if (sort !== 'rank' || direction !== field.defaultDir) state.dir = direction;
  if (weightsCustom) {
    const raw = rawWeightParams(query);
    state.wCac = raw?.wCac ?? percentOf(weights.cac);
    state.wRomi = raw?.wRomi ?? percentOf(weights.romi);
    state.wLtvCac = raw?.wLtvCac ?? percentOf(weights.ltvCac);
    state.wNewCustomers = raw?.wNewCustomers ?? percentOf(weights.newCustomers);
  }
  return state;
}

/**
 * Replays the raw percentage strings a validated query used, so `33.3` does not become `33` after a filter submit.
 * Returns null when the query is not a complete four-parameter set; the normalised weights are the fallback.
 *
 * @param {Record<string, unknown>} query
 * @returns {Record<string, string> | null}
 */
function rawWeightParams(query) {
  const names = ['wCac', 'wRomi', 'wLtvCac', 'wNewCustomers'];
  const values = names.map((name) => query?.[name]);
  if (!values.every((value) => typeof value === 'string' && value.trim() !== '')) return null;
  return Object.fromEntries(names.map((name, index) => [name, values[index].trim()]));
}

/**
 * @param {Array<{ name: string, value: string }> | Record<string, unknown>} target
 * @param {Record<string, unknown>} query
 * @param {boolean} [asObject] Push into an object instead of an array.
 * @returns {void}
 */
function addPeriodFields(target, query, asObject = false) {
  /** @param {string} name @param {unknown} value */
  const put = (name, value) => {
    if (asObject) target[name] = value;
    else if (value !== undefined && value !== null && value !== '') target.push({ name, value: String(value) });
  };

  if (query.days !== undefined && query.days !== null && query.days !== '') {
    put('days', query.days);
    return;
  }
  if (query.from !== undefined && query.from !== null && query.from !== '') put('from', query.from);
  if (query.to !== undefined && query.to !== null && query.to !== '') put('to', query.to);
}

/**
 * @param {Array<{ name: string, value: string }>} fields
 * @param {Record<string, unknown>} state
 * @returns {void}
 */
function addWeightFields(fields, state) {
  for (const name of ['wCac', 'wRomi', 'wLtvCac', 'wNewCustomers']) {
    if (state[name] !== undefined) fields.push({ name, value: String(state[name]) });
  }
}

/**
 * @param {number} value Weight fraction in `[0, 1]`.
 * @returns {string} Percent without trailing zeros, up to three decimals (the basis-point precision).
 */
function percentOf(value) {
  return String(Number((value * 100).toFixed(3)));
}

/**
 * Page-only control model for the dashboard channel filter. It is deliberately not part of the screen model: the
 * API returns data, while a form action and a reset link are presentation of the same HTML frame.
 *
 * The hidden period fields mirror what the request actually used, exactly like `buildPeriodControl`: a validated
 * `days` request replays `days`, while an explicit range replays `from`/`to` and omits `days`. Emitting the resolved
 * `period.days` would produce a 31-day hidden value that the schema rejects on the form's own submit.
 *
 * `resetHref` keeps the period and drops only the channel selection. `active` and `selectedCount` come from the
 * validated `channelIds`, not from the option list, so a filter with an id that is not in the dimension still shows
 * «Сбросить» and agrees with the verdict card.
 *
 * @param {{
 *   options?: Array<{ value: string, label: string, selected: boolean }>,
 *   query?: Record<string, unknown>,
 * }} [input] `options` come from the screen model's full `channelOptions`; `query` is the validated query object.
 * @returns {{
 *   action: string,
 *   size: number,
 *   active: boolean,
 *   selectedCount: number,
 *   total: number,
 *   options: Array<{ value: string, label: string, selected: boolean }>,
 *   periodFields: Array<{ name: string, value: string }>,
 *   resetHref: string,
 * }}
 */
export function buildChannelFilterControl({ options = [], query = {} } = {}) {
  const selectedIds = Array.isArray(query.channelIds) ? query.channelIds : [];

  /** @type {Array<{ name: string, value: string }>} */
  const periodFields = [];
  if (query.days !== undefined && query.days !== null) {
    periodFields.push({ name: 'days', value: String(query.days) });
  } else {
    // Replay only the bounds the request actually used; `resolvePeriod` may fill the missing one on the next request.
    if (query.from !== undefined && query.from !== null && query.from !== '') {
      periodFields.push({ name: 'from', value: String(query.from) });
    }
    if (query.to !== undefined && query.to !== null && query.to !== '') {
      periodFields.push({ name: 'to', value: String(query.to) });
    }
  }

  const periodQuery = Object.fromEntries(periodFields.map((field) => [field.name, field.value]));
  const queryString = buildQueryString(periodQuery, { channelIds: null });

  return {
    action: '/app/dashboard',
    // A multi-select needs a visible box; cap it so eight channels do not push the charts below the fold.
    size: Math.min(Math.max(options.length, 2), 6),
    active: selectedIds.length > 0,
    selectedCount: selectedIds.length,
    total: options.length,
    options,
    periodFields,
    resetHref: queryString === '' ? '/app/dashboard' : `/app/dashboard?${queryString}`,
  };
}
