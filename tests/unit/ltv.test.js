import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../src/lib/errors.js';
import { createLtvService, computeCohortLtv } from '../../src/services/metrics/ltv.service.js';

/**
 * Builds the keyed margin map the service passes to `computeCohortLtv`. Keeping the fixture literal makes the
 * expected sums in the assertions readable: [monthOffset, activeCustomers, marginCents].
 * @param {Array<[number, number, bigint]>} rows
 * @returns {Map<number, { activeCustomers: number, marginCents: bigint }>}
 */
function marginsByOffset(rows) {
  return new Map(rows.map(([monthOffset, activeCustomers, marginCents]) => [monthOffset, { activeCustomers, marginCents }]));
}

const JANUARY = { cohortMonth: '2026-01-01', cohortSize: 120 };
/** 380 000 c in each of months 0–2 and 300 000 c in month 3; total 1 440 000 c. */
const JANUARY_MARGINS = marginsByOffset([
  [0, 120, 380000n],
  [1, 60, 380000n],
  [2, 40, 380000n],
  [3, 30, 300000n],
]);

const JUNE = { cohortMonth: '2025-06-01', cohortSize: 100 };
/** 50 000 c every month for a year; total 600 000 c. */
const JUNE_MARGINS = marginsByOffset(
  Array.from({ length: 12 }, (_, monthOffset) => [monthOffset, monthOffset === 0 ? 100 : 50, 50000n]),
);

describe('computeCohortLtv', () => {
  it('divides the twelve-month margin by the cohort size', () => {
    const result = computeCohortLtv({
      cohort: JANUARY,
      marginsByOffset: JANUARY_MARGINS,
      horizonMonths: 12,
      anchor: '2027-01-20',
    });

    expect(result).toEqual({ ltvCents: 12000n, isComplete: true, monthsObserved: 12 });
  });

  it('sums only offsets below the horizon, so LTV3 differs from LTV12', () => {
    const ltv3 = computeCohortLtv({
      cohort: JANUARY,
      marginsByOffset: JANUARY_MARGINS,
      horizonMonths: 3,
      anchor: '2027-01-20',
    });
    const ltv6 = computeCohortLtv({
      cohort: JANUARY,
      marginsByOffset: JANUARY_MARGINS,
      horizonMonths: 6,
      anchor: '2027-01-20',
    });
    const ltv12 = computeCohortLtv({
      cohort: JANUARY,
      marginsByOffset: JANUARY_MARGINS,
      horizonMonths: 12,
      anchor: '2027-01-20',
    });

    // 1 140 000 c / 120 = 9 500 c; offset 3 (300 000 c) belongs to 6 and 12 months, not to 3.
    expect(ltv3.ltvCents).toBe(9500n);
    expect(ltv6.ltvCents).toBe(12000n);
    expect(ltv3.ltvCents).not.toBe(ltv12.ltvCents);
  });

  it('treats a cohort as complete only when the horizon end has been reached', () => {
    const options = { cohort: JANUARY, marginsByOffset: JANUARY_MARGINS, horizonMonths: 12 };

    expect(computeCohortLtv({ ...options, anchor: '2026-12-31' }).isComplete).toBe(false);
    // Exactly at the boundary: 2026-01-01 + 12 months = 2027-01-01.
    expect(computeCohortLtv({ ...options, anchor: '2027-01-01' }).isComplete).toBe(true);
  });

  it('counts the started months that have data and reports null when no margin exists', () => {
    const partial = computeCohortLtv({
      cohort: JANUARY,
      marginsByOffset: JANUARY_MARGINS,
      horizonMonths: 12,
      anchor: '2026-04-15',
    });
    expect(partial.isComplete).toBe(false);
    expect(partial.monthsObserved).toBe(4);

    const empty = computeCohortLtv({
      cohort: JANUARY,
      marginsByOffset: new Map(),
      horizonMonths: 12,
      anchor: '2027-01-20',
    });
    expect(empty.ltvCents).toBe(null);
    expect(empty.isComplete).toBe(true);
  });

  it('rejects invalid money, sizes and horizons instead of returning NaN', () => {
    const base = { cohort: JANUARY, marginsByOffset: JANUARY_MARGINS, horizonMonths: 12, anchor: '2027-01-20' };

    expect(() => computeCohortLtv({ ...base, cohort: { ...JANUARY, cohortSize: 0 } })).toThrow(TypeError);
    expect(() => computeCohortLtv({ ...base, horizonMonths: 0 })).toThrow(TypeError);
    expect(() => computeCohortLtv({ ...base, horizonMonths: 1.5 })).toThrow(TypeError);
    expect(() =>
      computeCohortLtv({
        ...base,
        marginsByOffset: new Map([[0, { activeCustomers: 1, marginCents: 10 }]]),
      }),
    ).toThrow(TypeError);
  });
});

/**
 * In-memory cohort repository that honours the documented filters. Filtering here (instead of returning every row
 * regardless of the request) makes a wrong `fromCohortMonth` visible as a wrong LTV, not just a wrong mock call.
 *
 * `withSnapshot` is a pass-through: these tests cover aggregation, while the repository unit test checks that the
 * real wrapper opens a repeatable-read transaction.
 *
 * @param {{
 *   sizes: Array<{ cohortMonth: string, channelId: string, channelCode: string, cohortSize: number }>,
 *   margins: Array<{
 *     cohortMonth: string, channelId: string, monthOffset: number,
 *     activeCustomers: number, marginCents: bigint,
 *   }>,
 *   channels?: Array<{ channelId: string, channelCode: string, isActive?: boolean }>,
 * }} rows
 */
function repositoryFixture({ sizes, margins, channels }) {
  /**
   * @param {{ fromCohortMonth?: string | null, toCohortMonth: string, channelId?: string | null }} filters
   * @param {{ cohortMonth: string, channelId: string }} row
   * @returns {boolean}
   */
  function matches(filters, row) {
    if (filters.fromCohortMonth && row.cohortMonth < filters.fromCohortMonth) return false;
    if (row.cohortMonth > filters.toCohortMonth) return false;
    if (filters.channelId && row.channelId !== filters.channelId) return false;
    return true;
  }

  const listCohortSizes = vi.fn(async (filters) => sizes.filter((row) => matches(filters, row)));
  const listCohortMonthlyMargins = vi.fn(async (filters) => margins.filter((row) => matches(filters, row)));

  const dimension = channels ?? [
    ...new Map(sizes.map((row) => [row.channelId, { channelId: row.channelId, channelCode: row.channelCode }])).values(),
  ];
  const listChannels = vi.fn(async ({ channelId = null } = {}) =>
    dimension
      .filter((channel) => channelId === null || channel.channelId === channelId)
      .map((channel) => ({ isActive: true, ...channel })),
  );

  const repository = {
    listCohortSizes,
    listCohortMonthlyMargins,
    listChannels,
    withSnapshot: (read) => read(repository),
  };
  return repository;
}

const JUNE_MARGINS_ROWS = Array.from({ length: 12 }, (_, monthOffset) => ({
  cohortMonth: '2025-06-01',
  channelId: '1',
  monthOffset,
  activeCustomers: monthOffset === 0 ? 100 : 50,
  marginCents: 50000n,
}));

const TWO_CHANNEL_COHORTS = {
  sizes: [
    { cohortMonth: '2025-06-01', channelId: '1', channelCode: 'instagram', cohortSize: 100 },
    { cohortMonth: '2026-01-01', channelId: '1', channelCode: 'instagram', cohortSize: 120 },
  ],
  margins: [
    ...JUNE_MARGINS_ROWS,
    ...[
      [0, 120, 380000n],
      [1, 60, 380000n],
      [2, 40, 380000n],
      [3, 30, 300000n],
    ].map(([monthOffset, activeCustomers, marginCents]) => ({
      cohortMonth: '2026-01-01',
      channelId: '1',
      monthOffset,
      activeCustomers,
      marginCents,
    })),
  ],
};

describe('createLtvService', () => {
  it('builds the retention matrix with cumulative LTV that includes the cell month', async () => {
    const repository = repositoryFixture(TWO_CHANNEL_COHORTS);
    const service = createLtvService({ cohortsRepository: repository });

    const report = await service.getCohortMatrix({ anchor: '2027-01-20', horizonMonths: 12 });

    expect(repository.listCohortSizes).toHaveBeenCalledWith({
      fromCohortMonth: null,
      toCohortMonth: '2027-01-01',
      channelId: null,
      anchor: '2027-01-20',
    });

    const january = report.cohorts.find((cohort) => cohort.cohortMonth === '2026-01-01');
    expect(january).toMatchObject({
      cohortLabel: 'янв 2026',
      cohortSize: 120,
      ltvCents: '12000',
      ltvLabel: '120,00',
      isComplete: true,
      monthsObserved: 12,
    });
    expect(january.cells).toHaveLength(12);
    expect(january.cells[0]).toEqual({ monthOffset: 0, retentionPct: 100, cumLtvCents: '3167' });
    expect(january.cells[1]).toEqual({ monthOffset: 1, retentionPct: 50, cumLtvCents: '6333' });
    expect(january.cells[2]).toEqual({ monthOffset: 2, retentionPct: 33.33, cumLtvCents: '9500' });
    // k = 3 includes offset 3, while LTV3 stops before it.
    expect(january.cells[3]).toEqual({ monthOffset: 3, retentionPct: 25, cumLtvCents: '12000' });
  });

  it('leaves cells for months that have not started empty rather than zero', async () => {
    const repository = repositoryFixture(TWO_CHANNEL_COHORTS);
    const service = createLtvService({ cohortsRepository: repository });

    const report = await service.getCohortMatrix({ anchor: '2026-04-15', horizonMonths: 12 });
    const january = report.cohorts.find((cohort) => cohort.cohortMonth === '2026-01-01');

    expect(january.isComplete).toBe(false);
    expect(january.monthsObserved).toBe(4);
    expect(january.cells[3]).toEqual({ monthOffset: 3, retentionPct: 25, cumLtvCents: '12000' });
    expect(january.cells[4]).toEqual({ monthOffset: 4, retentionPct: null, cumLtvCents: null });
    expect(january.cells[11]).toEqual({ monthOffset: 11, retentionPct: null, cumLtvCents: null });
  });

  it('weights channel LTV by cohort size across every completed cohort, not only the latest', async () => {
    const repository = repositoryFixture(TWO_CHANNEL_COHORTS);
    const service = createLtvService({ cohortsRepository: repository });

    const report = await service.getChannelLtv({ anchor: '2027-01-20', horizonMonths: 12 });

    // (600 000 + 1 440 000) / (100 + 120) = 9 272,7… → 9 273 c. Neither 6 000 c (old cohort only)
    // nor 12 000 c (latest cohort only).
    expect(report.rows).toEqual([
      {
        channelId: '1',
        channelCode: 'instagram',
        ltvCents: '9273',
        customerCount: 220,
        cohortCount: 2,
        status: 'ok',
      },
    ]);
    expect(report.blended).toEqual({
      ltvCents: '9273',
      customerCount: 220,
      cohortCount: 2,
      status: 'ok',
    });
    // The service must ask for the full history; `from = anchor - 12 months` would drop the 2025-06 cohort.
    expect(repository.listCohortSizes.mock.calls[0][0].fromCohortMonth).toBe(null);
    expect(repository.listChannels).toHaveBeenCalledWith({ channelId: null });
  });

  it('keeps incomplete cohorts out of channel averages but inside the matrix', async () => {
    const repository = repositoryFixture({
      sizes: [
        ...TWO_CHANNEL_COHORTS.sizes,
        { cohortMonth: '2026-09-01', channelId: '1', channelCode: 'instagram', cohortSize: 50 },
      ],
      margins: [
        ...TWO_CHANNEL_COHORTS.margins,
        {
          cohortMonth: '2026-09-01',
          channelId: '1',
          monthOffset: 0,
          activeCustomers: 50,
          marginCents: 100000n,
        },
      ],
    });
    const service = createLtvService({ cohortsRepository: repository });

    const report = await service.getCohortMatrix({ anchor: '2026-12-31', horizonMonths: 12 });

    expect(report.cohorts.map((cohort) => [cohort.cohortMonth, cohort.isComplete])).toEqual([
      ['2025-06-01', true],
      ['2026-01-01', false],
      ['2026-09-01', false],
    ]);
    expect(report.channelLtv).toEqual([
      {
        channelId: '1',
        channelCode: 'instagram',
        ltvCents: '6000',
        customerCount: 100,
        cohortCount: 1,
        status: 'ok',
      },
    ]);
    expect(report.excludedIncomplete.map((cohort) => cohort.cohortMonth)).toEqual(['2026-01-01', '2026-09-01']);
    expect(report.excludedIncomplete[0]).toMatchObject({
      cohortMonth: '2026-01-01',
      cohortLabel: 'янв 2026',
      cohortSize: 120,
      isComplete: false,
      monthsObserved: 12,
    });
  });

  it('reports insufficient history instead of a zero LTV when nothing is complete', async () => {
    const repository = repositoryFixture({
      sizes: [{ cohortMonth: '2026-09-01', channelId: '1', channelCode: 'instagram', cohortSize: 50 }],
      margins: [
        {
          cohortMonth: '2026-09-01',
          channelId: '1',
          monthOffset: 0,
          activeCustomers: 50,
          marginCents: 100000n,
        },
      ],
    });
    const service = createLtvService({ cohortsRepository: repository });

    const report = await service.getChannelLtv({ anchor: '2026-12-31', horizonMonths: 12 });

    expect(report.rows[0]).toMatchObject({ ltvCents: null, customerCount: 0, cohortCount: 0, status: 'insufficient_history' });
    expect(report.blended).toEqual({
      ltvCents: null,
      customerCount: 0,
      cohortCount: 0,
      status: 'insufficient_history',
    });
  });

  it('omits empty cohorts and never leaks NaN into a serialised report', async () => {
    const emptyRepository = repositoryFixture({ sizes: [], margins: [] });
    const service = createLtvService({ cohortsRepository: emptyRepository });

    const report = await service.getCohortMatrix({ anchor: '2026-11-22', horizonMonths: 12 });

    expect(report.cohorts).toEqual([]);
    expect(report.channelLtv).toEqual([]);
    expect(report.excludedIncomplete).toEqual([]);
    expect(JSON.stringify(report)).not.toMatch(/NaN|Infinity/);

    const zeroSizeRepository = repositoryFixture({
      sizes: [{ cohortMonth: '2026-01-01', channelId: '1', channelCode: 'instagram', cohortSize: 0 }],
      margins: [],
    });
    const zeroSizeReport = await createLtvService({ cohortsRepository: zeroSizeRepository }).getCohortMatrix({
      anchor: '2026-11-22',
    });

    // N = 0 means the cohort does not exist; there is nothing to show or divide by.
    expect(zeroSizeReport.cohorts).toEqual([]);
  });

  it('keeps horizons independent and passes an explicit channel filter through', async () => {
    const repository = repositoryFixture(TWO_CHANNEL_COHORTS);
    const service = createLtvService({ cohortsRepository: repository });

    const matrix3 = await service.getCohortMatrix({ anchor: '2027-01-20', horizonMonths: 3, channelId: '1' });
    const matrix12 = await service.getCohortMatrix({ anchor: '2027-01-20', horizonMonths: 12, channelId: '1' });

    const january3 = matrix3.cohorts.find((cohort) => cohort.cohortMonth === '2026-01-01');
    const january12 = matrix12.cohorts.find((cohort) => cohort.cohortMonth === '2026-01-01');
    expect(january3.cells).toHaveLength(3);
    expect(january3.cells.at(-1).cumLtvCents).toBe('9500');
    expect(january12.cells.at(-1).cumLtvCents).toBe('12000');
    expect(repository.listCohortSizes.mock.calls.at(-1)[0].channelId).toBe('1');
    expect(repository.listCohortSizes.mock.calls.at(-1)[0].anchor).toBe('2027-01-20');
  });

  it('keeps a completed cohort with no margin rows in the denominator and null in the matrix', async () => {
    const repository = repositoryFixture({
      sizes: [
        { cohortMonth: '2025-06-01', channelId: '1', channelCode: 'instagram', cohortSize: 100 },
        { cohortMonth: '2025-07-01', channelId: '1', channelCode: 'instagram', cohortSize: 100 },
      ],
      margins: JUNE_MARGINS_ROWS,
    });
    const service = createLtvService({ cohortsRepository: repository });

    const channelReport = await service.getChannelLtv({ anchor: '2027-01-20', horizonMonths: 12 });

    // Spec §2: Σ margin / Σ N over completed cohorts. 600 000 / 200 = 3 000 c, not 6 000 c.
    expect(channelReport.rows[0]).toEqual({
      channelId: '1',
      channelCode: 'instagram',
      ltvCents: '3000',
      customerCount: 200,
      cohortCount: 2,
      status: 'ok',
    });
    expect(channelReport.blended).toEqual({
      ltvCents: '3000',
      customerCount: 200,
      cohortCount: 2,
      status: 'ok',
    });

    const report = await service.getCohortMatrix({ anchor: '2027-01-20', horizonMonths: 12 });
    const empty = report.cohorts.find((cohort) => cohort.cohortMonth === '2025-07-01');
    expect(empty).toMatchObject({ ltvCents: null, ltvLabel: '—', isComplete: true, monthsObserved: 12 });
    expect(empty.cells[0]).toEqual({ monthOffset: 0, retentionPct: 0, cumLtvCents: null });
    expect(report.excludedIncomplete).toEqual([]);
  });

  it('distinguishes a real zero margin from missing margin data', async () => {
    const repository = repositoryFixture({
      sizes: [
        { cohortMonth: '2026-01-01', channelId: '1', channelCode: 'instagram', cohortSize: 10 },
        { cohortMonth: '2026-02-01', channelId: '1', channelCode: 'instagram', cohortSize: 10 },
      ],
      margins: [
        { cohortMonth: '2026-01-01', channelId: '1', monthOffset: 0, activeCustomers: 10, marginCents: 0n },
      ],
    });
    const service = createLtvService({ cohortsRepository: repository });

    const report = await service.getCohortMatrix({ anchor: '2027-01-20', horizonMonths: 12 });
    const zero = report.cohorts.find((cohort) => cohort.cohortMonth === '2026-01-01');
    const missing = report.cohorts.find((cohort) => cohort.cohortMonth === '2026-02-01');

    expect(zero).toMatchObject({ ltvCents: '0', ltvLabel: '0,00' });
    expect(zero.cells[0]).toEqual({ monthOffset: 0, retentionPct: 100, cumLtvCents: '0' });
    expect(missing).toMatchObject({ ltvCents: null, ltvLabel: '—' });
    expect(missing.cells[0]).toEqual({ monthOffset: 0, retentionPct: 0, cumLtvCents: null });
  });

  it('returns channels without customers so cac rows can be left-joined', async () => {
    const repository = repositoryFixture({
      ...TWO_CHANNEL_COHORTS,
      channels: [
        { channelId: '1', channelCode: 'instagram', isActive: true },
        // Archived channel with spend but no customers: still part of the historical LTV report.
        { channelId: '9', channelCode: 'spend_only', isActive: false },
      ],
    });
    const service = createLtvService({ cohortsRepository: repository });

    const report = await service.getChannelLtv({ anchor: '2027-01-20', horizonMonths: 12 });

    expect(report.rows).toEqual([
      {
        channelId: '1',
        channelCode: 'instagram',
        ltvCents: '9273',
        customerCount: 220,
        cohortCount: 2,
        status: 'ok',
      },
      {
        channelId: '9',
        channelCode: 'spend_only',
        ltvCents: null,
        customerCount: 0,
        cohortCount: 0,
        status: 'insufficient_history',
      },
    ]);
    expect(report.blended.customerCount).toBe(220);

    const matrix = await service.getCohortMatrix({ anchor: '2027-01-20', horizonMonths: 12 });
    expect(matrix.channelLtv).toEqual(report.rows);
  });

  it('rejects invalid anchors, horizons, months and channel ids', async () => {
    const service = createLtvService({ cohortsRepository: repositoryFixture(TWO_CHANNEL_COHORTS) });

    await expect(service.getCohortMatrix({ anchor: '2026-02-30' })).rejects.toThrow(ValidationError);
    await expect(service.getCohortMatrix({ anchor: '2026-11-22', horizonMonths: 0 })).rejects.toThrow(ValidationError);
    await expect(service.getCohortMatrix({ anchor: '2026-11-22', horizonMonths: 1.5 })).rejects.toThrow(
      ValidationError,
    );
    await expect(service.getCohortMatrix({ anchor: '2026-11-22', channelId: 'abc' })).rejects.toThrow(ValidationError);
    await expect(
      service.getCohortMatrix({ anchor: '2026-11-22', fromCohortMonth: '2026-10-01', toCohortMonth: '2026-09-01' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      service.getCohortMatrix({ anchor: '2026-11-22', toCohortMonth: '2026-12-01' }),
    ).rejects.toThrow(ValidationError);
    await expect(service.getChannelLtv({})).rejects.toThrow(ValidationError);
  });
});
