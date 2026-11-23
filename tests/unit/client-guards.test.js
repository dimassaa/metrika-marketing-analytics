import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static guards for the client island tree.
 *
 * These rules cannot be proven by rendering a component: a stray CSS import or an inline style only shows up in the
 * bundle, and a second island in one entry only shows up when two models fight over one page. The guards therefore
 * read the source, which is the only place the mistake exists before it ships.
 *
 * @param {string} dir
 * @returns {string[]} Every file under `dir`, recursively.
 */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const clientFiles = walk('client').filter((file) => /\.(jsx?|mjs)$/.test(file));
const entryFiles = walk('client/entries').filter((file) => file.endsWith('.jsx'));

/** Chart components that must render through Recharts rather than a hand-written SVG. */
const REALTIME_CHART_ROOTS = /<(LineChart|BarChart|AreaChart|ScatterChart|ComposedChart)\s[^>]*>/gs;

describe('client source guards', () => {
  it('never imports a stylesheet from the island tree', () => {
    for (const file of clientFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/(?:import|from)\s+['"][^'"]+\.css['"]/);
    }
  });

  it('never uses inline styles, styled-components or raw HTML injection', () => {
    for (const file of clientFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/(?<![A-Za-z])style=\{\{/);
      expect(source, file).not.toContain('styled.');
      expect(source, file).not.toContain('dangerouslySetInnerHTML');
      expect(source, file).not.toContain('.innerHTML');
    }
  });

  it('never fetches from an island: the server model is the only source of numbers', () => {
    for (const file of clientFiles) {
      // Also catches `window.fetch(` and `globalThis.fetch(`: the negative lookbehind this guard used to have let a
      // member call through while claiming to forbid fetching.
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it('has no island registry and mounts exactly one island per entry', () => {
    expect(existsSync(join('client', 'islands', 'registry.js'))).toBe(false);

    for (const file of entryFiles) {
      const source = readFileSync(file, 'utf8');
      expect((source.match(/mountIsland\s*\(/g) ?? []).length, `${file} mounts one island`).toBe(1);
      expect(source, `${file} imports no other entry`).not.toMatch(/from\s+['"][^'"]*entries\//);
    }
  });

  it('renders the sparkline through Recharts, not a hand-written svg', () => {
    const source = readFileSync('client/components/charts/Sparkline.jsx', 'utf8');

    expect(source).toContain('<LineChart');
    expect(source).not.toMatch(/<svg[\s>]/);
  });

  it('disables the Recharts accessibility layer on every chart root', () => {
    // The chart frame already provides `role="img"` with a text alternative and a duplicate table. Recharts' own
    // layer adds `tabindex="0"` and `role="application"` inside that image, which is a second tab stop announcing the
    // same data. The guard keeps the layer off even in a component added later.
    const chartFiles = clientFiles.filter((file) => readFileSync(file, 'utf8').includes('from \'recharts\''));

    expect(chartFiles.length).toBeGreaterThan(0);
    for (const file of chartFiles) {
      const source = readFileSync(file, 'utf8');
      const roots = source.match(REALTIME_CHART_ROOTS) ?? [];
      expect(roots.length, `${file} has a chart root`).toBeGreaterThan(0);
      for (const root of roots) {
        expect(root, `${file} disables Recharts a11y layer`).toContain('accessibilityLayer={false}');
      }
    }
  });

  it('ships no stylesheet in the built assets directory', () => {
    if (!existsSync(join('public', 'assets'))) return;

    const built = walk(join('public', 'assets'));
    expect(built.filter((file) => file.endsWith('.css'))).toEqual([]);
  });
});
