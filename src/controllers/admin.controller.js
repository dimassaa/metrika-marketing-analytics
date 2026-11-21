import { buildShellLocals, roleLabel } from './app.controller.js';
import { formatDateRu } from '../lib/dates.js';

/**
 * Read-only administration screens. Milestone 1 lists the team; creating, blocking and re-roling users arrives with
 * the user-management milestone, so the table carries no action buttons that would not work yet.
 * @param {{
 *   usersRepository: ReturnType<typeof import('../repositories/users.repo.js').createUsersRepository>,
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 * }} deps
 */
export function createAdminController({ usersRepository, referenceRepository }) {
  return {
    /**
     * @type {import('express').RequestHandler}
     */
    async users(req, res) {
      const dataAnchor = await referenceRepository.getDataAnchor();
      const users = (await usersRepository.listForAdmin()).map((user) => ({
        ...user,
        roleLabel: roleLabel(user.role),
        // Date only: M1 has no time-zone-aware time formatter, and the last login date is enough for the roster.
        lastLoginLabel: user.lastLoginAt ? formatDateRu(user.lastLoginAt) : '—',
      }));

      res.render('pages/admin-users', {
        ...buildShellLocals(req, { title: 'Пользователи', activeNav: 'users', dataAnchor }),
        users,
      });
    },
  };
}
