import { describe, expect, it } from 'vitest';
import { CHANNEL_SORT_FIELDS, sortChannelRows } from '../../src/lib/sort-rows.js';

/**
 * @param {object} [overrides]
 * @returns {object} A row with every sortable field.
 */
function row(overrides = {}) {
  return {
    channelId: '1',
    code: 'alpha',
    name: 'Alpha',
    rank: 1,
    score: 10,
    revenueCents: '1000',
    newCustomers: 1,
    cacCents: '1000',
    status: 'healthy',
    ...overrides,
  };
}

describe('channel table sorting', () => {
  it('orders CAC ascending by default: cheap traffic first', () => {
    const rows = [
      row({ code: 'expensive', cacCents: '10000' }),
      row({ code: 'cheap', cacCents: '900' }),
    ];

    expect(sortChannelRows(rows, { sort: 'cac' }).map((entry) => entry.code)).toEqual(['cheap', 'expensive']);
    expect(CHANNEL_SORT_FIELDS.cac.defaultDir).toBe('asc');
  });

  it('compares money as BigInt, so 9,00 sorts before 100,00 ascending', () => {
    const rows = [
      row({ code: 'hundred', revenueCents: '10000' }),
      row({ code: 'nine', revenueCents: '900' }),
    ];

    expect(sortChannelRows(rows, { sort: 'revenue', dir: 'asc' }).map((entry) => entry.code)).toEqual([
      'nine',
      'hundred',
    ]);
    // Descending is the useful direction for revenue, and it must also be numeric rather than lexical.
    expect(sortChannelRows(rows, { sort: 'revenue', dir: 'desc' }).map((entry) => entry.code)).toEqual([
      'hundred',
      'nine',
    ]);
  });

  it('keeps null values last in both directions', () => {
    const rows = [
      row({ code: 'missing', cacCents: null }),
      row({ code: 'cheap', cacCents: '900' }),
      row({ code: 'expensive', cacCents: '10000' }),
    ];

    expect(sortChannelRows(rows, { sort: 'cac', dir: 'asc' }).map((entry) => entry.code)).toEqual([
      'cheap',
      'expensive',
      'missing',
    ]);
    expect(sortChannelRows(rows, { sort: 'cac', dir: 'desc' }).map((entry) => entry.code)).toEqual([
      'expensive',
      'cheap',
      'missing',
    ]);
  });

  it('orders health worst first: risk, watch, healthy, no_data', () => {
    const rows = [
      row({ code: 'healthy', status: 'healthy' }),
      row({ code: 'risk', status: 'risk' }),
      row({ code: 'no_data', status: 'no_data' }),
      row({ code: 'watch', status: 'watch' }),
    ];

    expect(sortChannelRows(rows, { sort: 'health' }).map((entry) => entry.code)).toEqual([
      'risk',
      'watch',
      'healthy',
      'no_data',
    ]);
  });

  it('breaks equal values by code regardless of direction', () => {
    const rows = [
      row({ code: 'zulu' }),
      row({ code: 'alpha' }),
      row({ code: 'mike' }),
    ];

    expect(sortChannelRows(rows, { sort: 'score', dir: 'desc' }).map((entry) => entry.code)).toEqual([
      'alpha',
      'mike',
      'zulu',
    ]);
  });

  it('does not mutate the input array', () => {
    const rows = [row({ code: 'b' }), row({ code: 'a' })];

    const sorted = sortChannelRows(rows, { sort: 'rank' });

    expect(sorted).not.toBe(rows);
    expect(rows.map((entry) => entry.code)).toEqual(['b', 'a']);
  });

  it('rejects an unknown sort field or direction instead of returning an arbitrary order', () => {
    expect(() => sortChannelRows([row()], { sort: 'profit' })).toThrow('unknown channel sort field');
    expect(() => sortChannelRows([row()], { sort: 'cac', dir: 'sideways' })).toThrow(
      'unknown channel sort direction',
    );
  });

  it('rejects a malformed money string instead of comparing it as text', () => {
    expect(() =>
      sortChannelRows([row({ code: 'bad', revenueCents: '1.5' }), row({ code: 'ok', revenueCents: '100' })], {
        sort: 'revenue',
      }),
    ).toThrow('integer kopeck string');
  });
});
