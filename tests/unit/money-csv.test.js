import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/lib/errors.js';
import { centsFromDb, parseBynToCents } from '../../src/lib/money.js';
import { formatCentsToByn, formatInteger, formatPercent } from '../../src/lib/format.js';

describe('parseBynToCents', () => {
  it('accepts grouped, dotted and whole BYN amounts', () => {
    expect(parseBynToCents('1 234,56')).toBe(123456n);
    expect(parseBynToCents('45.5')).toBe(4550n);
    expect(parseBynToCents('0')).toBe(0n);
  });

  it('ignores a NBSP separator and the BYN suffix typed by the user', () => {
    expect(parseBynToCents('1\u00a0234,56 BYN')).toBe(123456n);
  });

  it('rejects negative, over-precise and non-numeric input', () => {
    expect(() => parseBynToCents('-10')).toThrow(ValidationError);
    expect(() => parseBynToCents('12,345')).toThrow(ValidationError);
    expect(() => parseBynToCents('abc')).toThrow(ValidationError);
    expect(() => parseBynToCents('')).toThrow(ValidationError);
  });

  it('names the currency as BYN in every validation message', () => {
    for (const input of [null, '', 'abc']) {
      try {
        parseBynToCents(input);
        throw new Error('expected a ValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect(error.message).toContain('BYN');
        expect(error.message).not.toMatch(/рубл/i);
      }
    }
  });

  it('accepts the largest BIGINT kopeck value and rejects one kopeck more', () => {
    expect(parseBynToCents('92233720368547758,07')).toBe(9223372036854775807n);
    expect(() => parseBynToCents('92233720368547758,08')).toThrow('Сумма слишком велика');
    expect(() => parseBynToCents('999999999999999999')).toThrow('Сумма слишком велика');
  });
});

describe('centsFromDb', () => {
  it('converts the string pg returns for BIGINT and keeps bigint input as is', () => {
    expect(centsFromDb('123456')).toBe(123456n);
    expect(centsFromDb(42)).toBe(42n);
    expect(centsFromDb(42n)).toBe(42n);
    expect(centsFromDb(null)).toBe(null);
    expect(centsFromDb(undefined)).toBe(null);
  });

  it('refuses floats and junk instead of silently rounding them', () => {
    expect(() => centsFromDb('12.5')).toThrow(TypeError);
    expect(() => centsFromDb(12.5)).toThrow(TypeError);
    expect(() => centsFromDb('abc')).toThrow(TypeError);
    // Money is never signed in this schema: a negative string is junk, not an amount to render.
    expect(() => centsFromDb('-5')).toThrow(TypeError);
  });
});

describe('formatCentsToByn', () => {
  it('renders kopecks with a comma and space-grouped thousands', () => {
    expect(formatCentsToByn(123456n)).toBe('1 234,56');
    expect(formatCentsToByn('123456')).toBe('1 234,56');
    expect(formatCentsToByn(0n)).toBe('0,00');
    expect(formatCentsToByn(null)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('uses a typographic minus and keeps the sign when asked', () => {
    expect(formatPercent('-8.1', { signed: true })).toBe('\u22128,1%');
    expect(formatPercent('12.4', { signed: true })).toBe('+12,4%');
    expect(formatPercent('120.00')).toBe('120,0%');
    expect(formatPercent(null)).toBe('—');
  });
});

describe('formatInteger', () => {
  it('groups thousands and keeps a null honest', () => {
    expect(formatInteger(12345)).toBe('12 345');
    expect(formatInteger('7')).toBe('7');
    expect(formatInteger(1234n)).toBe('1 234');
    expect(formatInteger(-1234)).toBe('\u22121 234');
    expect(formatInteger(null)).toBe('—');
  });

  it('rejects fractional and non-numeric counters instead of rounding them', () => {
    expect(() => formatInteger(12.5)).toThrow(TypeError);
    expect(() => formatInteger('12,5')).toThrow(TypeError);
  });
});
