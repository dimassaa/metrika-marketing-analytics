import { describe, expect, it } from 'vitest';
import {
  hasPlottableData,
  toCacLtvPoints,
  toCacPoints,
  toChannelSpendPoints,
  toRomiPoints,
  toSpendRevenuePoints,
} from '../../src/lib/series.js';

describe('chart points', () => {
  it('keeps a missing CAC as null instead of turning it into a zero', () => {
    const points = toCacPoints([{ cacCents: '3420' }, { cacCents: null }, { cacCents: '0' }]);

    expect(points).toEqual([3420, null, 0]);
  });

  it('keeps ROMI percentages as numbers and null for an unmeasured week', () => {
    expect(toRomiPoints([{ romiPct: 12.4 }, { romiPct: null }, { romiPct: 0 }])).toEqual([12.4, null, 0]);
  });

  it('reads spend and attributed revenue from the same weekly bucket', () => {
    expect(
      toSpendRevenuePoints([{ spendCents: '100000', attributedCents: '150000' }]),
    ).toEqual([{ spend: 100000, revenue: 150000 }]);
  });

  it('treats only a series with a measured point as plottable', () => {
    expect(hasPlottableData([null, null])).toBe(false);
    expect(hasPlottableData([null, 0])).toBe(true);
    expect(hasPlottableData([0, 0])).toBe(true);
    expect(hasPlottableData([])).toBe(false);
    expect(hasPlottableData(undefined)).toBe(false);
  });

  it('refuses a malformed money string instead of plotting NaN', () => {
    expect(() => toCacPoints([{ cacCents: 'abc' }])).toThrow(TypeError);
    expect(() => toSpendRevenuePoints([{ spendCents: '1.5', attributedCents: '0' }])).toThrow(TypeError);
  });

  it('converts channel spend and keeps a missing CAC or LTV as null for the scatter', () => {
    expect(
      toChannelSpendPoints([{ channelId: '1', name: 'Instagram', spendCents: '300000' }]),
    ).toEqual([{ channelId: '1', name: 'Instagram', spend: 300000 }]);

    expect(
      toCacLtvPoints([
        {
          channelId: '1',
          name: 'Instagram',
          cacCents: '50000',
          ltv12Cents: '150000',
          newCustomers: 6,
        },
        { channelId: '2', name: 'Google Ads', cacCents: '50000', ltv12Cents: null, newCustomers: 2 },
      ]),
    ).toEqual([
      { channelId: '1', name: 'Instagram', cac: 50000, ltv: 150000, newCustomers: 6 },
      { channelId: '2', name: 'Google Ads', cac: 50000, ltv: null, newCustomers: 2 },
    ]);
  });
});
