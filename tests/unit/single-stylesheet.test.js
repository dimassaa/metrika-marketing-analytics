import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('single stylesheet rule', () => {
  it('links exactly one stylesheet from every view', () => {
    for (const file of walk('src/views').filter((f) => f.endsWith('.ejs'))) {
      const html = readFileSync(file, 'utf8');
      const links = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)];
      expect(links.length, file).toBeLessThanOrEqual(1);
      if (links.length) expect(links[0][0]).toContain('/css/app.css');
      expect(html).not.toMatch(/<style[\s>]/i);
    }
  });

  it('has only app.css in public/css', () => {
    expect(readdirSync('public/css')).toEqual(['app.css']);
  });
});
