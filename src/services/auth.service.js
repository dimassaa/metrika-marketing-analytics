import { verify } from '@node-rs/argon2';
import { UnauthorizedError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/** One message for unknown e-mail, wrong password and inactive account: the response must not enumerate users. */
const GENERIC_LOGIN_ERROR = 'Неверный email или пароль';
/**
 * Valid argon2id hash of a throwaway string. Unknown e-mails are checked against it so a failed lookup costs the same
 * argon2 work as a wrong password and response timing does not reveal whether the account exists.
 */
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$+I25QUnAYkb5IzWjJuSOKw$mLNH9uM/c3KNdEKLSZAzg05N49Gm064Ffza2/BIp1W4';

/**
 * @param {string} email
 * @returns {string} Trimmed, lower-cased address used for lookup and the rate-limit key.
 */
export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

/**
 * Authentication rules. Express is invisible here: the service gets primitives, talks to repositories and returns a
 * session-safe user object without the password hash.
 * @param {{ usersRepository: ReturnType<typeof import('../repositories/users.repo.js').createUsersRepository> }} deps
 */
export function createAuthService({ usersRepository }) {
  return {
    /**
     * Verifies credentials and updates `last_login_at` on success.
     * @param {string} email
     * @param {string} password Plain password from the form; never logged or stored.
     * @param {string | null} [ip] Caller address, used only for the failed-attempt log line.
     * @returns {Promise<{ id: string, email: string, fullName: string, role: string }>}
     * @throws {UnauthorizedError} For unknown e-mail, wrong password and inactive account alike.
     */
    async login(email, password, ip) {
      const normalizedEmail = normalizeEmail(email);
      const user = await usersRepository.findByEmail(normalizedEmail);
      const passwordMatches = await verify(user?.passwordHash ?? DUMMY_HASH, password);

      if (!user || !user.isActive || !passwordMatches) {
        logger.warn({ ip, email: normalizedEmail }, 'login rejected');
        throw new UnauthorizedError(GENERIC_LOGIN_ERROR);
      }

      await usersRepository.touchLastLogin(user.id);

      return { id: user.id, email: user.email, fullName: user.fullName, role: user.role };
    },
  };
}
