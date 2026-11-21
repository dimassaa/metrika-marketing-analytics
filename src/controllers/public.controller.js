import { buildSeo } from '../lib/seo.js';
import { env } from '../config/env.js';

const HOME_TITLE = 'Метрика — CAC, LTV и ROMI по каналам';
const HOME_DESCRIPTION =
  'Считайте CAC, когортный LTV и ROMI по каждому каналу. Импорт CSV, три модели атрибуции, ' +
  'сценарии бюджета. Демо-данные в BYN.';

/**
 * Renders the public landing page. No database access: the page describes the product, it does not show live
 * numbers, and it must stay available even when PostgreSQL is down.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function homePage(req, res) {
  const seo = buildSeo({ title: HOME_TITLE, description: HOME_DESCRIPTION, path: '/' });
  res.render('pages/home', {
    layout: 'layouts/public',
    seo,
    jsonLd: seo.jsonLd,
    year: new Date().getFullYear(),
  });
}

/**
 * Serves the crawl rules. `/app` and `/api` are closed to crawlers; the sitemap itself is advertised so search
 * engines can discover the landing without guessing.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function robotsTxt(req, res) {
  const sitemapUrl = new URL('/sitemap.xml', env.appUrl).toString();
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /app',
    'Disallow: /api',
    '',
    `Sitemap: ${sitemapUrl}`,
    '',
  ].join('\n');

  res.type('text/plain').send(body);
}

/**
 * Serves a static sitemap. Milestone 1 has exactly one indexable page, so the list is hard-coded; when more public
 * pages appear they must be added here in the same change.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function sitemapXml(req, res) {
  const homeUrl = new URL('/', env.appUrl).toString();
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url>',
    `    <loc>${homeUrl}</loc>`,
    '    <changefreq>monthly</changefreq>',
    '    <priority>1.0</priority>',
    '  </url>',
    '</urlset>',
    '',
  ].join('\n');

  res.type('application/xml').send(body);
}

/**
 * HTML 404 for page requests. It reuses the public layout and marks itself `noindex` so a mistyped URL never
 * becomes a search result. API requests keep the JSON contract and are handled by the terminal notFound middleware.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function notFoundPage(req, res) {
  const seo = buildSeo({
    title: 'Страница не найдена — Метрика',
    description: 'Такой страницы нет. Вернитесь на главную или войдите в демо-версию «Метрики».',
    path: req.path,
    noindex: true,
  });

  res.status(404).render('errors/404', {
    layout: 'layouts/public',
    seo,
    jsonLd: seo.jsonLd,
    year: new Date().getFullYear(),
  });
}
