/**
 * Every action written to `audit_log`, in one frozen map.
 *
 * The database stores the string, so this module is the only source for both the writers and the `/app/audit`
 * action filter: a typo in a call site becomes a missing property instead of a silently unfilterable row.
 * Codes are lower snake_case under a dotted entity prefix, matching the M1 `auth.login` row already in the table.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const AUDIT_ACTIONS = Object.freeze({
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGOUT: 'auth.logout',

  CHANNEL_CREATE: 'channel.create',
  CHANNEL_UPDATE: 'channel.update',
  CHANNEL_ARCHIVE: 'channel.archive',
  CHANNEL_RESTORE: 'channel.restore',

  CAMPAIGN_CREATE: 'campaign.create',
  CAMPAIGN_UPDATE: 'campaign.update',
  CAMPAIGN_DELETE: 'campaign.delete',

  USER_CREATE: 'user.create',
  USER_ROLE_CHANGE: 'user.role_change',
  USER_DEACTIVATE: 'user.deactivate',
  USER_ACTIVATE: 'user.activate',
  USER_PASSWORD_RESET: 'user.password_reset',
  USER_PASSWORD_CHANGE: 'user.password_change',

  GOAL_CREATE: 'goal.create',
  GOAL_UPDATE: 'goal.update',
  GOAL_DELETE: 'goal.delete',

  IMPORT_RUN: 'import.run',
  EXPORT_CSV: 'export.csv',
  MEDIA_UPLOAD: 'media.upload',
});
