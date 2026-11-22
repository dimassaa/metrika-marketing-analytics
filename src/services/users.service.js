import { randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { AUDIT_ACTIONS } from '../config/audit-actions.js';
import { withTransaction } from '../lib/db.js';
import { formatDateRu } from '../lib/dates.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { createUsersRepository } from '../repositories/users.repo.js';

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
 *   db: { connect: () => Promise<import('pg').PoolClient> },
 *   usersRepository: ReturnType<typeof import('../repositories/users.repo.js').createUsersRepository>,
 *   auditService: ReturnType<typeof import('./audit.service.js').createAuditService>,
 * }} deps
 */
export function createUsersService({ db, usersRepository, auditService }) {
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
      const outcome = await withTransaction(db, async (client) => {
        const repository = createUsersRepository(client);
        // Lock the admin set first, in id order, then the target: two concurrent changes wait on the same rows
        // instead of each holding one target and waiting for the other.
        const activeAdmins = await repository.lockActiveAdmins();
        const target = await repository.findByIdForUpdate(targetId);
        if (!target) throw new NotFoundError('Пользователь не найден');

        if (target.id === actor?.id && target.role === 'admin' && role !== 'admin') {
          throw new ValidationError(SELF_GUARD);
        }
        // An idempotent re-submit must not log the person out by revoking sessions for a role they already have.
        if (target.role === role) return { target, updated: toView(target), changed: false };

        const otherAdmins = activeAdmins.filter((admin) => admin.id !== targetId).length;
        if (target.role === 'admin' && target.isActive && role !== 'admin' && otherAdmins === 0) {
          throw new ValidationError(LAST_ADMIN_GUARD);
        }

        const updated = await repository.updateRole(targetId, role);
        if (!updated) throw new NotFoundError('Пользователь не найден');
        // The role lives in `sess->'user'->>'role'`; leaving the row alive would hide the demotion until the TTL.
        await repository.deleteUserSessions(targetId);
        return { target, updated, changed: true };
      });

      if (outcome.changed) {
        await recordAudit(actor, AUDIT_ACTIONS.USER_ROLE_CHANGE, outcome.updated, {
          previousRole: outcome.target.role,
          role,
        });
      }
      return toView(outcome.updated);
    },

    /**
     * @param {string} targetId
     * @param {boolean} isActive Desired state, derived by the controller from the current row.
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<object>} Updated account view model.
     * @throws {NotFoundError} When the account does not exist.
     * @throws {ValidationError} When the actor blocks themselves or blocks the last active administrator.
     */
    async toggleUserActive(targetId, isActive, actor) {
      const outcome = await withTransaction(db, async (client) => {
        const repository = createUsersRepository(client);
        const activeAdmins = await repository.lockActiveAdmins();
        const target = await repository.findByIdForUpdate(targetId);
        if (!target) throw new NotFoundError('Пользователь не найден');

        if (target.id === actor?.id && !isActive) throw new ValidationError(SELF_GUARD);
        if (target.isActive === isActive) return { target, updated: toView(target), changed: false };

        const otherAdmins = activeAdmins.filter((admin) => admin.id !== targetId).length;
        if (!isActive && target.role === 'admin' && target.isActive && otherAdmins === 0) {
          throw new ValidationError(LAST_ADMIN_GUARD);
        }

        const updated = await repository.setActive(targetId, isActive);
        if (!updated) throw new NotFoundError('Пользователь не найден');
        if (!isActive) await repository.deleteUserSessions(targetId);
        return { target, updated, changed: true };
      });

      if (outcome.changed) {
        await recordAudit(
          actor,
          isActive ? AUDIT_ACTIONS.USER_ACTIVATE : AUDIT_ACTIONS.USER_DEACTIVATE,
          outcome.updated,
          { role: outcome.updated.role },
        );
      }
      return toView(outcome.updated);
    },

    /**
     * Sets a one-time password and revokes every session of the target, so a person who forgot the password cannot
     * keep using an old tab. The caller stores `temporaryPassword` in a one-GET flash; it is never audited.
     * @param {string} targetId
     * @param {string} newPassword Generated by `generateTemporaryPassword`.
     * @param {{ id?: string, ip?: string } | null} actor
     * @returns {Promise<{ user: object, temporaryPassword: string }>}
     * @throws {NotFoundError} When the account does not exist.
     */
    async resetUserPassword(targetId, newPassword, actor) {
      const outcome = await withTransaction(db, async (client) => {
        const repository = createUsersRepository(client);
        const target = await repository.findByIdForUpdate(targetId);
        if (!target) throw new NotFoundError('Пользователь не найден');

        const passwordHash = await hash(newPassword);
        const updated = await repository.updateUserPasswordHash(targetId, passwordHash);
        if (!updated) throw new NotFoundError('Пользователь не найден');

        await repository.deleteUserSessions(targetId);
        return target;
      });

      await recordAudit(actor, AUDIT_ACTIONS.USER_PASSWORD_RESET, outcome);
      return { user: toView(outcome), temporaryPassword: newPassword };
    },

    /**
     * Changes the caller's own password after verifying the current one and revokes every *other* session. Keeping
     * the current session avoids logging the person out of the browser they are using; if the caller cannot name
     * its session, every session is revoked and the controller's redirect ends at `/login`.
     * @param {string} userId
     * @param {{ currentPassword: string, newPassword: string }} input
     * @param {{ id?: string, ip?: string, sessionId?: string } | null} actor
     * @returns {Promise<{ currentSessionKept: boolean }>}
     * @throws {NotFoundError} When the account vanished.
     * @throws {ValidationError} When the current password does not match.
     */
    async changeOwnPassword(userId, { currentPassword, newPassword }, actor) {
      const outcome = await withTransaction(db, async (client) => {
        const repository = createUsersRepository(client);
        const user = await repository.findByIdForUpdate(userId);
        if (!user) throw new NotFoundError('Пользователь не найден');

        const matches = await verify(user.passwordHash, currentPassword);
        if (!matches) throw new ValidationError(WRONG_CURRENT_PASSWORD);

        const passwordHash = await hash(newPassword);
        const updated = await repository.updateUserPasswordHash(userId, passwordHash);
        if (!updated) throw new NotFoundError('Пользователь не найден');

        if (typeof actor?.sessionId === 'string' && actor.sessionId.length > 0) {
          await repository.deleteUserSessionsExcept(userId, actor.sessionId);
          return { user, currentSessionKept: true };
        }
        await repository.deleteUserSessions(userId);
        return { user, currentSessionKept: false };
      });

      await recordAudit(actor, AUDIT_ACTIONS.USER_PASSWORD_CHANGE, outcome.user);
      return { currentSessionKept: outcome.currentSessionKept };
    },
  };
}
