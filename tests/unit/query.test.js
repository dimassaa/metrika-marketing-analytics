import { describe, expect, it } from 'vitest';
import { buildQueryString } from '../../src/lib/query.js';

describe('buildQueryString', () => {
  it('keeps arrays as repeated parameters and appends patch keys in order', () => {
    expect(buildQueryString({ days: 90, channelIds: ['1', '2'] }, { sort: 'cac' })).toBe(
      'days=90&channelIds=1&channelIds=2&sort=cac',
    );
  });

  it('overrides an existing key without moving it and keeps every unrelated key', () => {
    expect(
      buildQueryString(
        { days: 30, channelIds: ['1'], status: 'all', sort: 'cac' },
        { sort: 'romi', days: 180 },
      ),
    ).toBe('days=180&channelIds=1&status=all&sort=romi');
  });

  it('removes a key with null, undefined or an empty value, and never leaves an empty array', () => {
    expect(buildQueryString({ days: 90, channelIds: ['1'] }, { channelIds: null })).toBe('days=90');
    expect(buildQueryString({ days: 90, channelIds: ['1'] }, { channelIds: [] })).toBe('days=90');
    expect(buildQueryString({ days: 90, sort: 'cac' }, { sort: undefined })).toBe('days=90');
    expect(buildQueryString({ days: 90, sort: 'cac' }, { sort: '' })).toBe('days=90');
  });

  it('encodes Cyrillic and reserved characters', () => {
    expect(buildQueryString({ status: 'все каналы', q: 'a&b=c' })).toBe(
      'status=%D0%B2%D1%81%D0%B5%20%D0%BA%D0%B0%D0%BD%D0%B0%D0%BB%D1%8B&q=a%26b%3Dc',
    );
  });

  it('returns an empty string when nothing remains', () => {
    expect(buildQueryString()).toBe('');
    expect(buildQueryString({}, {})).toBe('');
    expect(buildQueryString({ channelIds: ['1'] }, { channelIds: null })).toBe('');
  });
});
