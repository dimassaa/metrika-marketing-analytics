import { describe, expect, it } from 'vitest';
import { clientIp, normalizeIp } from '../../src/lib/clientIp.js';

describe('normalizeIp', () => {
  it('keeps IP literals and rejects everything else', () => {
    expect(normalizeIp('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('::1')).toBe('::1');
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('::ffff:127.0.0.1');
    expect(normalizeIp('not-an-ip')).toBeNull();
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp(null)).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
    expect(normalizeIp(42)).toBeNull();
  });
});

describe('clientIp', () => {
  it('reads req.ip only when it is an IP literal', () => {
    expect(clientIp({ ip: '10.0.0.1' })).toBe('10.0.0.1');
    expect(clientIp({ ip: 'not-an-ip' })).toBeNull();
    expect(clientIp({})).toBeNull();
  });
});
