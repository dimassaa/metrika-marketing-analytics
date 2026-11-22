import { describe, expect, it } from 'vitest';
import { addMonths } from '../../src/lib/dates.js';

describe('addMonths', () => {
  it('clamps the day to the last day of the target month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-08-31', -1)).toBe('2026-07-31');
  });

  it('crosses the year boundary in both directions', () => {
    expect(addMonths('2026-01-01', 12)).toBe('2027-01-01');
    expect(addMonths('2026-11-30', -2)).toBe('2026-09-30');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
  });

  it('keeps the day when it exists in the target month', () => {
    expect(addMonths('2026-03-31', 3)).toBe('2026-06-30');
    expect(addMonths('2026-01-01', 0)).toBe('2026-01-01');
  });

  it('rejects a non-integer month shift or a malformed date', () => {
    expect(() => addMonths('2026-01-31', 1.5)).toThrow(TypeError);
    expect(() => addMonths('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addMonths('31.01.2026', 1)).toThrow(TypeError);
  });
});
