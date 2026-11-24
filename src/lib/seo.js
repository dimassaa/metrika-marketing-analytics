import { env } from '../config/env.js';

const DEFAULT_OG_IMAGE = '/img/og-cover.png';

/**
 * Social crawlers fetch `og:image` with no page context, so an SVG cannot load the app's WOFF2 and falls back to a
 * system face. The committed PNG is the rasterized cover; the SVG stays next to it as the editable source.
 */
const DEFAULT_OG_IMAGE_ALT = 'Метрика — аналитика CAC, LTV и ROMI по маркетинговым каналам';

/**
 * Normalizes a site-relative path before it reaches `new URL`.
 *
 * `new URL('//evil.example/x', appUrl)` treats the value as a protocol-relative URL and produces an off-site
 * canonical, which tells a crawler the page lives on another host. Collapsing the leading slashes to exactly one
 * keeps every canonical on APP_URL; a value that is not a path at all (an absolute URL, a bare host) is rejected
 * instead of silently accepted. Backslashes are stripped for the same reason a browser treats them as slashes, and
 * an origin check catches any remaining URL-parser surprise.
 * @param {string} path
 * @returns {string}
 * @throws {TypeError} When the value is not a safe site-relative path.
 */
function normalizeCanonicalPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError('buildSeo requires a site-relative path starting with "/"');
  }
  const normalized = `/${path.replace(/^[/\\]+/, '')}`;
  if (/[\\\r\n\t]/.test(normalized)) {
    throw new TypeError('buildSeo received a path with unsafe characters');
  }

  const resolved = new URL(normalized, env.appUrl);
  if (resolved.origin !== new URL(env.appUrl).origin) {
    throw new TypeError('buildSeo resolved a canonical outside APP_URL');
  }
  return normalized;
}

/**
 * Serializes structured data for an inline `<script type="application/ld+json">`.
 * Escaping `<` is what prevents a `</script>` sequence inside any value from closing the tag early; the result is
 * still valid JSON because `\u003c` is the same character to a JSON parser.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function serializeJsonLd(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Builds every SEO field a page needs from a small set of inputs, so title/description/canonical rules live in one
 * place instead of being repeated in templates. The canonical and OG image are absolute because crawlers reject
 * relative values for canonical and Open Graph.
 *
 * @param {object} input
 * @param {string} input.title Page title, 20–60 characters; rendered verbatim in `<title>` and `og:title`.
 * @param {string} input.description Meta description, at most 160 characters.
 * @param {string} [input.path] Site-relative path used for the canonical URL.
 * @param {string} [input.imagePath] Site-relative or absolute Open Graph image.
 * @param {string} [input.imageAlt] Alt text for the social card; defaults to the cover description.
 * @param {boolean} [input.noindex] Adds `noindex, nofollow`; used for error pages and the private app.
 * @returns {{
 *   title: string, description: string, canonical: string, ogImage: string,
 *   ogImageAlt: string, ogImageType: string, ogImageWidth: number, ogImageHeight: number,
 *   robots: string, jsonLd: string,
 * }}
 * @throws {TypeError} When title or description is missing, or when the path cannot be resolved against APP_URL.
 */
export function buildSeo({
  title,
  description,
  path = '/',
  imagePath = DEFAULT_OG_IMAGE,
  imageAlt = DEFAULT_OG_IMAGE_ALT,
  noindex = false,
} = {}) {
  if (!title || !description) {
    throw new TypeError('buildSeo requires title and description');
  }
  if (typeof imageAlt !== 'string' || imageAlt.trim() === '') {
    throw new TypeError('buildSeo requires a non-empty imageAlt');
  }

  const canonical = new URL(normalizeCanonicalPath(path), env.appUrl).toString();
  const ogImage = new URL(imagePath, env.appUrl).toString();

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        name: 'Метрика',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        inLanguage: 'ru',
        description,
        url: canonical,
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'BYN',
        },
      },
      {
        '@type': 'Organization',
        name: 'Метрика',
        url: new URL('/', env.appUrl).toString(),
        logo: new URL('/img/logo.svg', env.appUrl).toString(),
      },
    ],
  };

  return {
    title,
    description,
    canonical,
    ogImage,
    ogImageAlt: imageAlt,
    // The defaults describe the shipped cover; `imagePath` is the only caller-controlled part today. A future
    // database-backed cover with different dimensions must pass them instead of inheriting the 1200×630 contract.
    ogImageType: 'image/png',
    ogImageWidth: 1200,
    ogImageHeight: 630,
    robots: noindex ? 'noindex, nofollow' : 'index, follow',
    jsonLd: serializeJsonLd(jsonLd),
  };
}
