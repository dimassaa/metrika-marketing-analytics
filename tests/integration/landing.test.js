import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';

// Absolute URLs in canonical/OG/sitemap come from APP_URL. Deriving them here keeps the test portable: a stand that
// runs on another host or port must not fail because of a hardcoded localhost.
const HOME_URL = new URL('/', env.appUrl).toString();

// The landing is static content: it must render even when PostgreSQL is unavailable. Any query is a bug, so the
// fake client throws instead of returning rows and the failure is impossible to miss.
const app = createApp({
  db: {
    query: () => {
      throw new Error('the landing page must not query the database');
    },
  },
});

/**
 * Pulls the JSON-LD block out of a rendered page. The attribute order is fixed by head.ejs, but the regex stays
 * tolerant of extra attributes so a later `nonce` change does not silently break the assertion.
 * @param {string} html
 * @returns {unknown}
 */
function extractJsonLd(html) {
  const match = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  return match ? JSON.parse(match[1]) : null;
}

/**
 * Pulls the error-page section out of a rendered page. The shared header and footer also link to `/` and `/login`,
 * so asserting against the whole document would pass even if the recovery actions were deleted.
 * @param {string} html
 * @returns {string}
 */
function extractErrorSection(html) {
  return html.match(/<section class="section error-page">[\s\S]*?<\/section>/)?.[0] ?? '';
}

describe('public landing', () => {
  it('renders one Russian SEO page without touching the database', async () => {
    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toMatch(/<html lang="ru">/);
    expect(res.text.match(/<h1[\s>]/g)).toHaveLength(1);

    const title = res.text.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
    expect(title.length).toBeGreaterThanOrEqual(20);
    expect(title.length).toBeLessThanOrEqual(60);

    const description = res.text.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '';
    expect(description.length).toBeLessThanOrEqual(160);

    expect(res.text).toContain(`<link rel="canonical" href="${HOME_URL}">`);
    // Exactly one canonical: a second link with another href lets a crawler pick the wrong page.
    expect(res.text.match(/<link rel="canonical"/g)).toHaveLength(1);
    expect(res.text).toContain(`<meta property="og:url" content="${HOME_URL}">`);
    expect(res.text).toContain(
      `<meta property="og:image" content="${new URL('/img/og-cover.png', env.appUrl).toString()}">`,
    );
    expect(res.text).toContain('<meta property="og:image:type" content="image/png">');
    expect(res.text).toContain('<meta property="og:image:width" content="1200">');
    expect(res.text).toContain('<meta property="og:image:height" content="630">');
    expect(res.text).toMatch(/<meta property="og:image:alt" content="[^"]{20,}">/);
    expect(res.text).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(res.text).toMatch(/<meta name="twitter:image:alt" content="[^"]{20,}">/);
    expect(res.text).toMatch(/<meta name="robots" content="index, follow">/);

    const jsonLd = extractJsonLd(res.text);
    expect(jsonLd).not.toBeNull();
    expect(JSON.stringify(jsonLd)).toContain('"@type":"WebApplication"');
    expect(JSON.stringify(jsonLd)).toContain('"@type":"Organization"');
    expect(res.text).toMatch(/<script type="application\/ld\+json" nonce="[^"]+">/);
  });

  it('labels the dashboard preview as demonstration data', async () => {
    const res = await request(app).get('/');

    expect(res.text).toContain('Демонстрационные данные');
    expect(res.text).toContain('Войти в демо');
    expect(res.text).toMatch(/class="highlight"/);
    // A single filled CTA per screen; every other action is a ghost pill.
    expect(res.text.match(/btn--primary/g)).toHaveLength(1);
    // Currency is BYN only, rendered through the NBRB ligature span.
    expect(res.text).toContain('<span class="byn">BYN</span>');
    expect(res.text).not.toMatch(/[$₽]|руб\./);
  });

  it('serves robots.txt with the private areas disallowed', async () => {
    const res = await request(app).get('/robots.txt');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('Disallow: /app');
    expect(res.text).toContain('Disallow: /api');
  });

  it('serves sitemap.xml with the landing URL', async () => {
    const res = await request(app).get('/sitemap.xml');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toContain(`<loc>${HOME_URL}</loc>`);
  });

  it('serves the Open Graph cover as a real PNG from the public tree', async () => {
    const res = await request(app).get('/img/og-cover.png');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
    // A meta tag pointing at a 404 is the classic OG regression; the body must be the committed screenshot.
    expect(res.body.length).toBeGreaterThan(1024);
  });

  it('answers unknown pages with an HTML 404 view, not JSON', async () => {
    const res = await request(app).get('/nope');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Страница не найдена');
    // Scope the recovery-link assertions to the error section itself; header/footer links must not satisfy them.
    const errorSection = extractErrorSection(res.text);
    expect(errorSection).not.toBe('');
    expect(errorSection).toMatch(/<a[^>]+href="\/"[^>]*>На главную<\/a>/);
    expect(errorSection).toMatch(/<a[^>]+href="\/login"[^>]*>Войти<\/a>/);
    expect(res.text.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(res.text).toMatch(/<meta name="robots" content="noindex/);
  });
});
