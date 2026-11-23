import { describe, expect, it } from 'vitest';
import { heatBucket } from '../../src/lib/heat-scale.js';

describe('heatBucket', () => {
  it('maps every measured value into one of five buckets with open upper bounds', () => {
    expect(heatBucket(0)).toBe('heat-0');
    expect(heatBucket(19.99)).toBe('heat-0');
    expect(heatBucket(20)).toBe('heat-1');
    expect(heatBucket(39.99)).toBe('heat-1');
    expect(heatBucket(40)).toBe('heat-2');
    expect(heatBucket(59.99)).toBe('heat-2');
    expect(heatBucket(60)).toBe('heat-3');
    expect(heatBucket(79.99)).toBe('heat-3');
    expect(heatBucket(80)).toBe('heat-4');
    expect(heatBucket(100)).toBe('heat-4');
  });

  it('treats a future or unmeasured retention cell as empty, not as zero', () => {
    expect(heatBucket(null)).toBe('is-empty');
    expect(heatBucket(undefined)).toBe('is-empty');
  });

  it('has exactly five non-empty buckets', () => {
    const buckets = new Set([0, 20, 40, 60, 80, 100].map((value) => heatBucket(value)));

    expect([...buckets].sort()).toEqual(['heat-0', 'heat-1', 'heat-2', 'heat-3', 'heat-4']);
  });

  it('rejects a non-numeric value instead of painting a broken cell', () => {
    expect(() => heatBucket('40')).toThrow(TypeError);
    expect(() => heatBucket(Number.NaN)).toThrow(TypeError);
  });
});
