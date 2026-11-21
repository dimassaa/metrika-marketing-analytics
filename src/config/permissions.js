/**
 * Role → permission matrix. Permissions are additive: every analyst can do everything a viewer can, and the admin
 * inherits the analyst set. Keeping the lists flat makes an accidental privilege escalation a visible diff.
 */
const VIEWER = [
  'dashboard:view',
  'channels:view',
  'campaigns:view',
  'cohorts:view',
  'attribution:view',
  'scenarios:view',
  'alerts:view',
  'goals:view',
  'export',
];

const ANALYST = [
  ...VIEWER,
  'channels:manage',
  'campaigns:manage',
  'goals:manage',
  'import:run',
  'scenarios:manage',
  'alerts:manage',
];

const ADMIN = [...ANALYST, 'users:manage', 'audit:view'];

export const PERMISSIONS = { viewer: VIEWER, analyst: ANALYST, admin: ADMIN };

/**
 * @param {string | null | undefined} role User role from the session.
 * @param {string} permission Permission code such as `users:manage`.
 * @returns {boolean} True only when the role exists and explicitly carries the permission.
 */
export function can(role, permission) {
  return (PERMISSIONS[role] ?? []).includes(permission);
}
