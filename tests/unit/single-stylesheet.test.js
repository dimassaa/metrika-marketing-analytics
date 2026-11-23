import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const views = walk('src/views').filter((file) => file.endsWith('.ejs'));
const stylesheetLinks = (html) => [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)];

describe('single stylesheet rule', () => {
  it('links at most one stylesheet per view and none besides app.css', () => {
    for (const file of views) {
      const html = readFileSync(file, 'utf8');
      const links = stylesheetLinks(html);
      expect(links.length, file).toBeLessThanOrEqual(1);
      if (links.length) expect(links[0][0]).toContain('/css/app.css');
      expect(html).not.toMatch(/<style[\s>]/i);
    }
  });

  it('links exactly one stylesheet across the whole view tree', () => {
    const total = views.reduce(
      (count, file) => count + stylesheetLinks(readFileSync(file, 'utf8')).length,
      0,
    );
    expect(total).toBe(1);
  });

  it('has only app.css in public/css', () => {
    expect(readdirSync('public/css')).toEqual(['app.css']);
  });

  it('does not use @import', () => {
    expect(readFileSync('public/css/app.css', 'utf8')).not.toMatch(/@import\b/i);
  });

  it('ships no second stylesheet inside the built island assets', () => {
    if (!existsSync('public/assets')) return;

    const built = [];
    (function collect(dir) {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) collect(path);
        else built.push(path);
      }
    })('public/assets');

    expect(built.filter((file) => file.endsWith('.css'))).toEqual([]);
  });

  it('ships every font file referenced from the stylesheet and the head partial', () => {
    const sources = [
      readFileSync('public/css/app.css', 'utf8'),
      readFileSync('src/views/partials/head.ejs', 'utf8'),
    ];
    const refs = new Set(
      sources.flatMap((text) => [...text.matchAll(/\/fonts\/[\w.-]+\.(woff2|ttf)/g)].map((m) => m[0])),
    );
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(existsSync(join('public', ref.replace(/^\//, ''))), ref).toBe(true);
    }
  });
});
