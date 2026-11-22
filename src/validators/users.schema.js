import { z } from 'zod';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '../config/audit-actions.js';

/** Role codes mirror the CHECK constraint in `001_init.sql`. */
export const USER_ROLES = Object.freeze(['admin', 'analyst', 'viewer']);
/** Minimum length agreed for every password this build accepts, including temporary ones. */
export const PASSWORD_MIN_LENGTH = 10;
/** Largest value a PostgreSQL BIGINT primary key can hold (2^63 - 1). */
const MAX_BIGINT_ID = 9223372036854775807n;

const AUDIT_ACTIONS_LIST = Object.freeze(Object.values(AUDIT_ACTIONS));

const emailField = z
  .string({ error: 'Укажите email' })
  .trim()
  .toLowerCase()
  .min(1, 'Укажите email')
  .max(254, 'Email не длиннее 254 символов')
  .pipe(z.email('Введите корректный email'));

const fullNameField = z
  .string({ error: 'Укажите имя пользователя' })
  .trim()
  .min(2, 'Имя: минимум 2 символа')
  .max(120, 'Имя не длиннее 120 символов');

const roleField = z.enum(USER_ROLES, 'Выберите роль: admin, analyst или viewer');

const passwordField = z
  .string({ error: 'Укажите пароль' })
  .min(PASSWORD_MIN_LENGTH, `Пароль: минимум ${PASSWORD_MIN_LENGTH} символов`)
  .max(128, 'Пароль не длиннее 128 символов')
  // Leading/trailing spaces are a common paste artefact; trimming would silently change the secret, so reject them
  // instead of storing a password the person cannot reproduce.
  .refine((value) => value === value.trim(), 'Пароль не должен начинаться или заканчиваться пробелом');

/** `POST /app/admin/users` — an administrator types the temporary password shown to the new teammate. */
export const userCreateSchema = z.object({
  email: emailField,
  fullName: fullNameField,
  role: roleField,
  password: passwordField,
});

/** `POST /app/admin/users/:id/role`. */
export const userRoleSchema = z.object({ role: roleField });

/** `POST /app/profile/password`. */
export const ownPasswordSchema = z.object({
  currentPassword: z
    .string({ error: 'Укажите текущий пароль' })
    .min(1, 'Укажите текущий пароль')
    .max(1024, 'Текущий пароль слишком длинный'),
  newPassword: passwordField,
});

/**
 * Validates the `:id` route param before it reaches SQL. A digit string above 2^63 - 1 would make `$1::bigint`
 * raise SQLSTATE 22003 and turn a hand-typed URL into a 500, so it gets the same designed 404 as a missing user.
 * @param {unknown} value Raw `:id` route param.
 * @returns {string | null} Digit string inside the BIGINT range, or null.
 */
export function parseUserId(value) {
  const id = String(value ?? '');
  if (!/^\d+$/.test(id)) return null;
  const numeric = BigInt(id);
  return numeric >= 1n && numeric <= MAX_BIGINT_ID ? id : null;
}

/**
 * Query-string filters for the audit journal. An unknown entity, action or actor falls back to `all` so a stale
 * bookmarked URL keeps working instead of returning a 400 page.
 */
export const auditFiltersSchema = z.object({
  entity: z.enum(['all', ...AUDIT_ENTITIES]).catch('all'),
  userId: z
    .string()
    .optional()
    .transform((value) => parseUserId(value) ?? 'all')
    .catch('all'),
  action: z
    .string()
    .optional()
    .transform((value) => (value && AUDIT_ACTIONS_LIST.includes(value) ? value : 'all'))
    .catch('all'),
  page: z.coerce.number().int().min(1).catch(1),
});

/**
 * Keeps a rejected creation form usable: only strings of a sane length reach the template, the role select always
 * has a valid option, and the password is never echoed back into HTML.
 * @param {Record<string, unknown> | undefined} body
 * @returns {{ email: string, fullName: string, role: string, password: string }}
 */
export function userFormValues(body) {
  const text = (value) => (typeof value === 'string' ? value.slice(0, 254) : '');
  const role = text(body?.role);
  return {
    email: text(body?.email),
    fullName: text(body?.fullName),
    role: USER_ROLES.includes(role) ? role : 'viewer',
    password: '',
  };
}
