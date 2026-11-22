import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../../db/seed/seed.js';
import { createCohortsRepository } from '../../src/repositories/cohorts.repo.js';
import { createLtvService } from '../../src/services/metrics/ltv.service.js';
import { closeTestPool, getTestPool, resetTestDatabase } from '../helpers/db.js';

/**
 * Fixed anchor instead of "yesterday": the deterministic seed then produces fixed cohort sizes and margins, so the
 * assertions below are golden numbers rather than a mirror of the implementation. At this anchor the seed covers
 * 2025-10 … 2026-11 (14 months); only the two oldest cohorts have a full 12-month horizon.
 */
const ANCHOR = '2026-11-21';
const HORIZON = 12;

/** @type {import('pg').Pool} */
let pool;
/** @type {ReturnType<typeof createCohortsRepository>} */
let cohortsRepository;
/** @type {ReturnType<typeof createLtvService>} */
let ltvService;

beforeAll(async () => {
  await resetTestDatabase();
  await seed({ anchorDate: ANCHOR });
  pool = getTestPool();
  cohortsRepository = createCohortsRepository(pool);
  ltvService = createLtvService({ cohortsRepository });
});

afterAll(async () => {
  await closeTestPool();
});

describe('cohort LTV against the seeded stand', () => {
  it('assigns every customer to exactly one Minsk cohort month', async () => {
    const report = await ltvService.getCohortMatrix({ anchor: ANCHOR, horizonMonths: HORIZON });

    expect(report.anchor).toBe(ANCHOR);
    expect(report.horizonMonths).toBe(HORIZON);
    expect(report.cohorts).toHaveLength(14);
    expect(report.cohorts.reduce((sum, cohort) => sum + cohort.cohortSize, 0)).toBe(4000);
    expect(report.cohorts[0]).toMatchObject({
      cohortMonth: '2025-10-01',
      cohortLabel: 'окт 2025',
      cohortSize: 292,
    });
    expect(report.cohorts.at(-1)).toMatchObject({
      cohortMonth: '2026-11-01',
      cohortLabel: 'ноя 2026',
      cohortSize: 179,
    });
  });

  it('reports the completed twelve-month cohort from the seeded margins', async () => {
    const report = await ltvService.getCohortMatrix({ anchor: ANCHOR, horizonMonths: HORIZON });
    const october = report.cohorts.find((cohort) => cohort.cohortMonth === '2025-10-01');
    const november = report.cohorts.find((cohort) => cohort.cohortMonth === '2025-11-01');
    const december = report.cohorts.find((cohort) => cohort.cohortMonth === '2025-12-01');

    // 4 178 754 c of margin over 12 offsets / 292 customers = 14 310,8… → 14 311 c.
    expect(october).toMatchObject({
      cohortSize: 292,
      ltvCents: '14311',
      ltvLabel: '143,11',
      isComplete: true,
      monthsObserved: 12,
    });
    expect(october.cells).toHaveLength(12);
    expect(october.cells[0]).toEqual({ monthOffset: 0, retentionPct: 100, cumLtvCents: '5797' });
    // 90 active in month 1 / 292 = 30,82 %; cumulative (1 692 794 + 513 281) / 292 = 7 555,05 → 7 555 c.
    expect(october.cells[1]).toEqual({ monthOffset: 1, retentionPct: 30.82, cumLtvCents: '7555' });

    // 2025-11-01 + 12 months = 2026-11-01 ≤ anchor, so the cohort is complete even though the anchor is mid-month.
    expect(november).toMatchObject({ ltvCents: '14379', isComplete: true });
    // 2025-12-01 + 12 months = 2026-12-01 > anchor: partial data only.
    expect(december.isComplete).toBe(false);
    expect(report.excludedIncomplete).toHaveLength(12);
    expect(report.excludedIncomplete[0].cohortMonth).toBe('2025-12-01');
  });

  it('leaves not-yet-started cells empty for the newest partial cohort', async () => {
    const report = await ltvService.getCohortMatrix({ anchor: ANCHOR, horizonMonths: HORIZON });
    const newest = report.cohorts.at(-1);

    expect(newest.isComplete).toBe(false);
    expect(newest.monthsObserved).toBe(1);
    // 1 051 682 c in November / 179 customers = 5 875,3… → 5 875 c.
    expect(newest.cells[0]).toEqual({ monthOffset: 0, retentionPct: 100, cumLtvCents: '5875' });
    expect(newest.cells[1]).toEqual({ monthOffset: 1, retentionPct: null, cumLtvCents: null });
    expect(newest.cells[11]).toEqual({ monthOffset: 11, retentionPct: null, cumLtvCents: null });
  });

  it('weights channel LTV over both completed cohorts, including the oldest one', async () => {
    const report = await ltvService.getChannelLtv({ anchor: ANCHOR, horizonMonths: HORIZON });

    // Only 2025-10 and 2025-11 are complete at this anchor. A rolling `from = anchor - 12 months` (2025-11-21)
    // would drop 2025-10 and change every channel number.
    expect(report.rows.map(({ channelCode, ltvCents, customerCount, cohortCount, status }) => ({
      channelCode,
      ltvCents,
      customerCount,
      cohortCount,
      status,
    }))).toEqual([
      { channelCode: 'bloggers', ltvCents: '13780', customerCount: 23, cohortCount: 2, status: 'ok' },
      { channelCode: 'email', ltvCents: '12871', customerCount: 50, cohortCount: 2, status: 'ok' },
      { channelCode: 'google', ltvCents: '14102', customerCount: 103, cohortCount: 2, status: 'ok' },
      { channelCode: 'instagram', ltvCents: '14903', customerCount: 131, cohortCount: 2, status: 'ok' },
      { channelCode: 'seo', ltvCents: '14796', customerCount: 61, cohortCount: 2, status: 'ok' },
      { channelCode: 'telegram', ltvCents: '15772', customerCount: 54, cohortCount: 2, status: 'ok' },
      { channelCode: 'tiktok', ltvCents: '13519', customerCount: 69, cohortCount: 2, status: 'ok' },
      { channelCode: 'yandex', ltvCents: '14249', customerCount: 94, cohortCount: 2, status: 'ok' },
    ]);
    // 8 391 791 c / 585 customers = 14 345,3… → 14 345 c.
    expect(report.blended).toEqual({
      ltvCents: '14345',
      customerCount: 585,
      cohortCount: 2,
      status: 'ok',
    });
  });

  it('keeps horizons independent on the same data', async () => {
    const ltv3 = await ltvService.getCohortMatrix({ anchor: ANCHOR, horizonMonths: 3 });
    const ltv12 = await ltvService.getCohortMatrix({ anchor: ANCHOR, horizonMonths: HORIZON });

    const october3 = ltv3.cohorts.find((cohort) => cohort.cohortMonth === '2025-10-01');
    const october12 = ltv12.cohorts.find((cohort) => cohort.cohortMonth === '2025-10-01');

    // (1 692 794 + 513 281 + 521 014) / 292 = 9 339,3… → 9 339 c, less than LTV12.
    expect(october3.cells).toHaveLength(3);
    expect(october3.cells.at(-1).cumLtvCents).toBe('9339');
    expect(october3.ltvCents).toBe('9339');
    expect(october12.ltvCents).toBe('14311');
    expect(october3.ltvCents).not.toBe(october12.ltvCents);
  });

  it('returns bigint kopecks from the repository, never numeric decimals', async () => {
    const rows = await cohortsRepository.listCohortMonthlyMargins({
      fromCohortMonth: '2025-10-01',
      toCohortMonth: '2025-11-01',
      channelId: null,
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.marginCents).toBe('bigint');
      expect(Number.isInteger(row.monthOffset)).toBe(true);
      expect(row.monthOffset).toBeGreaterThanOrEqual(0);
      expect(row.activeCustomers).toBeGreaterThan(0);
    }
  });

  it('has no NaN or Infinity in the serialised report', async () => {
    const report = await ltvService.getCohortMatrix({ anchor: ANCHOR, horizonMonths: HORIZON });

    expect(JSON.stringify(report)).not.toMatch(/NaN|Infinity/);
  });
});

describe('Minsk month boundaries', () => {
  it('puts a 00:30 first-of-month order into the new cohort and month offset', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: channels } = await client.query(
        `INSERT INTO channels (code, name, kind) VALUES ('tz_probe', 'Проверка часового пояса', 'paid')
         RETURNING id::text AS id`,
      );
      const channelId = channels[0].id;

      /**
       * @param {string} externalId
       * @param {string} firstOrderAt
       * @returns {Promise<string>}
       */
      async function insertCustomer(externalId, firstOrderAt) {
        const { rows } = await client.query(
          `INSERT INTO customers (external_id, first_channel_id, acquired_at, first_order_at)
           VALUES ($1, $2, ($3::timestamptz - interval '1 day'), $3::timestamptz)
           RETURNING id::text AS id`,
          [externalId, channelId, firstOrderAt],
        );
        return rows[0].id;
      }

      /**
       * @param {string} externalId
       * @param {string} customerId
       * @param {string} occurredAt
       * @param {number} marginCents
       */
      async function insertOrder(externalId, customerId, occurredAt, marginCents) {
        await client.query(
          `INSERT INTO orders (external_id, customer_id, occurred_at, revenue_cents, margin_cents)
           VALUES ($1, $2, $3::timestamptz, $4::bigint, $4::bigint)`,
          [externalId, customerId, occurredAt, marginCents],
        );
      }

      // The same instant in UTC differs between these first two customers: only the Minsk bucket separates them.
      const a = await insertCustomer('tz_a', '2026-02-01T00:30:00+03:00');
      const b = await insertCustomer('tz_b', '2026-02-01T03:30:00+03:00');
      const c = await insertCustomer('tz_c', '2026-01-31T23:59:00+03:00');

      await insertOrder('tz_a_1', a, '2026-02-01T00:30:00+03:00', 1000);
      await insertOrder('tz_a_2', a, '2026-02-28T23:59:00+03:00', 7000);
      // 2026-03-01T00:30+03:00 is 2026-02-28T21:30Z: a naive UTC grouping would keep it in offset 0.
      await insertOrder('tz_a_3', a, '2026-03-01T00:30:00+03:00', 5000);
      await insertOrder('tz_b_1', b, '2026-02-01T03:30:00+03:00', 2000);
      await insertOrder('tz_c_1', c, '2026-01-31T23:59:00+03:00', 3000);

      const scopedRepository = createCohortsRepository(client);
      const sizes = await scopedRepository.listCohortSizes({
        fromCohortMonth: '2026-01-01',
        toCohortMonth: '2026-02-01',
        channelId,
      });
      expect(sizes).toEqual([
        { cohortMonth: '2026-01-01', channelId, channelCode: 'tz_probe', cohortSize: 1 },
        { cohortMonth: '2026-02-01', channelId, channelCode: 'tz_probe', cohortSize: 2 },
      ]);

      const margins = await scopedRepository.listCohortMonthlyMargins({
        fromCohortMonth: '2026-01-01',
        toCohortMonth: '2026-02-01',
        channelId,
      });
      expect(margins).toEqual([
        { cohortMonth: '2026-01-01', channelId, monthOffset: 0, activeCustomers: 1, marginCents: 3000n },
        { cohortMonth: '2026-02-01', channelId, monthOffset: 0, activeCustomers: 2, marginCents: 10000n },
        { cohortMonth: '2026-02-01', channelId, monthOffset: 1, activeCustomers: 1, marginCents: 5000n },
      ]);

      const scopedService = createLtvService({ cohortsRepository: scopedRepository });
      const report = await scopedService.getCohortMatrix({
        anchor: ANCHOR,
        horizonMonths: HORIZON,
        fromCohortMonth: '2026-01-01',
        toCohortMonth: '2026-02-01',
        channelId,
      });

      expect(report.cohorts.map(({ cohortMonth, cohortSize }) => ({ cohortMonth, cohortSize }))).toEqual([
        { cohortMonth: '2026-01-01', cohortSize: 1 },
        { cohortMonth: '2026-02-01', cohortSize: 2 },
      ]);
      expect(report.cohorts[1].cells[0]).toEqual({ monthOffset: 0, retentionPct: 100, cumLtvCents: '5000' });
      expect(report.cohorts[1].cells[1]).toEqual({ monthOffset: 1, retentionPct: 50, cumLtvCents: '7500' });
    } finally {
      // The probe rows must never leak into the golden assertions above: they would shift channel averages.
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
