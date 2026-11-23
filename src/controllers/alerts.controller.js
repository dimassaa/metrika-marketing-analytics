import { can } from '../config/permissions.js';
import { METRICS_CONFIG } from '../config/metrics.js';
import { buildQueryString } from '../lib/query.js';
import { parseQuery } from '../lib/validation.js';
import { alertsPageQuerySchema, alertsQuerySchema, alertDismissSchema } from '../validators/alerts.schema.js';
import { buildShellLocals } from './app.controller.js';

/**
 * @param {import('express').Request} req
 * @returns {{ id: string, ip: string | null }}
 */
function actorOf(req) {
  return { id: req.session.user.id, ip: req.ip ?? null };
}

/**
 * Reads the filters a mutation form replays. A direct POST without fields falls back to the screen defaults, which
 * is exactly what the redirect target shows.
 * @param {Record<string, unknown>} source
 * @returns {{ status: string, severity: string, channelId: string | null, page: number }}
 */
function filterState(source = {}) {
  const status = ['active', 'all', 'resolved', 'dismissed'].includes(String(source.status))
    ? String(source.status)
    : 'active';
  const severity = ['all', 'warning', 'critical'].includes(String(source.severity))
    ? String(source.severity)
    : 'all';
  const channelId = typeof source.channelId === 'string' && /^\d+$/.test(source.channelId)
    ? source.channelId
    : null;
  const page = Number.isInteger(Number(source.page)) && Number(source.page) >= 1
    ? Number(source.page)
    : 1;
  return { status, severity, channelId, page };
}

/**
 * @param {{ status: string, severity: string, channelId: string | null, page: number }} filters
 * @returns {string} `/app/alerts` plus only the non-default filters.
 */
function alertsHref(filters) {
  const query = buildQueryString({}, {
    status: filters.status === 'active' ? null : filters.status,
    severity: filters.severity === 'all' ? null : filters.severity,
    channelId: filters.channelId,
    page: filters.page === 1 ? null : filters.page,
  });
  return query === '' ? '/app/alerts' : `/app/alerts?${query}`;
}

/**
 * @param {import('express').Request} req
 * @returns {boolean} True when the session throttle window has elapsed for an alert manager.
 */
function autoRecalcDue(req) {
  if (!can(req.session?.user?.role, 'alerts:manage')) return false;
  const last = Number(req.session.alertsRecalculatedAt);
  return !Number.isFinite(last) || last <= 0 || Date.now() - last > METRICS_CONFIG.alerts.autoRecalcMs;
}

/**
 * Alerts page and API controller.
 *
 * One instance is built for the page and another with `alertsApi: true` for JSON. They share the loader, the screen
 * model and the service calls, so the page's `data-props` and `/api/v1/alerts` are the same object by construction.
 * The page instance owns the automatic recalculation; the API instance never writes on a GET.
 *
 * @param {{
 *   services: { alerts: object },
 *   screenModels: { alerts: Function },
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 *   channelsRepository?: ReturnType<typeof import('../repositories/channels.repo.js').createChannelsRepository> | null,
 *   alertsApi?: boolean,
 * }} deps
 */
export function createAlertsController({
  services,
  screenModels,
  referenceRepository,
  channelsRepository = null,
  alertsApi = false,
}) {
  const schema = alertsApi ? alertsQuerySchema : alertsPageQuerySchema;

  /**
   * @param {import('express').Request} req
   * @param {{ query?: object, anchor?: string }} [prepared] Already parsed query and anchor, so the page parses once.
   * @returns {Promise<{ query: object, anchor: string, screen: object }>}
   */
  async function load(req, { query: preparedQuery, anchor: preparedAnchor } = {}) {
    const query = preparedQuery ?? parseQuery(schema, req.query);
    const anchor = preparedAnchor ?? (await referenceRepository.getDataAnchor());
    const windows = services.alerts.resolveWindows(anchor);
    const list = await services.alerts.list({
      filters: { status: query.status, severity: query.severity, channelId: query.channelId },
      page: query.page,
    });
    const channels = channelsRepository ? await channelsRepository.listChannels() : [];

    return {
      query,
      anchor,
      screen: screenModels.alerts({
        window: windows,
        rows: list.rows,
        summary: {
          ...list.summary,
          page: list.page,
          total: list.total,
          hasMore: list.hasMore,
        },
        filters: { status: query.status, severity: query.severity, channelId: query.channelId },
        filterOptions: { channels },
      }),
    };
  }

  return {
    load,

    /**
     * Renders the alerts frame. An alert manager gets one throttled recalculation per session window; a viewer's GET
     * is strictly read-only. The label inside the model still comes from `MAX(detected_at)`.
     * @type {import('express').RequestHandler}
     */
    async page(req, res) {
      const query = parseQuery(schema, req.query);
      const anchor = await referenceRepository.getDataAnchor();
      if (autoRecalcDue(req)) {
        await services.alerts.recalculate({ anchor, actor: actorOf(req) });
        req.session.alertsRecalculatedAt = Date.now();
      }
      const { screen } = await load(req, { query, anchor });

      res.set('Cache-Control', 'no-store');
      res.status(200).render('pages/alerts', {
        ...buildShellLocals(req, { title: 'Алерты', activeNav: 'alerts', dataAnchor: anchor }),
        model: screen,
        islandEntries: ['alerts'],
        currentPath: '/app/alerts',
      });
    },

    /**
     * Manual recalculation. It deliberately ignores the session throttle: a person pressing the button asked for a
     * fresh check even if the page just ran one. The redirect keeps the current filters so the table is unchanged.
     * @type {import('express').RequestHandler}
     */
    async recalculate(req, res) {
      const anchor = await referenceRepository.getDataAnchor();
      const counts = await services.alerts.recalculate({ anchor, actor: actorOf(req) });
      req.session.alertsRecalculatedAt = Date.now();

      if (alertsApi) {
        res.set('Cache-Control', 'no-store');
        res.status(200).json({ recalculated: counts });
        return;
      }
      res.redirect(302, alertsHref(filterState(req.body)));
    },

    /**
     * Dismisses one active alert and records `alert.dismiss` in the same transaction. A duplicate dismissal is a 400
     * from the service; the API gets JSON and the page gets the short text contract.
     * @type {import('express').RequestHandler}
     */
    async dismiss(req, res) {
      const parsed = parseQuery(alertDismissSchema, req.body);
      const dismissed = await services.alerts.dismiss({
        id: req.params.id,
        reason: parsed.reason ?? null,
        actor: actorOf(req),
      });

      if (alertsApi) {
        res.set('Cache-Control', 'no-store');
        res.status(200).json({ alert: dismissed });
        return;
      }
      res.redirect(302, alertsHref(filterState(req.body)));
    },
  };
}
