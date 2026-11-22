import { METRICS_CONFIG } from '../../config/metrics.js';
import { ValidationError } from '../../lib/errors.js';
import { formatCentsToByn, formatMonths, formatRatio, formatRomi } from '../../lib/format.js';
import { HEALTH_STATUS_LABELS } from '../../lib/metrics-labels.js';
import {
  assertFiniteOrNull,
  centsPercent,
  centsRatio,
  centsToApi,
  roundNumber,
} from '../../lib/metrics-math.js';
import { centsFromDb } from '../../lib/money.js';
import { resolvePeriod } from '../../lib/periods.js';

const ATTRIBUTION_MODELS = METRICS_CONFIG.attribution.models;

/**
 * Twelve months in a year, as a bigint, for the cross-multiplied payback comparison.
 * `computePayback` is `CAC * 12 / LTV12`, so a threshold check never divides.
 */
const MONTHS_PER_YEAR = BigInt(METRICS_CONFIG.ltv.monthsPerYear);

/** Guard digits, not display precision: `12.004` and `2.9996` must survive until `deriveHealth` compares them. */
const ROMI_DECIMALS = 4;
const PAYBACK_DECIMALS = 6;
const RATIO_DECIMALS = 6;

/** Display precision applied only while building the view model; the health status is decided before it. */
const ROMI_DISPLAY_DECIMALS = 2;
const PAYBACK_DISPLAY_DECIMALS = 2;
const RATIO_DISPLAY_DECIMALS = 3;

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {bigint} The same amount.
 * @throws {TypeError} When the value is not a non-negative bigint of kopecks.
 */
function assertCents(value, name) {
  if (typeof value !== 'bigint') {
    throw new TypeError(`${name} must be a bigint of kopecks, got ${typeof value}`);
  }
  if (value < 0n) {
    throw new TypeError(`${name} must be non-negative, got ${value}`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {boolean} True when the amount is absent.
 */
function isMissing(value) {
  return value === null || value === undefined;
}

/**
 * ROMI of one channel (metrics spec §3.2).
 *
 * The numerator may be negative (spend above revenue), so the sign is kept. `spend = 0` has no finite ROI and
 * returns `null` rather than Infinity; the health status then becomes `no_data`.
 *
 * @param {{ revenueCents: bigint | null, spendCents: bigint | null }} input Attributed revenue and spend, kopecks.
 * @returns {number | null} Percentage with four guard digits, or null when spend is zero or missing.
 * @throws {TypeError} When a present amount is negative or not a bigint.
 */
export function computeRomi({ revenueCents, spendCents } = {}) {
  if (isMissing(revenueCents) || isMissing(spendCents)) return null;
  assertCents(revenueCents, 'computeRomi revenueCents');
  assertCents(spendCents, 'computeRomi spendCents');
  if (spendCents === 0n) return null;

  return centsPercent(revenueCents - spendCents, spendCents, ROMI_DECIMALS);
}

/**
 * Payback in months (metrics spec §3.3): `CAC / (LTV12 / 12)`.
 *
 * The division is cross-multiplied to `CAC * 12 / LTV12` so it runs through `centsRatio` once. A missing operand or
 * a zero monthly margin (`LTV12 = 0`) means payback is undefined; six guard digits keep `12.004` distinguishable
 * from `12`.
 *
 * @param {{ cacCents: bigint | null, ltv12Cents: bigint | null }} input Money in kopecks.
 * @returns {number | null} Months with six guard digits, or null when the ratio is undefined.
 * @throws {TypeError} When a present amount is negative or not a bigint.
 */
export function computePayback({ cacCents, ltv12Cents } = {}) {
  if (isMissing(cacCents) || isMissing(ltv12Cents)) return null;
  assertCents(cacCents, 'computePayback cacCents');
  assertCents(ltv12Cents, 'computePayback ltv12Cents');
  if (ltv12Cents === 0n) return null;

  return centsRatio(cacCents * MONTHS_PER_YEAR, ltv12Cents, PAYBACK_DECIMALS);
}

/**
 * LTV:CAC coefficient (metrics spec §3.4). A zero CAC makes the ratio undefined; a free channel is `no_data`, not
 * an infinite return.
 *
 * @param {{ ltv12Cents: bigint | null, cacCents: bigint | null }} input Money in kopecks.
 * @returns {number | null} Coefficient with six guard digits, or null when it is undefined.
 * @throws {TypeError} When a present amount is negative or not a bigint.
 */
export function computeLtvCac({ ltv12Cents, cacCents } = {}) {
  if (isMissing(ltv12Cents) || isMissing(cacCents)) return null;
  assertCents(ltv12Cents, 'computeLtvCac ltv12Cents');
  assertCents(cacCents, 'computeLtvCac cacCents');
  if (cacCents === 0n) return null;

  return centsRatio(ltv12Cents, cacCents, RATIO_DECIMALS);
}

/**
 * Health status of one channel (metrics spec §3.4).
 *
 * This function never divides and never looks at the rounded view-model values. Every threshold is checked by
 * cross-multiplying integers, which is what keeps `2.9996` out of `healthy` even though it displays as `3,000` and
 * `12.004` months from passing the payback limit. Priority is `no_data → risk → watch → healthy`.
 *
 * Note that `payback = 12 / ratio` for any positive LTV, so a payback above 12 always implies a ratio below 1. The
 * payback clauses are kept because the spec lists them as thresholds of their own; in practice the ratio clause
 * reaches `risk`/`watch` first.
 *
 * @param {{
 *   cacCents: bigint | null,
 *   ltv12Cents: bigint | null,
 *   revenueCents: bigint | null,
 *   spendCents: bigint | null,
 * }} input Money in kopecks; null means "not measured".
 * @returns {'healthy' | 'watch' | 'risk' | 'no_data'}
 * @throws {TypeError} When a present amount is negative or not a bigint.
 */
export function deriveHealth({ cacCents, ltv12Cents, revenueCents, spendCents } = {}) {
  if (isMissing(cacCents) || isMissing(ltv12Cents) || isMissing(revenueCents) || isMissing(spendCents)) {
    return 'no_data';
  }

  assertCents(cacCents, 'deriveHealth cacCents');
  assertCents(ltv12Cents, 'deriveHealth ltv12Cents');
  assertCents(revenueCents, 'deriveHealth revenueCents');
  assertCents(spendCents, 'deriveHealth spendCents');

  // ROMI is undefined without spend, so none of the other metrics can speak for the channel.
  if (spendCents === 0n) return 'no_data';

  const { healthyRatio, watchRatio, romiRiskBelow, healthyPaybackMax, watchPaybackMax } = METRICS_CONFIG.health;

  // ROMI < romiRiskBelow without a division: (revenue - spend) * 100 < threshold * spend. The threshold is an
  // integer percentage, so cross-multiplying keeps the comparison exact for every kopeck count.
  if ((revenueCents - spendCents) * 100n < BigInt(romiRiskBelow) * spendCents) return 'risk';
  if (cacCents > 0n && ltv12Cents < BigInt(watchRatio) * cacCents) return 'risk';
  if (cacCents * MONTHS_PER_YEAR > BigInt(watchPaybackMax) * ltv12Cents) return 'risk';

  if (cacCents > 0n && ltv12Cents < BigInt(healthyRatio) * cacCents) return 'watch';
  if (cacCents * MONTHS_PER_YEAR > BigInt(healthyPaybackMax) * ltv12Cents) return 'watch';

  return 'healthy';
}

/**
 * Builds one JSON-safe health row. Money leaves as decimal kopeck strings so M4 can put the object into
 * `data-props`; display rounding happens here, after `deriveHealth` has already seen the exact values.
 *
 * @param {{
 *   channelId?: string,
 *   code: string,
 *   name: string,
 *   spendCents: bigint,
 *   revenueCents: bigint,
 *   newCustomers: number,
 *   cacCents: bigint | null,
 *   ltv12Cents: bigint | null,
 * }} input A row already parsed to bigints.
 * @returns {object}
 * @throws {TypeError} When an amount is not a bigint or the customer count is invalid.
 */
function buildRow({
  channelId,
  code,
  name,
  spendCents,
  revenueCents,
  newCustomers,
  cacCents,
  ltv12Cents,
}) {
  if (!Number.isInteger(newCustomers) || newCustomers < 0) {
    throw new TypeError(`newCustomers must be a non-negative integer, got ${String(newCustomers)}`);
  }

  const status = deriveHealth({ cacCents, ltv12Cents, revenueCents, spendCents });
  const romiExact = computeRomi({ revenueCents, spendCents });
  const paybackExact = computePayback({ cacCents, ltv12Cents });
  const ratioExact = computeLtvCac({ ltv12Cents, cacCents });

  const romiPct = assertFiniteOrNull(roundNumber(romiExact, ROMI_DISPLAY_DECIMALS), 'romiPct');
  const paybackMonths = assertFiniteOrNull(roundNumber(paybackExact, PAYBACK_DISPLAY_DECIMALS), 'paybackMonths');
  const ltvCacRatio = assertFiniteOrNull(roundNumber(ratioExact, RATIO_DISPLAY_DECIMALS), 'ltvCacRatio');

  return {
    // The blended row deliberately has no `channelId`: ranking uses that absence to exclude it.
    ...(channelId === undefined ? {} : { channelId }),
    code,
    name,
    spendCents: centsToApi(spendCents),
    revenueCents: centsToApi(revenueCents),
    newCustomers,
    cacCents: centsToApi(cacCents),
    cacLabel: formatCentsToByn(cacCents),
    ltv12Cents: centsToApi(ltv12Cents),
    ltvLabel: formatCentsToByn(ltv12Cents),
    romiPct,
    // The label is built from the guard value, not from the two-decimal API field: a tiny negative must not be
    // formatted from `0` and thereby lose its sign.
    romiLabel: formatRomi(romiExact),
    paybackMonths,
    // A missing payback is a dash, not "— мес.": the suffix belongs to a real month count.
    paybackLabel: paybackMonths === null ? formatMonths(null) : `${formatMonths(paybackMonths)} мес.`,
    ltvCacRatio,
    ratioLabel: formatRatio(ltvCacRatio),
    status,
    statusLabel: HEALTH_STATUS_LABELS[status],
  };
}

/**
 * Channel health service (BO-03; metrics spec §3.2–§3.4).
 *
 * One call each to the CAC, cohort-LTV and attribution services, then an in-memory join by `channelId`. There is no
 * per-channel query and no formula duplicated from T1–T3: spend comes from CAC, attributed revenue from the
 * selected attribution model, and LTV12 from the cohort engine.
 *
 * @param {{
 *   cacService: { getCacReport: Function },
 *   ltvService: { getChannelLtv: Function },
 *   attributionService: { getAttributionReport: Function },
 *   channelsRepository: ReturnType<typeof import('../../repositories/channels.repo.js').createChannelsRepository>,
 * }} deps
 */
export function createChannelHealthService({ cacService, ltvService, attributionService, channelsRepository }) {
  return {
    /**
     * @param {{
     *   from?: string | null,
     *   to?: string | null,
     *   anchor?: string | null,
     *   attributionModel?: 'last_touch' | 'first_touch' | 'linear',
     * }} [request] `anchor` is the data anchor; explicit bounds are clamped to it by `resolvePeriod`.
     * @returns {Promise<{
     *   period: { from: string, to: string, days: number },
     *   rows: object[],
     *   blended: object,
     * }>} Money as decimal kopeck strings, percentages and ratios as numbers, one row per channel plus a blended
     *   row without `channelId`.
     * @throws {ValidationError} When the anchor, period or attribution model is invalid.
     * @throws {TypeError} When a dependency returns a row outside its contract.
     */
    async getChannelHealthReport({
      from = null,
      to = null,
      anchor = null,
      attributionModel = METRICS_CONFIG.attribution.defaultModel,
    } = {}) {
      if (!ATTRIBUTION_MODELS.includes(attributionModel)) {
        throw new ValidationError('Неизвестная модель атрибуции');
      }

      const period = resolvePeriod({ anchor, from, to });

      // Sequential on purpose: callers may hand all three services one shared `pg.Client` (tests, report
      // transactions), and node-postgres deprecates overlapping queries on a single client.
      const cacReport = await cacService.getCacReport({ anchor, from: period.from, to: period.to });
      const ltvReport = await ltvService.getChannelLtv({
        anchor,
        horizonMonths: METRICS_CONFIG.ltv.defaultHorizon,
      });
      const attributionReport = await attributionService.getAttributionReport({
        from: period.from,
        to: period.to,
        models: [attributionModel],
      });
      const channels = await channelsRepository.listChannels();

      const modelView = attributionReport.models?.[attributionModel];
      if (!modelView) {
        throw new TypeError(`attribution report is missing the requested model: ${attributionModel}`);
      }

      const cacByChannel = new Map(cacReport.rows.map((row) => [row.channelId, row]));
      const ltvByChannel = new Map(ltvReport.rows.map((row) => [row.channelId, row]));
      const revenueByChannel = new Map(
        modelView.revenueByChannel.map((row) => [row.channelId, row.revenueCents]),
      );

      const rows = [...channels]
        .sort((left, right) => left.code.localeCompare(right.code) || left.id.localeCompare(right.id))
        .map((channel) => {
          const cacRow = cacByChannel.get(channel.id);
          const ltvRow = ltvByChannel.get(channel.id);
          return buildRow({
            channelId: channel.id,
            code: channel.code,
            name: channel.name,
            // A channel absent from CAC or attribution has no spend/revenue in the period, which is a real zero.
            spendCents: centsFromDb(cacRow?.spendCents ?? '0') ?? 0n,
            revenueCents: centsFromDb(revenueByChannel.get(channel.id) ?? '0') ?? 0n,
            newCustomers: cacRow?.newCustomers ?? 0,
            cacCents: centsFromDb(cacRow?.cacCents ?? null),
            // A missing LTV row stays null: zero revenue must never be presented as zero LTV.
            ltv12Cents: centsFromDb(ltvRow?.ltvCents ?? null),
          });
        });

      const blended = buildRow({
        code: 'blended',
        name: 'Все каналы',
        spendCents: centsFromDb(cacReport.blended.spendCents) ?? 0n,
        // The attributed total, not raw order revenue: ROMI compares spend with the revenue this model assigned.
        revenueCents: centsFromDb(modelView.totalAttributedCents) ?? 0n,
        newCustomers: cacReport.blended.newCustomers,
        cacCents: centsFromDb(cacReport.blended.cacCents),
        ltv12Cents: centsFromDb(ltvReport.blended.ltvCents),
      });

      return { period, rows, blended };
    },
  };
}
