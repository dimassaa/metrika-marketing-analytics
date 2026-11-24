import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../../src/config/env.js';
import { buildSeo } from '../../src/lib/seo.js';

const PNG_PATH = join(process.cwd(), 'public', 'img', 'og-cover.png');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_OG_BYTES = 300 * 1024;

/**
 * Reads the committed cover once. Every assertion in the file would otherwise parse the same buffer again, and a
 * missing file must fail with the path rather than with an unrelated `undefined`.
 */
function readCover() {
  const bytes = readFileSync(PNG_PATH);
  return { bytes, size: statSync(PNG_PATH).size };
}

describe('Open Graph cover file', () => {
  it('is a committed PNG with a real 1200×630 IHDR', () => {
    const { bytes } = readCover();

    expect(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'PNG signature').toBe(true);
    // IHDR is required to be the first chunk: length (4) + type (4) + width (4) + height (4).
    expect(bytes.toString('ascii', 12, 16)).toBe('IHDR');
    expect(bytes.readUInt32BE(16), 'IHDR width').toBe(1200);
    expect(bytes.readUInt32BE(20), 'IHDR height').toBe(630);
    // Social crawlers reject palette and 1-bit images more often than truecolour; the generated screenshot is 8-bit.
    expect(bytes[24], 'bit depth').toBe(8);
    expect([2, 6], 'colour type: truecolour with or without alpha').toContain(bytes[25]);
  });

  it('stays below the 300 KB weight that social crawlers fetch eagerly', () => {
    const { size } = readCover();

    expect(size, `og-cover.png is ${size} B`).toBeLessThan(MAX_OG_BYTES);
  });
});

describe('buildSeo Open Graph defaults', () => {
  const seo = buildSeo({
    title: 'Тестовая страница — Метрика',
    description: 'Описание страницы для проверки Open Graph.',
  });

  it('points og:image at the static PNG, not the editable SVG', () => {
    expect(seo.ogImage).toBe(new URL('/img/og-cover.png', env.appUrl).toString());
    expect(new URL(seo.ogImage).pathname).toMatch(/\.png$/);
  });

  it('publishes the dimensions and MIME type that let a crawler reserve the card', () => {
    expect(seo.ogImageType).toBe('image/png');
    expect(seo.ogImageWidth).toBe(1200);
    expect(seo.ogImageHeight).toBe(630);
  });

  it('carries a Russian alt text instead of repeating the file name', () => {
    expect(typeof seo.ogImageAlt).toBe('string');
    expect(seo.ogImageAlt.length).toBeGreaterThanOrEqual(20);
    expect(seo.ogImageAlt).toContain('Метрика');
    expect(seo.ogImageAlt).not.toMatch(/\.png|og-cover/i);
  });
});
