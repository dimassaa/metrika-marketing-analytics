import { describe, expect, it } from 'vitest';
import { formatCompactCents, formatMonths, formatRatio, formatRomi, formatSignedPercent } from '../../src/lib/format.js';

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

  it('never emits exponent notation for tiny or exponent inputs', () => {
    expect(formatMonths(1e-7)).toBe('0,0000001');
    expect(formatMonths('1.5e-7')).toBe('0,00000015');
    expect(formatMonths('1e+21')).toBe('1000000000000000000000');
    expect(formatMonths('-1e-7')).toBe('\u22120,0000001');
  });

  it('uses the typographic minus for negative months', () => {
    expect(formatMonths('-1.50')).toBe('\u22121,5');
  });

  it('rejects non-numeric input instead of printing it as a label', () => {
    expect(() => formatMonths('abc')).toThrow(TypeError);
    expect(() => formatMonths(Number.NaN)).toThrow(TypeError);
  });
});

describe('formatRomi', () => {
  it('shows a signed one-decimal percentage per metrics spec §3.2', () => {
    expect(formatRomi(713.11)).toBe('+713,1%');
    expect(formatRomi(-8.11)).toBe('\u22128,1%');
    expect(formatRomi(0)).toBe('0,0%');
  });

  it('never turns a tiny negative value into a positive zero', () => {
    const label = formatRomi(-0.004);
    expect(label).toBe('\u2212<0,1%');
    expect(label.startsWith('\u2212')).toBe(true);
    expect(label).not.toBe('0,0%');
    expect(label).not.toBe('\u22120,0%');
  });

  it('keeps a missing value honest and rejects non-numeric input', () => {
    expect(formatRomi(null)).toBe('—');
    expect(formatRomi(undefined)).toBe('—');
    expect(() => formatRomi('abc')).toThrow(TypeError);
    expect(() => formatRomi(Number.NaN)).toThrow(TypeError);
  });
});

describe('formatSignedPercent', () => {
  it('renders a signed one-decimal percentage and keeps a tiny negative visible', () => {
    expect(formatSignedPercent(12.44)).toBe('+12,4%');
    expect(formatSignedPercent(-8.11)).toBe('\u22128,1%');
    expect(formatSignedPercent(0)).toBe('0,0%');
    // The delta column case: −0,04% must not become 0,0%.
    expect(formatSignedPercent(-0.04)).toBe('\u2212<0,1%');
    expect(formatSignedPercent(0.04)).toBe('+0,0%');
  });

  it('keeps a missing value honest and rejects non-numeric input', () => {
    expect(formatSignedPercent(null)).toBe('—');
    expect(formatSignedPercent(undefined)).toBe('—');
    expect(() => formatSignedPercent('abc')).toThrow(TypeError);
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
    expect(() => formatRatio(2.5, { decimals: 13 })).toThrow(/between 0 and 12/);
  });
});

describe('formatCompactCents', () => {
  it('groups whole roubles below the thousands threshold', () => {
    expect(formatCompactCents(123400)).toBe('1 234');
    expect(formatCompactCents(0)).toBe('0');
  });

  it('compacts thousands and millions of roubles with one decimal', () => {
    // The input is kopecks, so 1 234 000 equals 12 340 BYN.
    expect(formatCompactCents(1_234_000)).toBe('12,3 тыс.');
    expect(formatCompactCents(12_340_000)).toBe('123,4 тыс.');
    expect(formatCompactCents(1_234_500_000)).toBe('12,3 млн');
  });

  it('keeps one decimal in compact units, including a zero one', () => {
    // Corrected in the T1 review: compact units always keep one decimal so a value promoted at the boundary cannot
    // read like a whole different quantity (`1,0 млн`, not `1 млн`).
    expect(formatCompactCents(1_200_000)).toBe('12,0 тыс.');
  });

  it('promotes a value that rounds up at the unit boundary', () => {
    // 999 999 BYN in kopecks; the rounded value is 1 000,0 тыс., so the unit must become millions.
    expect(formatCompactCents(99_999_900)).toBe('1,0 млн');
    expect(formatCompactCents(100_000_000)).toBe('1,0 млн');
  });

  it('keeps a missing value honest and uses the typographic minus', () => {
    expect(formatCompactCents(null)).toBe('—');
    expect(formatCompactCents(undefined)).toBe('—');
    expect(formatCompactCents(-1_234_000)).toBe('\u221212,3 тыс.');
  });
});
