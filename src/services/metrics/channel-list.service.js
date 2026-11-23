import { METRICS_CONFIG } from '../../config/metrics.js';
import { toStackSegments } from '../../lib/contributions.js';
import { addDays, formatDateRu } from '../../lib/dates.js';
import { ValidationError } from '../../lib/errors.js';
import { CHANNEL_KIND_LABELS, RANKING_REASON_LABELS } from '../../lib/metrics-labels.js';
import { centsToApi } from '../../lib/metrics-math.js';
import { CHANNEL_SORT_FIELDS, sortChannelRows } from '../../lib/sort-rows.js';
import { buildRomiByChannelChart, channelsLabel, daysLabel, toSparklinePoints } from './chart-series.js';
import { computeCac } from './cac.service.js';
import { computeRanking } from './ranking.service.js';
import { resolveWeekRange } from './weekly-series.js';

/** Vocabulary of the M2 channel list; the codes stay English in the database and in the query string. */
const STATUSES = Object.freeze(['all', 'active', 'archived']);
const CHANNEL_KINDS = Object.freeze(['all', 'paid', 'owned', 'earned']);


/**
 * @param {string} status `all | active | archived`.
 * @param {string} kind `all | paid | owned | earned`.
 * @returns {string} Short Russian filter description for the labels of the screen model.
 */
function filterLabel(status, kind) {
  if (status === 'all' && kind === 'all') return 'Все каналы';
  const parts = [];
  if (status === 'active') parts.push('Активные');
  if (status === 'archived') parts.push('В архиве');
  if (kind !== 'all') parts.push(CHANNEL_KIND_LABELS[kind] ?? kind);
  return parts.join(' · ');
}

/**
 * @param {object} row Health row.
 * @param {object | undefined} meta M2 channel row with `kind` and `isActive`.
 * @param {object | null} ranked Ranking row for the same channel.
 * @param {{ reason: string, reasonLabel: string } | null} exclusion Ranking exclusion.
 * @returns {object} One table row with every ready-to-format field.
 */
function decorateRow(row, meta, ranked, exclusion) {
  const kind = meta?.kind ?? null;
  const isActive = meta?.isActive ?? null;
  const kindLabel = kind === null ? null : CHANNEL_KIND_LABELS[kind] ?? kind;

  return {
    ...row,
    kind,
    isActive,
    kindLabel,
    // The table shows the channel type under its name; an archived channel is still listed and still ranked.
    metaLabel: isActive === false ? `${kindLabel ?? ''} · в архиве`.trim() : kindLabel,
    rank: ranked?.rank ?? null,
    score: ranked?.score ?? null,
    contributions: ranked?.contributions ?? [],
    stack: ranked ? toStackSegments(ranked) : [],
    exclusion: exclusion ?? null,
  };
}

/**
 * Channel list screen (BO-04, BO-13).
 *
 * The health report runs once for the full channel set. Ranking is a pure function over those rows, so applying the
 * M2 `status`/`kind` filters afterwards cannot move a rank: an archived channel keeps the rank it earned, it just
 * disappears from the table when the reader asks only for active ones. A `no_data` or incomplete channel stays in
 * `rows` with `rank: null`; its reason is copied into `excluded` for the explanation block.
 *
 * @param {{
 *   healthService: { getChannelHealthReport: Function },
 *   metricsRepository: ReturnType<typeof import('../../repositories/metrics.repo.js').createMetricsRepository>,
 *   channelsRepository: ReturnType<typeof import('../../repositories/channels.repo.js').createChannelsRepository>,
 * }} deps
 */
export function createChannelListService({ healthService, metricsRepository, channelsRepository }) {
  return {
    /**
     * @param {{
     *   anchor?: string | null,
     *   from?: string | null,
     *   to?: string | null,
     *   status?: string,
     *   kind?: string,
     *   sort?: keyof typeof CHANNEL_SORT_FIELDS,
     *   dir?: 'asc' | 'desc',
     *   weights?: Record<string, number>,
     * }} [request]
     * @returns {Promise<{
     *   period: { from: string, to: string, days: number },
     *   filters: { status: string, kind: string },
     *   weights: Record<string, number>,
     *   weightsBasisPoints: Record<string, number>,
     *   rows: object[],
     *   blended: object,
     *   excluded: Array<{ channelId?: string, code: string, name: string, reason: string, reasonLabel: string }>,
     *   sparklines: Record<string, Array<{ weekLabel: string, value: number | null }>>,
     *   chart: { romi: object },
     *   labels: { period: string, channels: string, filter: string, sort: string },
     * }>}
     * @throws {ValidationError} When a filter, sort field or weight is outside the contract.
     * @throws {TypeError} When a dependency returns a row outside its contract.
     */
    async getChannelList({
      anchor = null,
      from = null,
      to = null,
      status = 'all',
      kind = 'all',
      sort = 'rank',
      dir,
      weights,
    } = {}) {
      if (!STATUSES.includes(status)) throw new ValidationError('Неизвестный фильтр статуса канала');
      if (!CHANNEL_KINDS.includes(kind)) throw new ValidationError('Неизвестный фильтр типа канала');
      if (!CHANNEL_SORT_FIELDS[sort]) throw new ValidationError('Неизвестное поле сортировки каналов');

      // One health report feeds the table, the ranking and the ROMI chart. A second `getRankingReport` would compute
      // every formula twice and could disagree with the rows.
      const health = await healthService.getChannelHealthReport({ anchor, from, to });
      const resolvedPeriod = health.period;

      const ranking = computeRanking({ channels: [...health.rows, health.blended], weights });
      const metaRows = await channelsRepository.listChannels();
      const metaById = new Map(metaRows.map((channel) => [channel.id, channel]));
      const rankedById = new Map(ranking.ranked.map((row) => [row.channelId, row]));
      const excludedById = new Map(
        ranking.excluded
          .filter((entry) => entry.channelId !== undefined)
          .map((entry) => [entry.channelId, entry]),
      );

      const decorated = health.rows.map((row) => {
        const ranked = rankedById.get(row.channelId) ?? null;
        const exclusion = ranked === null ? excludedById.get(row.channelId) ?? null : null;
        if (ranked === null && exclusion === null) {
          throw new TypeError(`health row ${row.code} is neither ranked nor excluded`);
        }
        return decorateRow(row, metaById.get(row.channelId), ranked, exclusion);
      });

      const visible = decorated.filter((row) => {
        if (status === 'active' && row.isActive !== true) return false;
        if (status === 'archived' && row.isActive !== false) return false;
        if (kind !== 'all' && row.kind !== kind) return false;
        return true;
      });

      const rows = sortChannelRows(visible, { sort, dir });

      // The explanation follows the table order, so a reader can connect an excluded channel to its row; the blended
      // summary is not a channel and is always the last line, as in the ranking contract.
      const excluded = rows
        .filter((row) => row.rank === null)
        .map((row) => ({
          channelId: row.channelId,
          code: row.code,
          name: row.name,
          reason: row.exclusion.reason,
          reasonLabel: row.exclusion.reasonLabel,
        }));
      excluded.push({
        code: 'blended',
        name: health.blended.name,
        reason: 'blended',
        reasonLabel: RANKING_REASON_LABELS.blended,
      });

      const { firstWeekStart } = resolveWeekRange(resolvedPeriod.to, METRICS_CONFIG.dashboard.weeks);
      const weeklyInputs = await metricsRepository.listChannelWeeklyCacInputs({
        from: firstWeekStart,
        to: resolvedPeriod.to,
      });
      const sparklines = buildSparklines({
        channels: rows,
        weeklyInputs,
        firstWeekStart,
        weeks: METRICS_CONFIG.dashboard.weeks,
      });

      return {
        period: resolvedPeriod,
        filters: { status, kind },
        weights: ranking.weights,
        weightsBasisPoints: ranking.weightsBasisPoints,
        rows,
        blended: health.blended,
        excluded,
        sparklines,
        chart: {
          romi: buildRomiByChannelChart({
            channels: rows,
            periodLabel: daysLabel(resolvedPeriod.days),
          }),
        },
        labels: {
          period: daysLabel(resolvedPeriod.days),
          channels: channelsLabel(rows.length),
          filter: filterLabel(status, kind),
          sort: CHANNEL_SORT_FIELDS[sort].label,
        },
      };
    },
  };
}

/**
 * Builds the sparkline series for every row in one pass over the weekly aggregate.
 *
 * Every channel gets a full window of complete Monday–Sunday weeks: a week without spend or customers stays `null`
 * (a gap in the line), not zero. The repository returns only weeks that have a row, so the grid is generated here
 * from the same `resolveWeekRange` window as the dashboard chart.
 *
 * @param {{
 *   channels: object[],
 *   weeklyInputs: Array<{ channelId: string, weekStart: string, spendCents: bigint, newCustomers: number }>,
 *   firstWeekStart: string,
 *   weeks: number,
 * }} input
 * @returns {Record<string, Array<{ weekLabel: string, value: number | null }>>}
 * @throws {TypeError} When a weekly input row breaks the repository contract.
 */
function buildSparklines({ channels, weeklyInputs, firstWeekStart, weeks }) {
  /** @type {Map<string, { weekLabel: string, cacCents: string | null }[]>} */
  const pointsByChannel = new Map(channels.map((channel) => [channel.channelId, []]));
  /** @type {Map<string, { spendCents: bigint, newCustomers: number }>} */
  const inputs = new Map();

  for (const row of weeklyInputs) {
    if (typeof row.spendCents !== 'bigint' || row.spendCents < 0n) {
      throw new TypeError(`weekly spendCents must be a non-negative bigint, got ${String(row.spendCents)}`);
    }
    inputs.set(`${row.channelId}|${row.weekStart}`, {
      spendCents: row.spendCents,
      newCustomers: row.newCustomers,
    });
  }

  for (let offset = 0; offset < weeks; offset += 1) {
    const weekStart = addDays(firstWeekStart, offset * 7);
    const weekLabel = formatDateRu(weekStart);
    for (const channel of channels) {
      const input = inputs.get(`${channel.channelId}|${weekStart}`);
      const { cacCents } = computeCac({
        spendCents: input?.spendCents ?? 0n,
        newCustomers: input?.newCustomers ?? 0,
      });
      pointsByChannel.get(channel.channelId).push({ weekLabel, cacCents: centsToApi(cacCents) });
    }
  }

  return Object.fromEntries(
    [...pointsByChannel].map(([channelId, points]) => [channelId, toSparklinePoints(points)]),
  );
}
