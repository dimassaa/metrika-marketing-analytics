import { buildSeo } from '../lib/seo.js';
import { formatDateRu } from '../lib/dates.js';

/** Russian role names shown in the sidebar footer and the user table; the codes stay English in the database. */
const ROLE_LABELS = Object.freeze({ admin: 'Администратор', analyst: 'Аналитик', viewer: 'Наблюдатель' });

/**
 * @param {string | null | undefined} role Role code from the session.
 * @returns {string} Russian label, or the raw code for a role this build does not know (never shown in a normal run).
 */
export function roleLabel(role) {
  return ROLE_LABELS[role] ?? String(role ?? '');
}

/**
 * Builds the short avatar label from the user's full name: first letters of the first and last words.
 * @param {string | null | undefined} fullName
 * @returns {string} One or two uppercase letters.
 */
export function initialsOf(fullName) {
  const words = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return `${first}${last}`.toUpperCase();
}

/**
 * Formats the data anchor for the topbar. The anchor is a calendar date (`YYYY-MM-DD`), so the shared Minsk date
 * formatter is the only conversion needed; the wrapper names the intent at the call site.
 * @param {string} anchorDate `YYYY-MM-DD`.
 * @returns {string} `DD.MM.YYYY`.
 */
export function formatAnchorRu(anchorDate) {
  return formatDateRu(anchorDate);
}

/**
 * Locals every authenticated page shares: layout, noindex metadata, page title, active sidebar item, data anchor
 * and the identity block in the topbar. Keeping them in one function means the shell cannot drift between screens.
 * @param {import('express').Request} req
 * @param {{ title: string, activeNav: string, dataAnchor: string }} page
 * @returns {Record<string, unknown>}
 */
export function buildShellLocals(req, { title, activeNav, dataAnchor }) {
  const user = req.session.user;
  return {
    layout: 'layouts/app',
    seo: buildSeo({
      title: `${title} — Метрика`,
      // Authenticated pages are noindex, so the description only serves link previews and accessibility tooling.
      description: `${title}: раздел демо-стенда «Метрика» — CAC, LTV и ROMI по каналам магазина «Зёрна».`,
      path: `${req.baseUrl}${req.path}`,
      noindex: true,
    }),
    pageTitle: title,
    activeNav,
    dataAnchor: formatAnchorRu(dataAnchor),
    initials: initialsOf(user.fullName),
    roleLabel: roleLabel(user.role),
  };
}

/**
 * @param {{ referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository> }} deps
 */
export function createAppController({ referenceRepository }) {
  /**
   * Renders one screen inside the app shell.
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {{ view: string, title: string, activeNav: string, viewModel?: Record<string, unknown> }} page
   * @returns {Promise<void>}
   */
  async function renderPage(req, res, { view, title, activeNav, viewModel = {} }) {
    const dataAnchor = await referenceRepository.getDataAnchor();
    res.render(view, { ...buildShellLocals(req, { title, activeNav, dataAnchor }), ...viewModel });
  }

  return {
    /**
     * Dashboard for milestone 1. There is no metrics engine yet, so the view model states that honestly: the
     * template renders four KPI placeholders and an empty state instead of inventing numbers.
     * @type {import('express').RequestHandler}
     */
    async dashboard(req, res) {
      await renderPage(req, res, {
        view: 'pages/dashboard',
        title: 'Дашборд',
        activeNav: 'dashboard',
        viewModel: { kpis: null, isEmpty: true },
      });
    },

    /**
     * Honest placeholder for a section that exists in the navigation but ships in a later milestone.
     * @param {{ title: string, activeNav: string }} section
     * @returns {import('express').RequestHandler}
     */
    comingSoon({ title, activeNav }) {
      return async (req, res) => {
        await renderPage(req, res, { view: 'pages/coming-soon', title, activeNav });
      };
    },
  };
}
