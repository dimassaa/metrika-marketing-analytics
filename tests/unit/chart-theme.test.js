import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { chartTheme } from '../../client/lib/chartTheme.js';

/**
 * @param {unknown} value
 * @param {Set<string>} target
 * @returns {Set<string>} Every hex literal found in the theme object.
 */
function collectHex(value, target = new Set()) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/#[0-9a-fA-F]{6}\b/g)) target.add(match[0].toLowerCase());
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectHex(item, target);
  }
  return target;
}

function rootBlock() {
  const css = readFileSync('public/css/app.css', 'utf8');
  const start = css.indexOf(':root');
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

describe('chart theme', () => {
  it('uses only colours that exist as :root tokens in the single stylesheet', () => {
    const root = rootBlock().toLowerCase();
    const hexes = [...collectHex(chartTheme)];

    expect(hexes.length).toBeGreaterThan(0);
    for (const hex of hexes) {
      expect(root, `${hex} is missing from :root`).toContain(hex);
    }
  });

  it('pins the primary series colour and the axis font size to the design tokens', () => {
    expect(chartTheme.seriesPrimary).toBe('#3ba6f1');
    expect(chartTheme.fontSize).toBe(12);
    expect(chartTheme.strokeWidth).toBe(2);
  });
});
