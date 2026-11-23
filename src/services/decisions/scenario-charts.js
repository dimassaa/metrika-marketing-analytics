import { formatCentsToByn, formatRatio, formatSignedPercent } from '../../lib/format.js';
import { roundNumber } from '../../lib/metrics-math.js';
import { predictConversions } from './saturation.service.js';

/**
 * Chart models for the scenario builder and saved detail.
 *
 * Every number here is already decided by the scenario service: `current` is the four-week average, `planned` is
 * the KKT allocation and `forecast.customers` is `predictConversions`. The builders only turn those numbers into a
 * chart series, a caption that states the conclusion and a duplicate table; they never refit a curve or re-derive a
 * metric. Kopecks cross into Recharts as safe integers, exactly like the M4 chart builders, because the tooltip and
 * the table format the same value through `src/lib/format.js`.
 */

/** Fixed point count of the analytic saturation curve; enough to draw a smooth line, small enough for the DOM. */
const CURVE_STEPS = 40;

/**
 * @param {string | null | undefined} cents Kopeck string from the scenario snapshot.
 * @param {string} label Field name for the error.
 * @returns {number | null} Safe integer for a chart, or null when the value is absent.
 * @throws {TypeError} When a present value is not an exact integer kopeck string.
 */
function chartCents(cents, label) {
  if (cents === null || cents === undefined) return null;
  if (typeof cents === 'string' && !/^-?\d+$/.test(cents)) {
    throw new TypeError(`${label} must be an integer kopeck string, got ${JSON.stringify(cents)}`);
  }
  const value = Number(cents);
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be an integer kopeck string, got ${JSON.stringify(cents)}`);
  }
  return value;
}

/**
 * @param {number | null | undefined} value Fractional customer count.
 * @returns {string} One decimal with a comma, or `—`.
 */
function customersLabel(value) {
  if (value === null || value === undefined) return '—';
  return formatRatio(value, { decimals: 1 });
}

/**
 * Signed customer count for increment bars: `+12,3`, `−4,0`, `0,0`.
 * @param {number | null | undefined} value
 * @returns {string} Ready-to-display signed count, or `—`.
 */
export function signedCustomersLabel(value) {
  if (value === null || value === undefined) return '—';
  const rendered = customersLabel(value);
  return value > 0 ? `+${rendered}` : rendered;
}

/**
 * @param {number} count
 * @returns {string} `1 канал`, `2 канала`, `5 каналов`.
 */
function channelsLabel(count) {
  const tail = count % 100;
  const last = count % 10;
  if (tail >= 11 && tail <= 14) return `${count} каналов`;
  if (last === 1) return `${count} канал`;
  if (last >= 2 && last <= 4) return `${count} канала`;
  return `${count} каналов`;
}

/**
 * @param {string} from `YYYY-MM-DD`.
 * @param {string} to `YYYY-MM-DD`.
 * @returns {string} `01.09–22.11.2026` inside one year, a full range across years.
 */
function rangeLabel(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string' || from === '' || to === '') return '';
  const [fromYear, fromMonth, fromDay] = from.split('-');
  const [, toMonth, toDay] = to.split('-');
  return from.slice(0, 4) === to.slice(0, 4)
    ? `${fromDay}.${fromMonth}–${toDay}.${toMonth}.${fromYear}`
    : `${formatDateParts(from)}—${formatDateParts(to)}`;
}

/** @param {string} value `YYYY-MM-DD`. @returns {string} `DD.MM.YYYY`. */
function formatDateParts(value) {
  const [year, month, day] = value.split('-');
  return `${day}.${month}.${year}`;
}

/**
 * @param {{ weeks?: number, from?: string, to?: string } | null | undefined} history
 * @returns {string} The history range followed by its week count.
 */
function historyCaption(history) {
  const weeks = history?.weeks;
  const range = rangeLabel(history?.from, history?.to);
  const weekText = Number.isInteger(weeks) ? `${weeks} недель` : 'история';
  return range === '' ? weekText : `${range} · ${weekText}`;
}

/**
 * @param {number} current
 * @param {number} compare
 * @returns {string} Signed percent change, or a dash when the current plan is zero.
 */
function changeLabel(current, compare) {
  if (!Number.isFinite(current) || current === 0) return '—';
  return formatSignedPercent(((compare - current) * 100) / current);
}

/**
 * Grouped spend bars: the four-week average next to the planned weekly allocation.
 *
 * Channels without a fitted curve keep a row with a zero planned bar and a dash in the table: the picture must show
 * that they exist but are outside the plan, not hide them and let the sum look complete.
 *
 * @param {{ channels: object[], history?: object }} input Scenario channel rows from the service result.
 * @returns {object} Chart contract consumed by `ChartFrame` + `ComparisonBars`.
 */
export function buildSpendAllocationChart({ channels, history = null }) {
  const series = channels.map((channel) => ({
    channelId: channel.channelId,
    name: channel.channelName,
    model: channel.model,
    current: chartCents(channel.current?.spendCents, 'current spendCents') ?? 0,
    compare: channel.planned ? chartCents(channel.planned.spendCents, 'planned spendCents') ?? 0 : 0,
    plannedMissing: !channel.planned,
  }));

  const totalCurrent = series.reduce((sum, row) => sum + row.current, 0);
  const totalPlanned = series.reduce((sum, row) => sum + row.compare, 0);
  // The percent change compares like with like: a channel outside the plan has no plan value, so its current spend
  // is not part of the baseline the plan is measured against.
  const comparableCurrent = series
    .filter((row) => !row.plannedMissing)
    .reduce((sum, row) => sum + row.current, 0);
  const excluded = series.filter((row) => row.plannedMissing).length;
  const hasData = totalCurrent > 0 || totalPlanned > 0;
  const change = changeLabel(comparableCurrent, totalPlanned);
  const conclusion = hasData
    ? `план ${formatCentsToByn(totalPlanned)} BYN (${change} к текущему)`
    : 'нет измеренного расхода';

  return {
    id: 'scenario-spend',
    title: hasData ? `Расход по каналам: ${conclusion}` : 'Расход по каналам: нет данных',
    caption:
      `${historyCaption(history)} · текущее — среднее за 4 полные недели · ` +
      `${channelsLabel(series.length)}, без кривой — ${excluded}`,
    ariaLabel:
      `Расход по каналам сценария: текущий ${formatCentsToByn(totalCurrent)} BYN, ` +
      `план ${formatCentsToByn(totalPlanned)} BYN, ${change}`,
    unit: 'BYN',
    compareKey: 'planned',
    compareLabel: 'План',
    hasData,
    series,
    table: {
      columns: [
        { key: 'channel', label: 'Канал', numeric: false },
        { key: 'current', label: 'Сейчас, BYN', numeric: true },
        { key: 'planned', label: 'План, BYN', numeric: true },
      ],
      rows: series.length === 0
        ? [{ key: 'empty', cells: { channel: '—', current: '—', planned: '—' } }]
        : series.map((row) => ({
            key: row.channelId,
            cells: {
              channel: row.name,
              current: formatCentsToByn(row.current),
              planned: row.plannedMissing ? '—' : formatCentsToByn(row.compare),
            },
          })),
    },
  };
}

/**
 * Grouped customer bars: the observed four-week average next to the forecast of the planned allocation.
 *
 * @param {{ channels: object[], history?: object }} input
 * @returns {object}
 */
export function buildCustomersForecastChart({ channels, history = null }) {
  const series = channels.map((channel) => ({
    channelId: channel.channelId,
    name: channel.channelName,
    current: channel.current?.customers ?? 0,
    compare: channel.forecast?.customers ?? 0,
    plannedMissing: !channel.forecast,
  }));

  const totalCurrent = series.reduce((sum, row) => sum + row.current, 0);
  const totalForecast = series.reduce((sum, row) => sum + row.compare, 0);
  // No curve means no forecast, so an excluded channel's current customers cannot be compared with a plan it does
  // not have. The change uses the optimizable subset; the table still shows every channel.
  const comparableCurrent = series
    .filter((row) => !row.plannedMissing)
    .reduce((sum, row) => sum + row.current, 0);
  const comparableForecast = series
    .filter((row) => !row.plannedMissing)
    .reduce((sum, row) => sum + row.compare, 0);
  const hasData = totalCurrent > 0 || totalForecast > 0;
  const change = changeLabel(comparableCurrent, comparableForecast);
  const conclusion = hasData
    ? `прогноз ${customersLabel(totalForecast)} клиентов за неделю (${change})`
    : 'нет измеренных клиентов';

  return {
    id: 'scenario-customers',
    title: hasData ? `Новые клиенты: ${conclusion}` : 'Новые клиенты: нет данных',
    caption:
      `${historyCaption(history)} · прогноз на неделю при текущем LTV; ` +
      'каналы без кривой не входят в план',
    ariaLabel:
      `Новые клиенты по каналам сценария: сейчас ${customersLabel(totalCurrent)}, ` +
      `прогноз ${customersLabel(totalForecast)}, ${change}`,
    unit: 'чел.',
    compareKey: 'forecast',
    compareLabel: 'Прогноз',
    hasData,
    series,
    table: {
      columns: [
        { key: 'channel', label: 'Канал', numeric: false },
        { key: 'current', label: 'Сейчас, клиентов', numeric: true },
        { key: 'forecast', label: 'Прогноз, клиентов', numeric: true },
      ],
      rows: series.length === 0
        ? [{ key: 'empty', cells: { channel: '—', current: '—', forecast: '—' } }]
        : series.map((row) => ({
            key: row.channelId,
            cells: {
              channel: row.name,
              current: customersLabel(row.current),
              forecast: row.plannedMissing ? '—' : customersLabel(row.compare),
            },
          })),
    },
  };
}

/**
 * @param {number} value
 * @returns {number} Rounded to two decimals; the chart is a drawing, the table states the precise one-decimal count.
 */
function chartCustomers(value) {
  return roundNumber(value, 2);
}

/**
 * Saturation curve for one channel: the analytic `q(b)` line and the observed weeks as points.
 *
 * A linear or empty channel has no curve to draw. Its table still lists the observed spends with a dash in the
 * curve column, so the reader sees what was measured and why the picture is absent. The x-axis is money, so observed
 * points are merged into the curve's x values to keep one continuous domain.
 *
 * @param {{
 *   channel: object,
 *   fit?: object | null,
 *   observed?: Array<{ spendCents: string, customers: number }> | null,
 *   history?: object,
 * }} input The channel row already carries `K`, `S`, `model` and `observed`; the extra arguments make the builder
 *   usable on its own in tests.
 * @returns {object}
 */
export function buildSaturationCurveChart({ channel, fit = null, observed = null, history = null }) {
  const curveFit = fit ?? channel;
  const points = observed ?? channel.observed ?? [];
  const name = channel.channelName;
  const hasCurve = curveFit?.model === 'saturation' && Number(curveFit.K) > 0 && Number(curveFit.S) > 0;

  const observedPoints = points.map((point) => ({
    spend: chartCents(point.spendCents, 'observed spendCents') ?? 0,
    customers: point.customers,
  }));

  const series = [];
  let maxCurveCustomers = 0;
  if (hasCurve) {
    const maxSpend = Math.max(
      ...observedPoints.map((point) => point.spend),
      chartCents(channel.planned?.spendCents, 'planned spendCents') ?? 0,
      1,
    );
    const grid = new Map();
    for (let index = 0; index <= CURVE_STEPS; index += 1) {
      const spend = Math.round((maxSpend * index) / CURVE_STEPS);
      grid.set(spend, chartCustomers(predictConversions(curveFit, spend / 100)));
    }
    for (const point of observedPoints) {
      if (!grid.has(point.spend)) {
        grid.set(point.spend, chartCustomers(predictConversions(curveFit, point.spend / 100)));
      }
    }

    const observedBySpend = new Map();
    for (const point of observedPoints) {
      // Two weeks with the exact same spend share one x value; the table still lists both weeks, and the point is
      // one of the measured values rather than an invented sum of the two.
      observedBySpend.set(point.spend, point.customers);
    }

    const spends = [...grid.keys()].sort((left, right) => left - right);
    for (const spend of spends) {
      const curve = grid.get(spend);
      maxCurveCustomers = Math.max(maxCurveCustomers, curve);
      series.push({
        spend,
        spendLabel: formatCentsToByn(spend),
        curve,
        observed: observedBySpend.get(spend) ?? null,
      });
    }
  }

  const hasData = hasCurve && observedPoints.length > 0 && maxCurveCustomers > 0;
  const r2Label = curveFit?.r2 === null || curveFit?.r2 === undefined
    ? 'R² не определён'
    : `R² ${formatRatio(curveFit.r2, { decimals: 2 })}`;
  const conclusion = hasData
    ? `потолок ${customersLabel(curveFit.K)} клиентов, ${r2Label}`
    : curveFit?.model === 'linear'
      ? 'линейная кривая — без оптимума'
      : 'нет данных для кривой';

  const tableRows = points.length === 0
    ? [{ key: 'empty', cells: { observation: '—', spend: '—', actual: '—', curve: '—' } }]
    : points.map((point, index) => ({
        key: `${point.spendCents}-${index}`,
        cells: {
          observation: `Наблюдение ${index + 1}`,
          spend: formatCentsToByn(point.spendCents),
          actual: customersLabel(point.customers),
          curve: hasCurve
            ? customersLabel(predictConversions(curveFit, (chartCents(point.spendCents, 'observed spendCents') ?? 0) / 100))
            : '—',
        },
      }));

  return {
    id: 'scenario-saturation',
    title: hasData ? `Кривая насыщения: ${name}, ${conclusion}` : `Кривая насыщения: ${name} — ${conclusion}`,
    caption:
      `${historyCaption(history)} · линия — q(b) = K × (1 − exp(−b / S)), точки — наблюдённые недели; ` +
      'ось X — недельный расход',
    ariaLabel: `Кривая насыщения ${name}: ${conclusion}`,
    unit: 'чел.',
    hasData,
    series,
    table: {
      columns: [
        { key: 'observation', label: 'Наблюдение', numeric: false },
        { key: 'spend', label: 'Расход, BYN', numeric: true },
        { key: 'actual', label: 'Клиенты (факт)', numeric: true },
        { key: 'curve', label: 'Кривая, клиенты', numeric: true },
      ],
      rows: tableRows,
    },
  };
}

/**
 * Horizontal bars of the weekly customer increment (`forecast − current`) per optimizable channel.
 *
 * This deliberately replaces the waterfall from the design reference: a waterfall needs intermediate cumulative
 * values that do not exist in this model, and a bar per channel states the contribution honestly. The sign is kept
 * in the caption, the tooltip and the table, so a channel that loses customers cannot read as growth.
 *
 * @param {{ channels: object[], history?: object }} input
 * @returns {object}
 */
export function buildIncrementChart({ channels, history = null }) {
  const series = channels
    .filter((channel) => channel.forecast && channel.model === 'saturation')
    .map((channel) => ({
      channelId: channel.channelId,
      name: channel.channelName,
      current: channel.current?.customers ?? 0,
      forecast: channel.forecast.customers ?? 0,
      delta: (channel.forecast.customers ?? 0) - (channel.current?.customers ?? 0),
    }))
    .sort((left, right) => right.delta - left.delta || left.name.localeCompare(right.name, 'ru'));

  const totalDelta = series.reduce((sum, row) => sum + row.delta, 0);
  const totalCurrent = series.reduce((sum, row) => sum + row.current, 0);
  const hasData = series.length > 0;
  const conclusion = hasData
    ? `${signedCustomersLabel(totalDelta)} клиентов за неделю`
    : 'нет каналов с планом';

  return {
    id: 'scenario-increment',
    title: hasData ? `Прирост клиентов: ${conclusion}` : 'Прирост клиентов: нет данных',
    caption:
      `${historyCaption(history)} · план минус текущее среднее; ` +
      `${channelsLabel(series.length)} с кривой, без оптимума — ${channels.length - series.length}`,
    ariaLabel: `Прирост клиентов по каналам: ${conclusion}`,
    unit: 'чел.',
    hasData,
    totalDelta,
    totalCurrent,
    series,
    table: {
      columns: [
        { key: 'channel', label: 'Канал', numeric: false },
        { key: 'current', label: 'Сейчас, клиентов', numeric: true },
        { key: 'forecast', label: 'План, клиентов', numeric: true },
        { key: 'delta', label: 'Прирост', numeric: true },
      ],
      rows: series.length === 0
        ? [{ key: 'empty', cells: { channel: '—', current: '—', forecast: '—', delta: '—' } }]
        : series.map((row) => ({
            key: row.channelId,
            cells: {
              channel: row.name,
              current: customersLabel(row.current),
              forecast: customersLabel(row.forecast),
              delta: signedCustomersLabel(row.delta),
            },
          })),
    },
  };
}

/**
 * Builds the four chart models from the same channel snapshot the table uses, so the picture and the table cannot
 * disagree. Kept in one place because the builder and the saved detail must render the same four charts.
 *
 * @param {{
 *   channels: object[],
 *   history?: object | null,
 *   curveChannelId?: string | null,
 * }} input `curveChannelId` is a presentation choice; the stored snapshot holds every channel's curve.
 * @returns {{ spend: object, customers: object, saturation: object, increment: object }}
 */
export function buildScenarioCharts({ channels, history = null, curveChannelId = null }) {
  const selected =
    channels.find((channel) => channel.channelId === curveChannelId) ??
    channels.find((channel) => channel.model === 'saturation') ??
    channels[0] ??
    null;

  return {
    spend: buildSpendAllocationChart({ channels, history }),
    customers: buildCustomersForecastChart({ channels, history }),
    saturation: selected
      ? buildSaturationCurveChart({ channel: selected, history })
      : {
          id: 'scenario-saturation',
          title: 'Кривая насыщения: канал не выбран',
          caption: 'Нет каналов в снимке',
          ariaLabel: 'Кривая насыщения: канал не выбран',
          unit: 'чел.',
          hasData: false,
          series: [],
          table: {
            columns: [
              { key: 'observation', label: 'Наблюдение', numeric: false },
              { key: 'spend', label: 'Расход, BYN', numeric: true },
              { key: 'actual', label: 'Клиенты (факт)', numeric: true },
              { key: 'curve', label: 'Кривая, клиенты', numeric: true },
            ],
            rows: [{ key: 'empty', cells: { observation: '—', spend: '—', actual: '—', curve: '—' } }],
          },
        },
    increment: buildIncrementChart({ channels, history }),
  };
}
