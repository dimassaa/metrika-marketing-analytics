import { describe, expect, it } from 'vitest';
import { formatMonths, formatRatio } from '../../src/lib/format.js';

describe('formatMonths', () => {
  it('drops trailing zeros instead of showing a fake precision', () => {
    expect(formatMonths(12)).toBe('12');
    expect(formatMonths(12.5)).toBe('12,5');
    expect(formatMonths('12.50')).toBe('12,5');
    expect(formatMonths('12.00')).toBe('12');
    expect(formatMonths('0.50')).toBe('0,5');
  });

  it('keeps a missing value honest and never adds a percent sign', () => {
    expect(formatMonths(null)).toBe('—');
    expect(formatMonths(undefined)).toBe('—');
    expect(formatMonths('')).toBe('—');
    expect(formatMonths(12.5)).not.toContain('%');
  });

  it('uses the typographic minus for negative months', () => {
    expect(formatMonths('-1.50')).toBe('\u22121,5');
  });

  it('rejects non-numeric input instead of printing it as a label', () => {
    expect(() => formatMonths('abc')).toThrow(TypeError);
    expect(() => formatMonths(Number.NaN)).toThrow(TypeError);
  });
});

describe('formatRatio', () => {
  it('uses three decimals by default, half up', () => {
    expect(formatRatio(2.9996)).toBe('3,000');
    expect(formatRatio(2.5)).toBe('2,500');
    expect(formatRatio('2.50')).toBe('2,500');
  });

  it('honours the requested precision', () => {
    expect(formatRatio(2.5, { decimals: 2 })).toBe('2,50');
    expect(formatRatio('2.50', { decimals: 2 })).toBe('2,50');
  });

  it('keeps a missing value honest and is not a percentage formatter', () => {
    expect(formatRatio(null)).toBe('—');
    expect(formatRatio(undefined)).toBe('—');
    expect(formatRatio(2.5)).not.toContain('%');
  });

  it('uses the typographic minus for negative ratios', () => {
    expect(formatRatio(-1.2345, { decimals: 2 })).toBe('\u22121,23');
  });

  it('rejects non-numeric input and an invalid precision', () => {
    expect(() => formatRatio('abc')).toThrow(TypeError);
    expect(() => formatRatio(2.5, { decimals: -1 })).toThrow(TypeError);
    expect(() => formatRatio(2.5, { decimals: 1.5 })).toThrow(TypeError);
  });
});
