import { describe, expect, it } from 'vitest';
import { addDays, isoWeekStart } from '../../src/lib/dates.js';
import { ValidationError } from '../../src/lib/errors.js';
import { evaluateChannelAlerts, resolveAlertWindows } from '../../src/services/decisions/alerts.service.js';

/** High enough revenue that ROMI rules stay silent unless a test sets the revenue explicitly. */
const SAFE_REVENUE_CENTS = 1_000_000n;

/**
 * @param {{
 *   spendCents?: bigint,
 *   newCustomers?: number,
 *   revenueCents?: bigint,
 * }} [values]
 * @returns {{ spendCents: bigint, newCustomers: number, revenueCents: bigint }}
 */
function window({ spendCents = 1000n, newCustomers = 10, revenueCents = SAFE_REVENUE_CENTS } = {}) {
  return { spendCents, newCustomers, revenueCents };
}

/**
 * @param {Array<{ rule: string, severity: string }>} candidates
 * @returns {string[]} Rule names in a stable order, so a test can assert the set without depending on insertion order.
 */
function ruleNames(candidates) {
  return candidates.map((candidate) => candidate.rule).sort();
}

describe('resolveAlertWindows', () => {
  it('closes 4 complete weeks on Sunday and places the previous window right before it', () => {
    const windows = resolveAlertWindows('2026-11-22');

    expect(windows).toEqual({
      anchor: '2026-11-22',
      weeks: 4,
      now: { from: '2026-10-26', to: '2026-11-22', periodStart: '2026-10-26' },
      prev: { from: '2026-09-28', to: '2026-10-25' },
    });
    // Both windows are exactly four Monday–Sunday weeks; a 27-day span is 4 × 7 days minus the inclusive end.
    expect(addDays(windows.now.from, 27)).toBe(windows.now.to);
    expect(addDays(windows.prev.from, 27)).toBe(windows.prev.to);
    expect(isoWeekStart(windows.now.from)).toBe(windows.now.from);
    expect(isoWeekStart(windows.prev.from)).toBe(windows.prev.from);
  });

  it('keeps the same window when the anchor is the Monday that starts a running week', () => {
    const sunday = resolveAlertWindows('2026-11-22');
    const monday = resolveAlertWindows('2026-11-23');

    expect(monday.now).toEqual(sunday.now);
    expect(monday.prev).toEqual(sunday.prev);
    // The running week 2026-11-23..2026-11-29 is not observed yet and must not widen the window.
    expect(monday.now.to).toBe('2026-11-22');
  });

  it('drops the running week when the anchor is an arbitrary Wednesday', () => {
    const wednesday = resolveAlertWindows('2026-11-25');

    expect(wednesday.now).toEqual({
      from: '2026-10-26',
      to: '2026-11-22',
      periodStart: '2026-10-26',
    });
    expect(wednesday.now.to).toBe('2026-11-22');
  });

  it('rejects a week count the shared resolver cannot build', () => {
    expect(() => resolveAlertWindows('2026-11-22', 0)).toThrow(ValidationError);
    expect(() => resolveAlertWindows('2026-11-22', 53)).toThrow(ValidationError);
  });
});

describe('evaluateChannelAlerts cac_spike', () => {
  function evaluateCac(nowSpendCents) {
    return evaluateChannelAlerts({
      now: window({ spendCents: nowSpendCents, newCustomers: 10 }),
      prev: window({ spendCents: 1000n, newCustomers: 10 }),
    });
  }

  it('does not fire at exactly 1.2× because the comparison is strict', () => {
    expect(evaluateCac(1200n)).toEqual([]);
  });

  it('fires a warning one kopeck above 1.2× and explains the 1.2× threshold', () => {
    expect(evaluateCac(1201n)).toEqual([
      { rule: 'cac_spike', severity: 'warning', value: '1.2010', threshold: '1.2000' },
    ]);
  });

  it('stays a warning at exactly 1.5× because critical is strict too', () => {
    expect(evaluateCac(1500n)).toEqual([
      { rule: 'cac_spike', severity: 'warning', value: '1.5000', threshold: '1.2000' },
    ]);
  });

  it('upgrades the single row to critical one kopeck above 1.5× and rewrites the threshold', () => {
    const candidates = evaluateCac(1501n);

    // One candidate, not a warning plus a critical: the row's severity and threshold move together.
    expect(candidates).toEqual([
      { rule: 'cac_spike', severity: 'critical', value: '1.5010', threshold: '1.5000' },
    ]);
  });
});

describe('evaluateChannelAlerts romi rules', () => {
  const PREV = window({ spendCents: 10_000n, newCustomers: 10 });

  it('does not fire romi_below_target at exactly the target', () => {
    const candidates = evaluateChannelAlerts({
      now: window({ spendCents: 10_000n, newCustomers: 10, revenueCents: 12_000n }),
      prev: PREV,
      targetRomiPct: '20.00',
    });

    expect(candidates).toEqual([]);
  });

  it('fires romi_below_target one hundredth of a percent below the target', () => {
    const candidates = evaluateChannelAlerts({
      now: window({ spendCents: 10_000n, newCustomers: 10, revenueCents: 11_999n }),
      prev: PREV,
      targetRomiPct: '20.00',
    });

    expect(candidates).toEqual([
      { rule: 'romi_below_target', severity: 'warning', value: '19.9900', threshold: '20.0000' },
    ]);
  });

  it('does not treat ROMI equal to zero as negative', () => {
    const candidates = evaluateChannelAlerts({
      now: window({ spendCents: 10_000n, newCustomers: 10, revenueCents: 10_000n }),
      prev: PREV,
    });

    expect(candidates).toEqual([]);
  });

  it('fires romi_negative at −0.01%', () => {
    const candidates = evaluateChannelAlerts({
      now: window({ spendCents: 10_000n, newCustomers: 10, revenueCents: 9_999n }),
      prev: PREV,
    });

    expect(candidates).toEqual([
      { rule: 'romi_negative', severity: 'critical', value: '-0.0100', threshold: '0.0000' },
    ]);
  });

  it('skips romi_below_target when the channel has no target', () => {
    const candidates = evaluateChannelAlerts({
      now: window({ spendCents: 10_000n, newCustomers: 10, revenueCents: 10_500n }),
      prev: PREV,
    });

    expect(candidates).toEqual([]);
  });

  it('reads the channel target when the explicit target is omitted', () => {
    const candidates = evaluateChannelAlerts({
      channel: { targetRomiPct: '20.00' },
      now: window({ spendCents: 10_000n, newCustomers: 10, revenueCents: 11_999n }),
      prev: PREV,
    });

    expect(candidates).toEqual([
      { rule: 'romi_below_target', severity: 'warning', value: '19.9900', threshold: '20.0000' },
    ]);
  });
});

describe('evaluateChannelAlerts payback and LTV:CAC', () => {
  it('does not fire at payback of exactly 12 months', () => {
    const candidateWindows = {
      now: window({ spendCents: 1200n, newCustomers: 12 }),
      prev: window({ spendCents: 1200n, newCustomers: 12 }),
    };

    expect(evaluateChannelAlerts({ ...candidateWindows, ltv12Cents: 100n })).toEqual([]);
  });

  it('fires payback_long at 12.01 months with the twelve-month threshold', () => {
    const candidates = evaluateChannelAlerts({
      // 1201 × 12 / (12 × 100) = 12.01 months exactly.
      now: window({ spendCents: 1201n, newCustomers: 12 }),
      prev: window({ spendCents: 1201n, newCustomers: 12 }),
      ltv12Cents: 100n,
    });

    expect(candidates.find((candidate) => candidate.rule === 'payback_long')).toEqual({
      rule: 'payback_long',
      severity: 'warning',
      value: '12.0100',
      threshold: '12.0000',
    });
    // 12.01 months is LTV:CAC = 0.999, so the critical ratio rule fires consistently alongside it.
    expect(candidates.find((candidate) => candidate.rule === 'ltv_cac_low')).toMatchObject({
      severity: 'critical',
      value: '0.9992',
    });
  });

  it('skips both LTV rules when LTV is unknown', () => {
    const candidates = evaluateChannelAlerts({
      now: window({ spendCents: 100_000n, newCustomers: 1 }),
      prev: window({ spendCents: 100_000n, newCustomers: 1 }),
      ltv12Cents: null,
    });

    expect(candidates).toEqual([]);
  });

  it('does not call zero LTV a payback problem but still flags a LTV:CAC below one', () => {
    const candidates = evaluateChannelAlerts({
      now: window({ spendCents: 1000n, newCustomers: 10 }),
      prev: window({ spendCents: 1000n, newCustomers: 10 }),
      ltv12Cents: 0n,
    });

    expect(candidates).toEqual([
      { rule: 'ltv_cac_low', severity: 'critical', value: '0.0000', threshold: '1.0000' },
    ]);
  });

  it('does not fire LTV:CAC at exactly one', () => {
    const candidates = evaluateChannelAlerts({
      now: window({ spendCents: 1200n, newCustomers: 12 }),
      prev: window({ spendCents: 1200n, newCustomers: 12 }),
      ltv12Cents: 100n,
    });

    expect(candidates).toEqual([]);
  });

  it('fires LTV:CAC below one with the raw ratio as the value', () => {
    const candidates = evaluateChannelAlerts({
      // 999 × 10 / 10 000 = 0.999.
      now: window({ spendCents: 10_000n, newCustomers: 10 }),
      prev: window({ spendCents: 10_000n, newCustomers: 10 }),
      ltv12Cents: 999n,
    });

    expect(candidates.find((candidate) => candidate.rule === 'ltv_cac_low')).toEqual({
      rule: 'ltv_cac_low',
      severity: 'critical',
      value: '0.9990',
      threshold: '1.0000',
    });
  });
});

describe('evaluateChannelAlerts guard', () => {
  const valid = {
    spendCents: 2000n,
    newCustomers: 10,
    revenueCents: 0n,
  };

  it.each([
    ['now spend', { now: { ...valid, spendCents: 0n }, prev: valid }],
    ['now customers', { now: { ...valid, newCustomers: 0 }, prev: valid }],
    ['previous spend', { now: valid, prev: { ...valid, spendCents: 0n } }],
    ['previous customers', { now: valid, prev: { ...valid, newCustomers: 0 } }],
  ])('returns no candidates when %s is zero in either window', (_label, input) => {
    expect(
      evaluateChannelAlerts({ ...input, ltv12Cents: 1n, targetRomiPct: '50.00' }),
    ).toEqual([]);
  });

  it('fires romi_negative for zero revenue while the guard is satisfied', () => {
    expect(
      evaluateChannelAlerts({
        now: { spendCents: 10_000n, newCustomers: 10, revenueCents: 0n },
        prev: window({ spendCents: 10_000n, newCustomers: 10 }),
      }),
    ).toEqual([
      { rule: 'romi_negative', severity: 'critical', value: '-100.0000', threshold: '0.0000' },
    ]);
  });

  it('lets a CAC spike and negative ROMI coexist', () => {
    const candidates = evaluateChannelAlerts({
      now: { spendCents: 1300n, newCustomers: 10, revenueCents: 0n },
      prev: window({ spendCents: 1000n, newCustomers: 10 }),
    });

    expect(ruleNames(candidates)).toEqual(['cac_spike', 'romi_negative']);
  });
});
