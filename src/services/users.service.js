import { randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { AUDIT_ACTIONS } from '../config/audit-actions.js';
import { formatDateRu } from '../lib/dates.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';

const DUPLICATE_EMAIL = 'Пользователь с таким email уже существует';
const SELF_GUARD = 'Нельзя заблокировать собственную учётную запись или снять с себя роль администратора';
const LAST_ADMIN_GUARD = 'Нельзя оставить систему без активного администратора';
const WRONG_CURRENT_PASSWORD = 'Текущий пароль указан неверно';

/** Unambiguous characters: no `0/O`, `1/l/I`, so a temporary password can be retyped from a screenshot. */
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const TEMP_PASSWORD_GROUPS = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789'];
const TEMP_PASSWORD_LENGTH = 14;

/**
 * Generates the one-time password shown after a reset. At least one character from each group keeps it acceptable
 * even if a future password policy requires mixed case and digits.
 * @param {number} [length]
 * @returns {string}
 */
export function generateTemporaryPassword(length = TEMP_PASSWORD_LENGTH) {
  const chars = TEMP_PASSWORD_GROUPS.map((group) => group[randomInt(group.length)]);
  while (chars.length < Math.max(length, TEMP_PASSWORD_GROUPS.length)) {
    chars.push(TEMP_PASSWORD_ALPHABET[randomInt(TEMP_PASSWORD_ALPHABET.length)]);
  }
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [chars[index], chars[swap]] = [chars[swap], chars[index]];
  }
  return chars.join('');
}

/**
 * Administration view model. The fields are picked explicitly, so a `findById` row that also carries
 * `passwordHash` can never leak the hash into a template or a controller's result object.
 * @param {object} user Row from `listForAdmin` or `findById`.
 */
function toView(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
    statusLabel: user.isActive ? 'Активен' : 'Заблокирован',
    lastLoginLabel: user.lastLoginAt ? formatDateRu(user.lastLoginAt) : '—',
  };
}

/**
 * User-administration rules: creation, role changes, blocking and password resets.
 *
 * Session revocation is part of every privilege change, not an optional extra: `requireAuth` trusts the session
 * payload, so a demoted admin would keep `role: 'admin'` for up to eight hours without it. Deleting the rows makes
 * the old cookie anonymous; the next login reads the role from the database again.
 *
 * @param {{
 *   usersRepository: ReturnType<typeof import('../repositories/users.repo.js').createUsersRepository>,
 *   auditService: ReturnType<typeof import('./audit.service.js').createAuditService>,
 * }} deps
 */
export function createUsersService({ usersRepository, auditService }) {
  /**
   * @param {{ id?: string, ip?: string } | null | undefined} actor
   * @param {string} action One of `AUDIT_ACTIONS`.
   * @param {object} user Target account.
   * @param {Record<string, unknown>} [payload] Non-secret details.
   * @returns {Promise<void>}
   */
  async function recordAudit(actor, action, user, payload = {}) {
    await auditService.record({
      userId: actor?.id ?? null,
      action,
      entity: 'user',
      entityId: user.id,
      payload: { email: user.email, ...payload },
      ip: actor?.ip ?? null,
    });
  }

  return {
    /**
     * @returns {Promise<object[]>} All accounts, ordered by role then e-mail.
     */
    async listUsersForView() {
      return (await usersRepository.listForAdmin()).map(toView);
    },

    /**
     * @param {string} id
     * @returns {Promise<object>}
     * @throws {NotFoundError} When the account vanished.
     */
    async getUserForView(id) {
      const user = await usersRepository.findById(id);
      if (!user) throw new NotFoundError('Пользователь не найден');
      return toView(user);
    },

    /**
     * Own profile. Only displayable fields leave this method: the password hash that `findById` carries for the
     * verification path is dropped by `toView`.
     * @param {{ id: string }} user Session identity.
     * @returns {Promise<object>}
     * @throws {NotFoundError} When the account vanished.
     */
    async getOwnProfile(user) {
      const stored = await usersRepository.findById(user.id);
      if (!stored) throw new NotFoundError('Пользователь не найден');
      return toView(stored);
    },

    /**
     * Creates an account with a password supplied by the administrator. The plain password is hashed before it
     * leaves this method and is never written to the audit payload.
     * @param {{ email: string, fullName: string, role: string, password: string }} input Validated by Zod.
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<object>} Created account view model.
     * @throws {ValidationError} When the e-mail is already taken.
     */
    async createUser(input, actor) {
      if (await usersRepository.findByEmail(input.email)) {
        throw new ValidationError(DUPLICATE_EMAIL);
      }

      const passwordHash = await hash(input.password);
      let created;
      try {
        created = await usersRepository.createUser({
          email: input.email,
          passwordHash,
          fullName: input.fullName,
          role: input.role,
        });
      } catch (error) {
        // Two parallel submits both pass the pre-check; the unique index is the real arbiter.
        if (error?.code === '23505') throw new ValidationError(DUPLICATE_EMAIL);
        throw error;
      }

      await recordAudit(actor, AUDIT_ACTIONS.USER_CREATE, created, {
        fullName: created.fullName,
        role: created.role,
      });
      return toView(created);
    },

    /**
     * @param {string} targetId
     * @param {string} role New role.
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<object>} Updated account view model.
     * @throws {NotFoundError} When the account does not exist.
     * @throws {ValidationError} When the actor demotes themselves or removes the last active administrator.
     */
    async changeUserRole(targetId, role, actor) {
      const target = await usersRepository.findById(targetId);
      if (!target) throw new NotFoundError('Пользователь не найден');

      if (target.id === actor?.id && target.role === 'admin' && role !== 'admin') {
        throw new ValidationError(SELF_GUARD);
      }
      // An idempotent re-submit must not log the person out by revoking sessions for a role they already have.
      if (target.role === role) return toView(target);

      const updated = await usersRepository.updateUserRole(targetId, role);
      if (!updated) {
        if (target.role === 'admin' && target.isActive && role !== 'admin') {
          throw new ValidationError(LAST_ADMIN_GUARD);
        }
        throw new NotFoundError('Пользователь не найден');
      }

      // The role lives in `sess->'user'->>'role'`; leaving the row alive would hide the demotion until the TTL.
      await usersRepository.deleteUserSessions(targetId);
      await recordAudit(actor, AUDIT_ACTIONS.USER_ROLE_CHANGE, updated, {
        previousRole: target.role,
        role,
      });
      return toView(updated);
    },

    /**
     * @param {string} targetId
     * @param {boolean} isActive Desired state, derived by the service from the current row.
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<object>} Updated account view model.
     * @throws {NotFoundError} When the account does not exist.
     * @throws {ValidationError} When the actor blocks themselves or blocks the last active administrator.
     */
    async toggleUserActive(targetId, isActive, actor) {
      const target = await usersRepository.findById(targetId);
      if (!target) throw new NotFoundError('Пользователь не найден');

      if (target.id === actor?.id && !isActive) throw new ValidationError(SELF_GUARD);
      if (target.isActive === isActive) return toView(target);

      const updated = await usersRepository.setUserActive(targetId, isActive);
      if (!updated) {
        if (!isActive && target.role === 'admin' && target.isActive) throw new ValidationError(LAST_ADMIN_GUARD);
        throw new NotFoundError('Пользователь не найден');
      }

      if (!isActive) await usersRepository.deleteUserSessions(targetId);
      await recordAudit(actor, isActive ? AUDIT_ACTIONS.USER_ACTIVATE : AUDIT_ACTIONS.USER_DEACTIVATE, updated, {
        role: updated.role,
      });
      return toView(updated);
    },

    /**
     * Sets a one-time password and revokes every session of the target, so a person who forgot the password cannot
     * keep using an old tab. The caller renders `newPassword` once; it is never stored in plain form.
     * @param {string} targetId
     * @param {string} newPassword Generated by `generateTemporaryPassword`.
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<{ user: object, temporaryPassword: string }>}
     * @throws {NotFoundError} When the account does not exist.
     */
    async resetUserPassword(targetId, newPassword, actor) {
      const target = await usersRepository.findById(targetId);
      if (!target) throw new NotFoundError('Пользователь не найден');

      const passwordHash = await hash(newPassword);
      const updated = await usersRepository.updateUserPasswordHash(targetId, passwordHash);
      if (!updated) throw new NotFoundError('Пользователь не найден');

      await usersRepository.deleteUserSessions(targetId);
      await recordAudit(actor, AUDIT_ACTIONS.USER_PASSWORD_RESET, target);
      return { user: toView(target), temporaryPassword: newPassword };
    },

    /**
     * Changes the caller's own password after verifying the current one. No session is revoked: the brief limits
     * mandatory revocation to administrative actions, and killing the live session mid-request would make the
     * person log in again immediately.
     * @param {string} userId
     * @param {{ currentPassword: string, newPassword: string }} input
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<void>}
     * @throws {NotFoundError} When the account vanished.
     * @throws {ValidationError} When the current password does not match.
     */
    async changeOwnPassword(userId, { currentPassword, newPassword }, actor) {
      const user = await usersRepository.findById(userId);
      if (!user) throw new NotFoundError('Пользователь не найден');

      const matches = await verify(user.passwordHash, currentPassword);
      if (!matches) throw new ValidationError(WRONG_CURRENT_PASSWORD);

      const passwordHash = await hash(newPassword);
      const updated = await usersRepository.updateUserPasswordHash(userId, passwordHash);
      if (!updated) throw new NotFoundError('Пользователь не найден');

      await recordAudit(actor, AUDIT_ACTIONS.USER_PASSWORD_CHANGE, user);
    },
  };
}
