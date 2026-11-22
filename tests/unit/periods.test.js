import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/lib/errors.js';
import { addDays, minskDayStart } from '../../src/lib/dates.js';
import { DEFAULT_PERIOD_DAYS, resolvePeriod } from '../../src/lib/periods.js';

describe('resolvePeriod', () => {
  it('defaults to the 30 inclusive days ending at the anchor', () => {
    expect(DEFAULT_PERIOD_DAYS).toBe(30);
    expect(resolvePeriod({ anchor: '2026-11-22' })).toEqual({
      from: '2026-10-24',
      to: '2026-11-22',
      days: 30,
    });
  });

  it('counts the requested number of calendar days inclusively', () => {
    for (const days of [30, 90, 180]) {
      const period = resolvePeriod({ anchor: '2026-11-22', days });
      expect(period.days).toBe(days);
      expect(addDays(period.from, period.days - 1)).toBe(period.to);
    }
  });

  it('keeps explicit bounds, with from alone running through the anchor', () => {
    expect(resolvePeriod({ anchor: '2026-11-22', from: '2026-01-01' })).toEqual({
      from: '2026-01-01',
      to: '2026-11-22',
      days: 326,
    });
    expect(resolvePeriod({ anchor: '2026-11-22', from: '2026-10-01', to: '2026-10-31' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      days: 31,
    });
  });

  it('clamps an explicit upper bound to the data anchor', () => {
    expect(resolvePeriod({ anchor: '2026-11-22', to: '2026-12-01' })).toEqual({
      from: '2026-10-24',
      to: '2026-11-22',
      days: 30,
    });
    expect(resolvePeriod({ anchor: '2026-11-22', from: '2026-10-01', to: '2026-12-01' })).toEqual({
      from: '2026-10-01',
      to: '2026-11-22',
      days: 53,
    });
  });

  it('rejects a reversed range', () => {
    expect(() => resolvePeriod({ anchor: '2026-11-22', from: '2026-11-23' })).toThrow(ValidationError);
    expect(() => resolvePeriod({ anchor: '2026-11-22', from: '2026-11-10', to: '2026-11-01' })).toThrow(
      ValidationError,
    );
  });

  it('rejects a missing anchor, an empty anchor and a non-positive day count', () => {
    expect(() => resolvePeriod({})).toThrow(ValidationError);
    expect(() => resolvePeriod({ anchor: null })).toThrow(ValidationError);
    expect(() => resolvePeriod({ anchor: '' })).toThrow(ValidationError);
    expect(() => resolvePeriod({ anchor: '2026-11-22', days: 0 })).toThrow(ValidationError);
    expect(() => resolvePeriod({ anchor: '2026-11-22', days: -7 })).toThrow(ValidationError);
    expect(() => resolvePeriod({ anchor: '2026-11-22', days: 1.5 })).toThrow(ValidationError);
  });
});

describe('Minsk day bounds', () => {
  it('starts 2026-11-22 at 21:00Z on 2026-11-21 (UTC+3)', () => {
    expect(minskDayStart('2026-11-22').toISOString()).toBe('2026-11-21T21:00:00.000Z');
  });
});
