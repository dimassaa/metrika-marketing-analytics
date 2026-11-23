import { z } from 'zod';

/**
 * Query and body contracts for the alerts screens and API.
 *
 * The page schema is deliberately tolerant of a stale `status` bookmark: an old link must show the default list with
 * a 200 rather than a dead end. The API schema is strict, because an API client that asks for an unknown status would
 * otherwise receive a silently different report than the one it requested.
 */

const ALERT_STATUSES = Object.freeze(['active', 'all', 'resolved', 'dismissed']);
const ALERT_SEVERITIES = Object.freeze(['all', 'warning', 'critical']);

const STATUS_MESSAGE = 'Статус алерта: active, all, resolved или dismissed';
const SEVERITY_MESSAGE = 'Важность алерта: all, warning или critical';

const strictStatus = z.enum([...ALERT_STATUSES], STATUS_MESSAGE).default('active');
const strictSeverity = z.enum([...ALERT_SEVERITIES], SEVERITY_MESSAGE).default('all');

const lenientStatus = z.enum([...ALERT_STATUSES], STATUS_MESSAGE).catch('active').default('active');
const lenientSeverity = z.enum([...ALERT_SEVERITIES], SEVERITY_MESSAGE).catch('all').default('all');

const channelIdField = z
  .string({ error: 'Некорректный идентификатор канала' })
  .regex(/^\d+$/, 'Некорректный идентификатор канала')
  .optional()
  .transform((value) => value ?? null);

const pageField = z.coerce
  .number({ error: 'Страница указывается числом' })
  .int('Страница указывается целым числом')
  .min(1, 'Страница должна быть положительным числом')
  .default(1);

const lenientPageField = pageField.catch(1);

/** Strict API query: `status=bogus` is a 400, not a silent "active". */
export const alertsQuerySchema = z.object({
  status: strictStatus,
  severity: strictSeverity,
  channelId: channelIdField,
  page: pageField,
});

/** Page query: a stale status/severity/page bookmark falls back to the default list with a 200. */
export const alertsPageQuerySchema = z.object({
  status: lenientStatus,
  severity: lenientSeverity,
  channelId: channelIdField,
  page: lenientPageField,
});

/**
 * Dismissal body. The reason is optional and lives only in the audit journal; the service enforces the same length,
 * so a direct service call and a request cannot drift.
 */
export const alertDismissSchema = z.object({
  reason: z
    .string({ error: 'Причина должна быть строкой' })
    .trim()
    .max(200, 'Причина не длиннее 200 символов')
    .optional()
    .nullable(),
});
