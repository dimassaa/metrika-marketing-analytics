import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../config/audit-actions.js';

/** Page size fixed by the brief: the journal is scanned fifty rows at a time. */
export const AUDIT_PAGE_SIZE = 50;

/** Russian labels for the action codes. Keys mirror `AUDIT_ACTIONS`; an unknown code falls back to the raw string. */
const ACTION_LABELS = Object.freeze({
  [AUDIT_ACTIONS.AUTH_LOGIN]: 'Вход в систему',
  [AUDIT_ACTIONS.AUTH_LOGOUT]: 'Выход из системы',
  [AUDIT_ACTIONS.CHANNEL_CREATE]: 'Создание канала',
  [AUDIT_ACTIONS.CHANNEL_UPDATE]: 'Изменение канала',
  [AUDIT_ACTIONS.CHANNEL_ARCHIVE]: 'Архивация канала',
  [AUDIT_ACTIONS.CHANNEL_RESTORE]: 'Возврат канала из архива',
  [AUDIT_ACTIONS.CAMPAIGN_CREATE]: 'Создание кампании',
  [AUDIT_ACTIONS.CAMPAIGN_UPDATE]: 'Изменение кампании',
  [AUDIT_ACTIONS.CAMPAIGN_DELETE]: 'Удаление кампании',
  [AUDIT_ACTIONS.USER_CREATE]: 'Создание пользователя',
  [AUDIT_ACTIONS.USER_ROLE_CHANGE]: 'Смена роли',
  [AUDIT_ACTIONS.USER_DEACTIVATE]: 'Блокировка пользователя',
  [AUDIT_ACTIONS.USER_ACTIVATE]: 'Разблокировка пользователя',
  [AUDIT_ACTIONS.USER_PASSWORD_RESET]: 'Сброс пароля',
  [AUDIT_ACTIONS.USER_PASSWORD_CHANGE]: 'Смена своего пароля',
  [AUDIT_ACTIONS.GOAL_CREATE]: 'Создание цели',
  [AUDIT_ACTIONS.GOAL_UPDATE]: 'Изменение цели',
  [AUDIT_ACTIONS.GOAL_DELETE]: 'Удаление цели',
  [AUDIT_ACTIONS.IMPORT_RUN]: 'Импорт данных',
  [AUDIT_ACTIONS.EXPORT_CSV]: 'Экспорт CSV',
  [AUDIT_ACTIONS.MEDIA_UPLOAD]: 'Загрузка файла',
});

const ENTITY_LABELS = Object.freeze({
  user: 'Пользователь',
  channel: 'Канал',
  campaign: 'Кампания',
  goal: 'Цель',
  import: 'Импорт',
  media: 'Файл',
});

/**
 * Russian labels for the role codes shown in audit payload summaries.
 */
const ROLE_LABELS = Object.freeze({ admin: 'администратор', analyst: 'аналитик', viewer: 'наблюдатель' });

/**
 * Payload keys that may be rendered. Everything else stays in the database: a future writer that puts a token or a
 * password into `payload` must not leak it just because the journal screen renders JSON.
 */
const DETAIL_KEYS = Object.freeze([
  ['email', 'Почта'],
  ['fullName', 'Имя'],
  ['role', 'Роль'],
  ['name', 'Название'],
  ['code', 'Код'],
  ['filename', 'Файл'],
]);

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Minsk',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** Non-breaking space between date and time: a screenshot never wraps the label in the middle. */
const NBSP = '\u00a0';

/**
 * `DD.MM.YYYY HH:mm` in Europe/Minsk. Audit entries need the time of day, which the shared date-only formatter drops.
 * The parts are assembled manually because `ru-RU` inserts a comma and narrow spaces that vary between ICU builds.
 * @param {Date | string} value
 * @returns {string}
 */
function formatDateTimeMinsk(value) {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return '—';
  const parts = Object.fromEntries(
    dateTimeFormatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return `${parts.day}.${parts.month}.${parts.year}${NBSP}${parts.hour}:${parts.minute}`;
}

/**
 * One-line summary of the safe payload keys, e.g. «Роль: аналитик · Почта: junior@metrika.by».
 * @param {Record<string, unknown>} payload
 * @returns {string} Empty string when the payload has nothing displayable.
 */
function summarisePayload(payload) {
  const parts = [];
  for (const [key, label] of DETAIL_KEYS) {
    const value = payload?.[key];
    if (value === null || value === undefined || value === '') continue;
    const text = key === 'role' ? ROLE_LABELS[value] ?? String(value) : String(value);
    parts.push(`${label}: ${text}`);
    if (parts.length === 3) break;
  }
  return parts.join(' · ');
}

/**
 * Adds Russian labels and a formatted timestamp to one repository row.
 * @param {{
 *   id: string, userId: string | null, userEmail: string | null, action: string, entity: string,
 *   entityId: string | null, payload: Record<string, unknown>, createdAt: Date,
 * }} entry
 * @returns {Record<string, unknown>}
 */
function toView(entry) {
  return {
    ...entry,
    actionLabel: ACTION_LABELS[entry.action] ?? entry.action,
    entityLabel: ENTITY_LABELS[entry.entity] ?? entry.entity,
    actorLabel: entry.userEmail ?? 'Система',
    createdAtLabel: formatDateTimeMinsk(entry.createdAt),
    detail: summarisePayload(entry.payload),
  };
}

/**
 * Writes and reads the audit journal. The service exists so controllers describe an event instead of composing SQL
 * columns, and so the "no secrets in payload" rule has one place to live.
 * @param {{ auditRepository: ReturnType<typeof import('../repositories/audit.repo.js').createAuditRepository> }} deps
 */
export function createAuditService({ auditRepository }) {
  return {
    /**
     * Options for the journal filter selects. Both lists come from the config vocabulary (`AUDIT_ACTIONS`,
     * `AUDIT_ENTITIES`), so a new writer appears in the filter without a second hard-coded array in the controller.
     * @returns {{
     *   actions: Array<{ value: string, label: string }>,
     *   entities: Array<{ value: string, label: string }>,
     * }}
     */
    getFilterOptions() {
      return {
        actions: Object.values(AUDIT_ACTIONS).map((value) => ({ value, label: ACTION_LABELS[value] ?? value })),
        entities: AUDIT_ENTITIES.map((value) => ({ value, label: ENTITY_LABELS[value] ?? value })),
      };
    },

    /**
     * @param {object} entry
     * @param {string | null} [entry.userId]
     * @param {string} entry.action
     * @param {string} entry.entity
     * @param {string | null} [entry.entityId]
     * @param {Record<string, unknown>} [entry.payload] Never put passwords, tokens or session ids here.
     * @param {string | null} [entry.ip]
     * @returns {Promise<void>}
     */
    async record({ userId = null, action, entity, entityId = null, payload = {}, ip = null }) {
      await auditRepository.insert({ userId, action, entity, entityId, payload, ip });
    },

    /**
     * One page of the journal, newest first. `all` filters become NULL so the SQL condition is skipped.
     * @param {{ entity?: string, userId?: string, action?: string, page?: number }} [filters]
     * @returns {Promise<{
     *   entries: object[],
     *   total: number,
     *   page: number,
     *   pageSize: number,
     *   pageCount: number,
     *   filters: { entity: string, userId: string, action: string },
     * }>}
     */
    async listAuditEntries({ entity = 'all', userId = 'all', action = 'all', page = 1 } = {}) {
      const repositoryFilters = {
        entity: entity === 'all' ? null : entity,
        userId: userId === 'all' ? null : userId,
        action: action === 'all' ? null : action,
      };

      const total = await auditRepository.count(repositoryFilters);
      const pageCount = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
      // A bookmarked page past the end shows the last page instead of an empty table with a bogus range.
      const effectivePage = Math.min(Math.max(1, page), pageCount);
      const entries = await auditRepository.list({
        filters: repositoryFilters,
        limit: AUDIT_PAGE_SIZE,
        offset: (effectivePage - 1) * AUDIT_PAGE_SIZE,
      });

      return {
        entries: entries.map(toView),
        total,
        page: effectivePage,
        pageSize: AUDIT_PAGE_SIZE,
        pageCount,
        filters: { entity, userId, action },
      };
    },
  };
}
