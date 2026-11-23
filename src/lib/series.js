/**
 * Chart-ready transformations shared by every metrics screen.
 *
 * The weekly series is a server-side view-model: money is a decimal kopeck string and a missing CAC/ROMI is `null`.
 * Recharts needs numbers, but converting `null` to `0` would draw a measured zero where the truth is "not measured".
 * These helpers keep the distinction; the chart receives `null` and `connectNulls={false}` leaves a gap.
 */

/**
 * @param {unknown} value A chart point candidate.
 * @returns {boolean} True when the value is a finite number (a measured point, including a real zero).
 */
function isMeasured(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * CAC values in kopecks for the chart's numeric axis. Kopecks, not BYN floats: the tooltip formats them through the
 * same money formatter as every other screen, so a chart value and a table value cannot disagree.
 *
 * @param {Array<{ cacCents: string | null }>} series Weekly buckets.
 * @returns {Array<number | null>}
 * @throws {TypeError} When a present `cacCents` is not an integer string.
 */
export function toCacPoints(series) {
  return series.map((bucket) => {
    if (bucket.cacCents === null) return null;
    const cents = Number(bucket.cacCents);
    if (!Number.isSafeInteger(cents)) {
      throw new TypeError(`weekly cacCents must be an integer string, got ${JSON.stringify(bucket.cacCents)}`);
    }
    return cents;
  });
}

/**
 * ROMI percentages for the chart. Values are plain numbers in the view-model, so no parsing is involved.
 *
 * @param {Array<{ romiPct: number | null }>} series Weekly buckets.
 * @returns {Array<number | null>}
 */
export function toRomiPoints(series) {
  return series.map((bucket) => bucket.romiPct ?? null);
}

/**
 * Spend and attributed revenue in kopecks for the grouped bar chart.
 * @param {Array<{ spendCents: string, attributedCents: string }>} series Weekly buckets.
 * @returns {Array<{ spend: number, revenue: number }>}
 * @throws {TypeError} When a money string is not an integer.
 */
export function toSpendRevenuePoints(series) {
  return series.map((bucket) => ({
    spend: toCentsNumber(bucket.spendCents, 'spendCents'),
    revenue: toCentsNumber(bucket.attributedCents, 'attributedCents'),
  }));
}

/**
 * Spend per channel for the horizontal bar chart. Channels keep their server order; sorting is a presentation
 * decision and belongs to the chart model, not to this loss-free conversion.
 *
 * @param {Array<{ channelId: string, name: string, spendCents: string }>} channels Health rows.
 * @returns {Array<{ channelId: string, name: string, spend: number }>}
 * @throws {TypeError} When a spend value is not an integer string.
 */
export function toChannelSpendPoints(channels) {
  return channels.map((channel) => ({
    channelId: channel.channelId,
    name: channel.name,
    spend: toCentsNumber(channel.spendCents, 'channel spendCents'),
  }));
}

/**
 * CAC×LTV points for the scatter. A channel missing either money value keeps `null` on that axis: it stays in the
 * duplicate table as a dash but is not plotted, because a point on an axis it does not have would be a fabricated
 * measurement. `newCustomers` drives the bubble size and is validated so a bad row fails loudly.
 *
 * @param {Array<{
 *   channelId: string, name: string, cacCents: string | null, ltv12Cents: string | null, newCustomers: number,
 * }>} channels Health rows.
 * @returns {Array<{
 *   channelId: string, name: string, cac: number | null, ltv: number | null, newCustomers: number,
 * }>}
 * @throws {TypeError} When a present money value is not an integer string or the customer count is invalid.
 */
export function toCacLtvPoints(channels) {
  return channels.map((channel) => {
    if (!Number.isInteger(channel.newCustomers) || channel.newCustomers < 0) {
      throw new TypeError(
        `channel newCustomers must be a non-negative integer, got ${String(channel.newCustomers)}`,
      );
    }

    return {
      channelId: channel.channelId,
      name: channel.name,
      cac: channel.cacCents === null ? null : toCentsNumber(channel.cacCents, 'channel cacCents'),
      ltv: channel.ltv12Cents === null ? null : toCentsNumber(channel.ltv12Cents, 'channel ltv12Cents'),
      newCustomers: channel.newCustomers,
    };
  });
}

/**
 * @param {string} value Decimal kopeck string from a view-model.
 * @param {string} name Field name for the error.
 * @returns {number}
 * @throws {TypeError} When the string is not a safe integer. Chart values are display-only, so a lossy conversion
 *   is acceptable, but a malformed value is not.
 */
function toCentsNumber(value, name) {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents)) {
    throw new TypeError(`weekly ${name} must be an integer string, got ${JSON.stringify(value)}`);
  }
  return cents;
}

/**
 * A chart is empty only when every point is unmeasured. `[null, null]` has no line to draw, while `[null, 0]` is a
 * valid series: the second week was measured and is genuinely zero.
 *
 * @param {Array<number | null | undefined>} points
 * @returns {boolean}
 */
export function hasPlottableData(points) {
  return Array.isArray(points) && points.some(isMeasured);
}
