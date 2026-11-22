/**
 * Deterministic demo seed for the «Метрика» stand.
 *
 * Everything is generated from one `mulberry32(20261121)` stream, so two runs on the same day produce byte-for-byte
 * the same dataset: identical counts, timestamps, amounts and therefore identical CAC/LTV/ROMI. There is no
 * `Math.random()`, no faker and no network access.
 *
 * The seed is idempotent: it truncates every demo table (keeping `schema_migrations`) and restores the sequences,
 * then inserts users → channels → campaigns → customers → orders → touchpoints → daily stats → goals inside one
 * transaction. A failure rolls the whole dataset back instead of leaving a half-seeded stand.
 *
 * The reporting window ends at the Minsk anchor day (yesterday by default) and spans 14 calendar months, which is
 * what the dashboard's default periods, the cohorts and the goal periods are calibrated against.
 */

import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { hash } from '@node-rs/argon2';
import { env } from '../../src/config/env.js';
import { logger } from '../../src/lib/logger.js';
import { addDays, minskDayEnd, minskDayStart, minskYesterday, toDateOnly } from '../../src/lib/dates.js';
import { CAMPAIGNS, CHANNELS, DEMO_PASSWORD, DEMO_USERS } from './data.js';

/**
 * PRNG seed fixed by the brief; changing it changes every generated number.
 * Exported so the golden fixture can pin the same value instead of hard-coding a second copy.
 */
export const SEED_PRNG = 20261121;
/** Bulk insert size. 500 rows × at most 7 columns stays far below PostgreSQL's 65535 bound parameters. */
const BATCH_SIZE = 500;
const CUSTOMER_COUNT = 4000;
/**
 * Probability of 1, 2, 3, 4 and 5 orders per customer. Tuned so the counts clipped at the anchor stay inside the
 * 9 000–10 000 range the brief requires (~9.5k orders); a plain uniform 1–5 would overshoot at 12k.
 */
const ORDER_COUNT_WEIGHTS = [0.2, 0.26, 0.27, 0.17, 0.1];
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Sunday-first profile matching `Date#getUTCDay`; the week averages to ~0.986, so spend stays near the budget. */
const WEEK_PROFILE = [0.8, 1.05, 1.05, 1.05, 1.05, 1.05, 0.85];
const MIN_ORDER_CENTS = 6000;
const MAX_ORDER_CENTS = 18000;
const TOUCHPOINT_SHARE_OF_ACQUISITION_CHANNEL = 0.7;
const ORDER_SHARE_OF_ACQUISITION_CHANNEL = 0.75;

/**
 * Deterministic 1×1 RGBA PNG used as the site's OG cover until an admin uploads a real one. Kept as a base64
 * constant so a fresh `npm run seed` produces `/media/slug/og-cover` with byte-identical content on every run.
 */
const OG_COVER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Tables owned by the demo data. `sessions`, `audit_log`, `import_batches`, `scenarios`, `alerts` and
 * `media_assets` are truncated too so a reseed never mixes generated rows with leftovers from a manual test.
 */
const TRUNCATE_TABLES = [
  'users',
  'sessions',
  'channels',
  'campaigns',
  'daily_stats',
  'customers',
  'touchpoints',
  'orders',
  'goals',
  'alerts',
  'scenarios',
  'audit_log',
  'import_batches',
  'media_assets',
];

/**
 * Deterministic 32-bit PRNG (mulberry32). Returns a function producing floats in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Small helper bundle around the PRNG so call sites read as intent ("an integer in range", "a weighted item")
 * instead of arithmetic on floats.
 * @param {number} seed
 */
function createRandom(seed) {
  const next = mulberry32(seed);
  return {
    next,
    /**
     * @param {number} min Inclusive lower bound.
     * @param {number} max Inclusive upper bound.
     * @returns {number}
     */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /**
     * Picks one of the items with probability proportional to `weightOf(item)`.
     * @template T
     * @param {readonly T[]} items Non-empty list.
     * @param {(item: T) => number} weightOf Non-negative weight.
     * @returns {T}
     */
    weighted(items, weightOf) {
      const total = items.reduce((sum, item) => sum + weightOf(item), 0);
      let roll = next() * total;
      for (const item of items) {
        roll -= weightOf(item);
        if (roll < 0) return item;
      }
      return items[items.length - 1];
    },
  };
}

/** @param {number} value @returns {string} */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * @param {string} dateOnly `YYYY-MM-DD`.
 * @returns {number} UTC epoch milliseconds of that calendar day at 00:00 UTC.
 */
function dayUtcMs(dateOnly) {
  const [year, month, day] = dateOnly.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * @param {string} startDate `YYYY-MM-DD`.
 * @param {string} endDate `YYYY-MM-DD`.
 * @returns {number} Whole days between the two calendar dates.
 */
function daysBetween(startDate, endDate) {
  return Math.round((dayUtcMs(endDate) - dayUtcMs(startDate)) / DAY_MS);
}

/**
 * First day of the month `months` months before the month of `dateOnly`; used to open the 14-month window and
 * the 12-month goal period without pulling month arithmetic into `dates.js`.
 * @param {string} dateOnly `YYYY-MM-DD`.
 * @param {number} months Positive number of months to go back.
 * @returns {string} `YYYY-MM-01`.
 */
function firstDayMonthsBefore(dateOnly, months) {
  const shifted = new Date(Date.UTC(Number(dateOnly.slice(0, 4)), Number(dateOnly.slice(5, 7)) - 1 - months, 1));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-01`;
}

/**
 * Bulk inserts rows in batches of `BATCH_SIZE` on the caller's transaction client.
 *
 * Table and column names come from module constants, never from input; values are always bound parameters.
 *
 * @param {import('pg').ClientBase} client
 * @param {string} table
 * @param {string[]} columns
 * @param {ReadonlyArray<ReadonlyArray<unknown>>} rows
 * @param {string[]} [returning] Columns of an optional RETURNING clause.
 * @returns {Promise<Record<string, unknown>[]>} Rows returned by RETURNING, empty otherwise.
 */
async function insertBatches(client, table, columns, rows, returning = null) {
  /** @type {Record<string, unknown>[]} */
  const returned = [];
  const returningSql = returning ? ` RETURNING ${returning.join(', ')}` : '';

  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const chunk = rows.slice(offset, offset + BATCH_SIZE);
    /** @type {unknown[]} */
    const params = [];
    const tuples = chunk.map((row) => {
      if (row.length !== columns.length) {
        throw new Error(`${table}: row has ${row.length} values for ${columns.length} columns`);
      }
      const placeholders = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });

    const result = await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}${returningSql}`,
      params,
    );
    if (returning) returned.push(...result.rows);
  }

  return returned;
}

/**
 * Pool used by the seed when the caller did not pass one.
 *
 * Integration tests run with `NODE_ENV=test` and must touch `metrika_test`, not the development database; the CLI
 * runs as development/production and uses `DATABASE_URL`. Ownership stays with the caller: only a pool created here
 * is closed here.
 * @returns {pg.Pool}
 */
function createSeedPool() {
  const connectionString = env.nodeEnv === 'test' ? env.testDatabaseUrl : env.databaseUrl;
  if (!connectionString) {
    throw new Error(`no connection string for NODE_ENV=${env.nodeEnv}`);
  }
  const pool = new pg.Pool({ connectionString, max: 1 });
  pool.on('error', (error) => logger.error({ err: error }, 'idle seed database client failed'));
  return pool;
}

/**
 * Formats integer kopecks as `1 234,56` for the CLI summary; display only, the database keeps integers.
 * @param {number} cents
 * @returns {string}
 */
function formatByn(cents) {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const rubles = String(Math.trunc(absolute / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${rubles},${pad2(absolute % 100)}`;
}

/**
 * Populates the demo database with the deterministic «Зёрна» dataset.
 *
 * @param {object} [options]
 * @param {string} [options.anchorDate] Last day covered by the data as `YYYY-MM-DD`; defaults to Minsk yesterday.
 * @param {pg.Pool} [options.pool] Caller-owned pool (used by scripts); when omitted the seed opens and closes its own.
 * @returns {Promise<{
 *   users: number,
 *   channels: number,
 *   campaigns: number,
 *   customers: number,
 *   orders: number,
 *   touchpoints: number,
 *   dailyStats: number,
 *   goals: number,
 *   anchorDate: string,
 *   periodStart: string,
 *   totalSpendCents: number,
 *   totalRevenueCents: number,
 * }>} Inserted row counts, the covered window and the totals shown by the CLI summary.
 * @throws {Error} When the target database is unreachable or any insert violates the schema; the transaction is
 *   rolled back, so the previous dataset survives a failed reseed.
 */
export async function seed({ anchorDate, pool: providedPool } = {}) {
  const anchor = anchorDate ?? minskYesterday();
  const periodStart = firstDayMonthsBefore(anchor, 13);
  const goalPeriodStart = firstDayMonthsBefore(anchor, 11);
  const periodStartMs = minskDayStart(periodStart).getTime();
  const anchorEndMs = minskDayEnd(anchor).getTime();

  const random = createRandom(SEED_PRNG);
  // One hash for all three demo accounts: the password is identical and hashing is the slowest step of the seed.
  const passwordHash = await hash(DEMO_PASSWORD);

  const channelByCode = new Map(CHANNELS.map((channel) => [channel.code, channel]));

  /** @type {ReadonlyArray<typeof CAMPAIGNS[number] & { startedOn: string, endedOn: string | null }>} */
  const campaignPlan = CAMPAIGNS.map((campaign) => {
    const startedOn = addDays(periodStart, campaign.startOffsetDays);
    const endedOn = campaign.endedDaysBeforeAnchor ? addDays(anchor, -campaign.endedDaysBeforeAnchor) : null;
    // A too-early anchorDate would leave the finished campaign with a negative window and silently no stats.
    if (endedOn && endedOn < startedOn) {
      throw new Error(`campaign ${campaign.code} ends before it starts: anchor ${anchor} is too early`);
    }
    return { ...campaign, startedOn, endedOn };
  });
  const campaignsByChannel = new Map(
    CHANNELS.map((channel) => [channel.code, campaignPlan.filter((campaign) => campaign.channelCode === channel.code)]),
  );

  /**
   * Campaign of the channel that was running on the given instant. Campaigns of a channel start within the first
   * month and a half, so for very early touchpoints only the offset-0 campaign qualifies; it is the fallback too.
   * @param {string} channelCode
   * @param {number} instantMs
   * @returns {typeof campaignPlan[number]}
   */
  function campaignAt(channelCode, instantMs) {
    const candidates = campaignsByChannel.get(channelCode);
    const dateOnly = toDateOnly(new Date(instantMs));
    const running = candidates.filter(
      (campaign) => campaign.startedOn <= dateOnly && (campaign.endedOn === null || dateOnly <= campaign.endedOn),
    );
    const eligible = running.length > 0 ? running : candidates;
    return eligible[random.int(0, eligible.length - 1)];
  }

  /**
   * Acquisition plan for one customer: when they first appeared, when they ordered and how many touches they left.
   * Built before customers are inserted because later phases only need the generated ids.
   */
  const customerPlans = [];
  for (let index = 0; index < CUSTOMER_COUNT; index += 1) {
    const channel = random.weighted(CHANNELS, (item) => item.customerShare);
    const firstOrderAtMs = random.int(periodStartMs + 2 * DAY_MS, anchorEndMs - 2 * DAY_MS);
    const orderCount = random.weighted([1, 2, 3, 4, 5], (count) => ORDER_COUNT_WEIGHTS[count - 1]);

    /** @type {number[]} */
    const orderTimesMs = [firstOrderAtMs];
    for (let orderIndex = 1; orderIndex < orderCount; orderIndex += 1) {
      const gapMs = random.int(10, 90) * DAY_MS + random.int(0, 23) * HOUR_MS + random.int(0, 59) * 60_000;
      const nextMs = orderTimesMs[orderTimesMs.length - 1] + gapMs;
      // Later orders are dropped rather than squeezed before the anchor: every order must stay inside the window,
      // and "1–5 orders per customer" does not require the full count for late customers.
      if (nextMs > anchorEndMs) break;
      orderTimesMs.push(nextMs);
    }

    const acquiredAtMs = Math.max(
      periodStartMs,
      firstOrderAtMs - random.int(1, 14) * DAY_MS - random.int(0, 86_399_999),
    );

    customerPlans.push({
      externalId: `zerna_customer_${String(index + 1).padStart(4, '0')}`,
      channel,
      acquiredAtMs,
      orderTimesMs,
      acquisitionCampaign: campaignAt(channel.code, acquiredAtMs),
      touchpointCount: random.int(2, 5),
    });
  }

  // The pool is created here but closed in the outermost `finally`, so even a failed connect cannot leak one.
  const seedPool = providedPool ?? createSeedPool();
  /** @type {import('pg').PoolClient | null} */
  let client = null;

  try {
    client = await seedPool.connect();
    await client.query('BEGIN');
    await client.query(`TRUNCATE ${TRUNCATE_TABLES.join(', ')} RESTART IDENTITY CASCADE`);

    // The public OG route must work immediately after a seed, before any admin uploads a cover. ON CONFLICT keeps
    // the statement safe if the table is ever truncated outside this block.
    const ogCoverChecksum = createHash('sha256').update(OG_COVER_PNG).digest('hex');
    await client.query(
      `INSERT INTO media_assets (slug, filename, mime_type, size_bytes, checksum, bytes)
       VALUES ('og-cover', 'og-cover.png', 'image/png', $1, $2, $3)
       ON CONFLICT (slug) DO UPDATE
         SET filename = EXCLUDED.filename,
             mime_type = EXCLUDED.mime_type,
             size_bytes = EXCLUDED.size_bytes,
             checksum = EXCLUDED.checksum,
             bytes = EXCLUDED.bytes`,
      [OG_COVER_PNG.length, ogCoverChecksum, OG_COVER_PNG],
    );

    const userRows = await insertBatches(
      client,
      'users',
      ['email', 'password_hash', 'full_name', 'role'],
      DEMO_USERS.map((user) => [user.email, passwordHash, user.fullName, user.role]),
      ['id', 'role'],
    );
    const adminId = userRows.find((row) => row.role === 'admin')?.id;
    if (!adminId) throw new Error('seed is missing the admin user');

    const channelRows = await insertBatches(
      client,
      'channels',
      ['code', 'name', 'kind', 'target_cac_cents', 'target_romi_pct'],
      CHANNELS.map((channel) => [
        channel.code,
        channel.name,
        channel.kind,
        channel.targetCacByn * 100,
        channel.targetRomiPct,
      ]),
      ['id', 'code'],
    );
    /** @type {Map<string, string>} */
    const channelIdByCode = new Map(channelRows.map((row) => [String(row.code), String(row.id)]));

    const campaignRows = await insertBatches(
      client,
      'campaigns',
      ['channel_id', 'code', 'name', 'status', 'started_on', 'ended_on', 'budget_cents'],
      campaignPlan.map((campaign) => [
        channelIdByCode.get(campaign.channelCode),
        campaign.code,
        campaign.name,
        campaign.status,
        campaign.startedOn,
        campaign.endedOn,
        campaign.budgetByn * 100,
      ]),
      ['id', 'code'],
    );
    /** @type {Map<string, string>} */
    const campaignIdByCode = new Map(campaignRows.map((row) => [String(row.code), String(row.id)]));

    const customerRows = await insertBatches(
      client,
      'customers',
      ['external_id', 'first_channel_id', 'first_campaign_id', 'acquired_at', 'first_order_at'],
      customerPlans.map((plan) => [
        plan.externalId,
        channelIdByCode.get(plan.channel.code),
        campaignIdByCode.get(plan.acquisitionCampaign.code),
        new Date(plan.acquiredAtMs).toISOString(),
        new Date(plan.orderTimesMs[0]).toISOString(),
      ]),
      ['id', 'external_id'],
    );
    /** @type {Map<string, string>} */
    const customerIdByExternalId = new Map(customerRows.map((row) => [String(row.external_id), String(row.id)]));

    /** @type {Array<Array<unknown>>} */
    const orderRows = [];
    /** @type {Array<Array<unknown>>} */
    const touchpointRows = [];
    let totalRevenueCents = 0;
    let orderNumber = 0;

    for (const plan of customerPlans) {
      const customerId = customerIdByExternalId.get(plan.externalId);
      const acquisitionChannelId = channelIdByCode.get(plan.channel.code);
      const channelsOtherThanAcquisition = CHANNELS.filter((channel) => channel.code !== plan.channel.code);

      // Orders: mostly attributed to the acquisition channel, the rest to channels that also compete for the
      // same demand. Revenue and margin are drawn per order, margin strictly below revenue (35–55 % of the cheque).
      for (const occurredAtMs of plan.orderTimesMs) {
        const channelCode =
          random.next() < ORDER_SHARE_OF_ACQUISITION_CHANNEL
            ? plan.channel.code
            : random.weighted(channelsOtherThanAcquisition, (channel) => channel.customerShare).code;
        const revenueCents = random.int(MIN_ORDER_CENTS, MAX_ORDER_CENTS);
        const marginCents = Math.round((revenueCents * random.int(35, 55)) / 100);
        orderNumber += 1;
        orderRows.push([
          `zerna_order_${String(orderNumber).padStart(6, '0')}`,
          customerId,
          campaignIdByCode.get(campaignAt(channelCode, occurredAtMs).code),
          new Date(occurredAtMs).toISOString(),
          revenueCents,
          marginCents,
        ]);
        totalRevenueCents += revenueCents;
      }

      // Touchpoints: the first one is exactly the acquisition event, so first-touch attribution and
      // `customers.first_channel_id` can never disagree. The rest are spread over the segments before each order,
      // which keeps them inside the 30-day attribution window that the metrics spec uses.
      touchpointRows.push([
        customerId,
        acquisitionChannelId,
        campaignIdByCode.get(plan.acquisitionCampaign.code),
        new Date(plan.acquiredAtMs).toISOString(),
        'click',
      ]);

      for (let touchIndex = 1; touchIndex < plan.touchpointCount; touchIndex += 1) {
        // 70 % of the *additional* touches stay in the acquisition channel; the first touch is always the
        // acquisition one by definition, so the overall share is naturally higher.
        const channelCode =
          random.next() < TOUCHPOINT_SHARE_OF_ACQUISITION_CHANNEL
            ? plan.channel.code
            : random.weighted(channelsOtherThanAcquisition, (channel) => channel.customerShare).code;

        const segmentIndex = random.int(0, plan.orderTimesMs.length - 1);
        const segmentStartMs = segmentIndex === 0 ? plan.acquiredAtMs : plan.orderTimesMs[segmentIndex - 1];
        const segmentEndMs = plan.orderTimesMs[segmentIndex];
        const usableMs = segmentEndMs - segmentStartMs;
        const occurredAtMs = usableMs > 2 * 60_000
          ? segmentStartMs + random.int(60_000, usableMs - 60_000)
          : segmentStartMs + Math.floor(usableMs / 2);

        touchpointRows.push([
          customerId,
          channelIdByCode.get(channelCode),
          campaignIdByCode.get(campaignAt(channelCode, occurredAtMs).code),
          new Date(occurredAtMs).toISOString(),
          'click',
        ]);
      }
    }

    // Daily stats: one row per campaign per active day from the period start (or launch) through the anchor (or the
    // campaign's end). Paid channels derive impressions from spend and a per-campaign CPM, so the funnel stays
    // coherent; owned/earned channels have no spend but do have organic impressions, which is the free-channel case
    // the metrics spec defines.
    /** @type {Array<Array<unknown>>} */
    const dailyStatRows = [];
    let totalSpendCents = 0;

    for (const campaign of campaignPlan) {
      const channel = channelByCode.get(campaign.channelCode);
      const campaignId = campaignIdByCode.get(campaign.code);
      const windowStart = campaign.startedOn;
      const windowEnd = campaign.endedOn ?? anchor;
      const windowDays = daysBetween(windowStart, windowEnd) + 1;
      const dailyBudgetCents = Math.round((campaign.budgetByn * 100) / windowDays);
      // A per-campaign CPM jitter keeps the four campaigns of one channel from moving in lockstep.
      const cpmCents = channel.cpmCents ? Math.round(channel.cpmCents * (0.85 + random.next() * 0.3)) : null;
      const tiktokDeclineStart = addDays(anchor, -60);

      for (let dayIndex = 0; dayIndex < windowDays; dayIndex += 1) {
        const statDate = addDays(windowStart, dayIndex);
        const weekday = new Date(dayUtcMs(statDate)).getUTCDay();
        const month = Number(statDate.slice(5, 7));
        const seasonality = month === 12 ? 1.25 : month === 7 || month === 8 ? 0.85 : 1;
        const noise = 0.85 + random.next() * 0.3;
        // TikTok degrades in the last two months: the same reach costs 30 % more. Media spend (inventory) stays
        // at the baseline while cash spend grows, so leads are unchanged and CAC rises by ~30 % — deriving
        // impressions from the inflated amount would have cancelled the degradation out.
        const degradation = channel.code === 'tiktok' && statDate >= tiktokDeclineStart ? 1.3 : 1;
        const mediaSpendCents = cpmCents
          ? Math.round(dailyBudgetCents * seasonality * WEEK_PROFILE[weekday] * noise)
          : 0;
        const spendCents = Math.round(mediaSpendCents * degradation);

        let impressions;
        if (cpmCents) {
          impressions = Math.max(0, Math.round((mediaSpendCents / cpmCents) * 1000));
        } else {
          const [minImpressions, maxImpressions] = channel.organicImpressionsPerDay;
          // SEO grows organically across the window; email stays flat.
          const growth = channel.code === 'seo' ? 0.55 + 0.9 * (dayIndex / Math.max(1, windowDays - 1)) : 1;
          impressions = Math.round(random.int(minImpressions, maxImpressions) * growth);
        }

        // CTR 1–4 % and CR 2–8 % guarantee impressions ≥ clicks ≥ leads even for single-digit traffic.
        const clicks = Math.round(impressions * (0.01 + random.next() * 0.03));
        const leads = Math.round(clicks * (0.02 + random.next() * 0.06));

        dailyStatRows.push([campaignId, statDate, impressions, clicks, leads, spendCents]);
        totalSpendCents += spendCents;
      }
    }

    await insertBatches(
      client,
      'orders',
      ['external_id', 'customer_id', 'campaign_id', 'occurred_at', 'revenue_cents', 'margin_cents'],
      orderRows,
    );
    await insertBatches(
      client,
      'touchpoints',
      ['customer_id', 'channel_id', 'campaign_id', 'occurred_at', 'kind'],
      touchpointRows,
    );
    await insertBatches(
      client,
      'daily_stats',
      ['campaign_id', 'stat_date', 'impressions', 'clicks', 'leads', 'spend_cents'],
      dailyStatRows,
    );

    // Company-wide goals for the last 12 months, owned by the admin account: CAC 50 BYN, ROMI 120 %,
    // LTV:CAC 3 and a 12-month payback.
    await insertBatches(
      client,
      'goals',
      ['metric', 'channel_id', 'target_value', 'period_start', 'period_end', 'created_by'],
      [
        ['cac', null, 50, goalPeriodStart, anchor, adminId],
        ['romi', null, 120, goalPeriodStart, anchor, adminId],
        ['ltv_cac', null, 3, goalPeriodStart, anchor, adminId],
        ['payback', null, 12, goalPeriodStart, anchor, adminId],
      ],
    );

    await client.query('COMMIT');

    return {
      users: DEMO_USERS.length,
      channels: CHANNELS.length,
      campaigns: campaignPlan.length,
      customers: customerPlans.length,
      orders: orderRows.length,
      touchpoints: touchpointRows.length,
      dailyStats: dailyStatRows.length,
      goals: 4,
      anchorDate: anchor,
      periodStart,
      totalSpendCents,
      totalRevenueCents,
    };
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (client) client.release();
    if (!providedPool) await seedPool.end();
  }
}

// CLI entry point (`npm run seed`). Guarded so importing the module in tests never touches the development database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const summary = await seed();
    logger.info(
      `seeded anchor ${summary.anchorDate}, window ${summary.periodStart}..${summary.anchorDate}: ` +
        `${summary.channels} channels, ${summary.campaigns} campaigns, ${summary.customers} customers, ` +
        `${summary.orders} orders, ${summary.touchpoints} touchpoints, ${summary.dailyStats} daily stat rows, ` +
        `${summary.goals} goals; spend ${formatByn(summary.totalSpendCents)} BYN, ` +
        `revenue ${formatByn(summary.totalRevenueCents)} BYN`,
    );
    // Credentials are documented in README; the password itself is never printed (AGENTS.md §9).
    logger.info('demo logins ready: admin@metrika.by, analyst@metrika.by, viewer@metrika.by');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'demo seed failed');
    process.exit(1);
  }
}
