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
    expect(formatPercent(null)).toBe('—');
  });
});

describe('formatInteger', () => {
  it('groups thousands and keeps a null honest', () => {
    expect(formatInteger(12345)).toBe('12 345');
    expect(formatInteger('7')).toBe('7');
    expect(formatInteger(null)).toBe('—');
  });
});
