import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../src/lib/errors.js';
import { createGoalsProgressService } from '../../src/services/metrics/goals-progress.service.js';

const ANCHOR = '2026-11-21';
/** A short reporting period. Only goals that start and end exactly here are comparable with the fact. */
const PERIOD = { from: '2026-10-23', to: '2026-11-21' };
const OTHER_PERIOD = { from: '2026-10-24', to: '2026-11-21' };

/** Blended health row used as the company-wide fact source. */
const BLENDED = {
  code: 'blended',
  name: 'Все каналы',
  spendCents: '1150770',
  revenueCents: '9356994',
  newCustomers: 10,
  cacCents: '6000',
  cacLabel: '60,00',
  ltv12Cents: '14345',
  ltvLabel: '143,45',
  romiPct: 100,
  romiLabel: '100,0%',
  paybackMonths: 3.5,
  paybackLabel: '3,5 мес.',
  ltvCacRatio: 3.4,
  ratioLabel: '3,400',
  status: 'healthy',
  statusLabel: 'В норме',
};

/** A per-channel health row, used by the channel-scoped goal. */
const CHANNEL_ROW = {
  ...BLENDED,
  channelId: '7',
  code: 'instagram',
  name: 'Instagram',
  newCustomers: 12,
  cacCents: '7000',
  cacLabel: '70,00',
  romiPct: 80,
  romiLabel: '80,0%',
  ltvCacRatio: 2.5,
  ratioLabel: '2,500',
};

/**
 * @param {unknown} value
 * @returns {boolean} True when a `bigint` sits anywhere in the value.
 */
function hasBigInt(value) {
  if (typeof value === 'bigint') return true;
  if (Array.isArray(value)) return value.some(hasBigInt);
  if (value !== null && typeof value === 'object') return Object.values(value).some(hasBigInt);
  return false;
}

/**
 * @param {object} [overrides]
 * @returns {{
 *   service: ReturnType<typeof createGoalsProgressService>,
 *   goalsRepository: object,
 *   healthService: object,
 * }}
 */
function serviceWith({
  goals = [
    { id: '1', metric: 'cac', channelId: null, targetValue: '50,00', periodStart: PERIOD.from, periodEnd: PERIOD.to, channelName: null, channelCode: null },
    { id: '2', metric: 'romi', channelId: null, targetValue: '120.00', periodStart: PERIOD.from, periodEnd: PERIOD.to, channelName: null, channelCode: null },
    { id: '3', metric: 'ltv_cac', channelId: null, targetValue: '3.00', periodStart: PERIOD.from, periodEnd: PERIOD.to, channelName: null, channelCode: null },
    { id: '4', metric: 'payback', channelId: null, targetValue: '12.00', periodStart: PERIOD.from, periodEnd: PERIOD.to, channelName: null, channelCode: null },
    { id: '5', metric: 'new_customers', channelId: null, targetValue: '20.00', periodStart: PERIOD.from, periodEnd: PERIOD.to, channelName: null, channelCode: null },
    { id: '6', metric: 'cac', channelId: '7', targetValue: '80.00', periodStart: PERIOD.from, periodEnd: PERIOD.to, channelName: 'Instagram', channelCode: 'instagram' },
    { id: '7', metric: 'cac', channelId: null, targetValue: '50.00', periodStart: OTHER_PERIOD.from, periodEnd: OTHER_PERIOD.to, channelName: null, channelCode: null },
  ],
  rows = [CHANNEL_ROW],
  blended = BLENDED,
} = {}) {
  const goalsRepository = { listGoals: vi.fn().mockResolvedValue(goals) };
  const healthService = {
    getChannelHealthReport: vi.fn().mockResolvedValue({ period: { ...PERIOD, days: 30 }, rows, blended }),
  };

  return {
    service: createGoalsProgressService({ goalsRepository, healthService }),
    goalsRepository,
    healthService,
  };
}

describe('goals progress', () => {
  it('parses a CAC target through the BYN parser and exposes kopecks as a string', async () => {
    const { service } = serviceWith();

    const { rows } = await service.getGoalsProgress({ anchor: ANCHOR, ...PERIOD });
    const cac = rows.find((row) => row.goalId === '1');

    // '50,00' is 5000 kopecks, not Number('50,00') = NaN and not 50.
    expect(cac.target).toEqual({ value: '5000', unit: 'cents', label: '50,00' });
    expect(typeof cac.target.value).toBe('string');
  });

  it('chooses the direction from the metric, not from the goal value', async () => {
    const { service } = serviceWith();

    const { rows } = await service.getGoalsProgress({ anchor: ANCHOR, ...PERIOD });
    const direction = Object.fromEntries(rows.map((row) => [row.metric, row.direction]));

    expect(direction).toEqual({
      cac: 'lower_is_better',
      romi: 'higher_is_better',
      ltv_cac: 'higher_is_better',
      payback: 'lower_is_better',
      new_customers: 'higher_is_better',
    });
  });

  it('compares the fact with the target per direction and labels the gap in the metric unit', async () => {
    const { service } = serviceWith();

    const { rows } = await service.getGoalsProgress({ anchor: ANCHOR, ...PERIOD });
    const byId = new Map(rows.map((row) => [row.goalId, row]));

    // CAC 60,00 against a 50,00 plan: 10,00 over plan is off track.
    expect(byId.get('1')).toMatchObject({
      status: 'off_track',
      fact: { value: '6000', unit: 'cents', label: '60,00' },
      deviation: { abs: '1000', pct: 20, label: '10,00' },
    });
    // ROMI 100 % against a 120 % plan: 20 points short is off track.
    expect(byId.get('2')).toMatchObject({
      status: 'off_track',
      fact: { value: 100, unit: 'percent', label: '100,0%' },
      deviation: { abs: 20, pct: -16.67, label: '20,0%' },
    });
    // LTV:CAC 3,4 against 3,0 is on track; the gap is negative because the fact exceeds the plan.
    expect(byId.get('3')).toMatchObject({
      status: 'on_track',
      deviation: { abs: -0.4, label: '−0,400' },
    });
    // Payback 3,5 months against 12 is on track; months must never be formatted as a percentage.
    expect(byId.get('4')).toMatchObject({
      status: 'on_track',
      target: { value: 12, unit: 'months', label: '12 мес.' },
      fact: { value: 3.5, unit: 'months', label: '3,5 мес.' },
    });
    expect(byId.get('4').deviation.label).toContain('мес.');
    expect(byId.get('4').deviation.label).not.toContain('%');
    // 10 new customers against a plan of 20 is off track.
    expect(byId.get('5')).toMatchObject({
      status: 'off_track',
      deviation: { abs: 10, label: '10' },
    });
  });

  it('uses the channel health row for a channel goal and the blended row for a company goal', async () => {
    const { service } = serviceWith();

    const { rows } = await service.getGoalsProgress({ anchor: ANCHOR, ...PERIOD });
    const channelGoal = rows.find((row) => row.goalId === '6');

    expect(channelGoal).toMatchObject({
      channelId: '7',
      channelLabel: 'Instagram',
      fact: { value: '7000', unit: 'cents', label: '70,00' },
      // 70,00 against 80,00: under the CAC plan is good.
      status: 'on_track',
      deviation: { abs: '-1000', label: '−10,00' },
    });
    expect(rows.find((row) => row.goalId === '1').channelLabel).toBe('Вся компания');
  });

  it('skips a goal whose period does not match the reporting period', async () => {
    const { service } = serviceWith();

    const { rows } = await service.getGoalsProgress({ anchor: ANCHOR, ...PERIOD });

    expect(rows.map((row) => row.goalId)).not.toContain('7');
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.goalPeriod).toEqual({ from: PERIOD.from, to: PERIOD.to });
      expect(row.factPeriod).toEqual({ from: PERIOD.from, to: PERIOD.to });
    }
  });

  it('reports no_data and a null gap when the fact is missing', async () => {
    const { service } = serviceWith({
      goals: [
        { id: '9', metric: 'romi', channelId: '777', targetValue: '120.00', periodStart: PERIOD.from, periodEnd: PERIOD.to, channelName: 'TikTok', channelCode: 'tiktok' },
      ],
    });

    const { rows } = await service.getGoalsProgress({ anchor: ANCHOR, ...PERIOD });

    expect(rows[0]).toMatchObject({
      status: 'no_data',
      channelLabel: 'TikTok',
      fact: { value: null, unit: 'percent', label: '—' },
      deviation: { abs: null, pct: null, label: '—' },
    });
  });

  it('reports no_data when the metric itself is undefined, keeping the real zero of a count metric', async () => {
    const { service } = serviceWith({
      blended: { ...BLENDED, romiPct: null, romiLabel: '—', newCustomers: 0 },
    });

    const { rows } = await service.getGoalsProgress({ anchor: ANCHOR, ...PERIOD });
    const byId = new Map(rows.map((row) => [row.goalId, row]));

    expect(byId.get('2')).toMatchObject({ status: 'no_data', fact: { value: null, label: '—' }, deviation: { abs: null } });
    // Zero customers is a measured zero, not a missing fact.
    expect(byId.get('5')).toMatchObject({
      status: 'off_track',
      fact: { value: 0, unit: 'count', label: '0' },
      deviation: { abs: 20 },
    });
  });

  it('fetches the health report exactly once for the whole goal list', async () => {
    const { service, healthService, goalsRepository } = serviceWith();

    await service.getGoalsProgress({ anchor: ANCHOR, ...PERIOD });

    expect(goalsRepository.listGoals).toHaveBeenCalledExactlyOnceWith({ metric: null });
    expect(healthService.getChannelHealthReport).toHaveBeenCalledExactlyOnceWith({
      anchor: ANCHOR,
      from: PERIOD.from,
      to: PERIOD.to,
    });
  });

  it('passes a metric filter to the repository and rejects an unknown metric without SQL', async () => {
    const { service, goalsRepository } = serviceWith();

    await service.getGoalsProgress({ anchor: ANCHOR, ...PERIOD, metric: 'cac' });
    expect(goalsRepository.listGoals).toHaveBeenCalledExactlyOnceWith({ metric: 'cac' });

    const fresh = serviceWith();
    await expect(
      fresh.service.getGoalsProgress({ anchor: ANCHOR, ...PERIOD, metric: 'magic' }),
    ).rejects.toThrow(ValidationError);
    expect(fresh.goalsRepository.listGoals).not.toHaveBeenCalled();
  });

  it('serialises without a bigint, NaN or Infinity', async () => {
    const { service } = serviceWith();

    const progress = await service.getGoalsProgress({ anchor: ANCHOR, ...PERIOD });

    expect(() => JSON.stringify(progress)).not.toThrow();
    expect(hasBigInt(progress)).toBe(false);
    expect(JSON.stringify(progress)).not.toMatch(/NaN|Infinity/);
  });
});
