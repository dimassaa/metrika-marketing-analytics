import { describe, expect, it } from 'vitest';
import {
  formatCentsToByn,
  formatInteger,
  formatMonths,
  formatPercent,
  formatRatio,
  formatRomi,
} from '../../src/lib/format.js';
import { formatDateRu } from '../../src/lib/dates.js';
import { cellFormat } from '../../src/lib/cell-format.js';

describe('cellFormat', () => {
  it('delegates every token to the single formatter it names', () => {
    expect(cellFormat('cents', '123456')).toBe(formatCentsToByn('123456'));
    expect(cellFormat('percent', 12.5)).toBe(formatPercent(12.5));
    expect(cellFormat('romi', -1.2)).toBe(formatRomi(-1.2));
    expect(cellFormat('integer', 1234)).toBe(formatInteger(1234));
    expect(cellFormat('months', '12.5')).toBe(formatMonths('12.5'));
    expect(cellFormat('ratio', 3.424)).toBe(formatRatio(3.424));
    expect(cellFormat('date', '2026-11-21')).toBe(formatDateRu('2026-11-21'));
  });

  it('keeps the dash for a missing value instead of inventing a zero', () => {
    expect(cellFormat('cents', null)).toBe('—');
    expect(cellFormat('percent', null)).toBe('—');
    expect(cellFormat('romi', null)).toBe('—');
    expect(cellFormat('integer', null)).toBe('—');
    expect(cellFormat('months', null)).toBe('—');
    expect(cellFormat('ratio', null)).toBe('—');
  });

  it('fails loudly on an unknown token', () => {
    expect(() => cellFormat('currency', 100)).toThrow(TypeError);
  });
});
