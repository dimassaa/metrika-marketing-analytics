import { describe, expect, it } from 'vitest';
import { dataProps, serializeDataProps } from '../../src/lib/serialize-props.js';

const ATTACKS = [
  '</script><script>alert(1)</script>',
  '" onmouseover="alert(1)',
  'a & b < c > d',
  '\u2028line separator\u2029paragraph separator',
  '<img src=x onerror=alert(1)>',
];

describe('serializeDataProps', () => {
  it('escapes every character that could close the attribute or a script tag', () => {
    for (const attack of ATTACKS) {
      const json = serializeDataProps({ attack }, 'island "test" props');

      expect(json).not.toContain('<');
      expect(json).not.toContain('>');
      expect(json).not.toContain('&');
      expect(JSON.parse(json)).toEqual({ attack });
    }
  });

  it('keeps the payload a deep-equal object after a browser round trip', () => {
    const model = {
      kpis: { spendLabel: '0,00', items: [{ id: 'spend' }] },
      labels: { period: '30 дней' },
      filter: { channelIds: null },
      note: '\u2028',
    };

    expect(JSON.parse(serializeDataProps(model, 'props'))).toEqual(model);
  });

  it('throws a named TypeError for a BigInt instead of losing precision silently', () => {
    expect(() => dataProps({ cents: 5000n }, 'dashboard')).toThrow(TypeError);
    expect(() => dataProps({ cents: 5000n }, 'dashboard')).toThrow(/dashboard/);
  });

  it('names the island in the error, so a broken screen is locatable', () => {
    expect(() => dataProps({ value: 1n }, 'cohorts')).toThrow(/island "cohorts" props/);
  });

  it('rejects cyclic objects and undefined at the root', () => {
    const cyclic = {};
    cyclic.self = cyclic;

    expect(() => serializeDataProps(cyclic, 'cycle props')).toThrow(TypeError);
    expect(() => serializeDataProps(undefined, 'undefined props')).toThrow(TypeError);
  });
});
