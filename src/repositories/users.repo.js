const USER_COLUMNS = 'id, email, password_hash, full_name, role, is_active, last_login_at';
// The admin list never needs the password hash, so it selects an explicit subset instead of reusing USER_COLUMNS.
const USER_LIST_COLUMNS = 'id, email, full_name, role, is_active, last_login_at';

/**
 * Maps a `users` row to the shape the service layer works with. PostgreSQL returns BIGINT as a string, and that is
 * fine everywhere a user id is used (session, audit foreign key), so no lossy numeric conversion happens here.
 * @param {Record<string, any>} row
 * @returns {{ id: string, email: string, passwordHash: string, fullName: string, role: string, isActive: boolean,
 *   lastLoginAt: Date | null }}
 */
function mapUser(row) {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    fullName: row.full_name,
    role: row.role,
    isActive: row.is_active,
    lastLoginAt: row.last_login_at,
  };
}

/**
 * Maps a `users` row for read-only administration; unlike `mapUser` it deliberately carries no credentials.
 * @param {Record<string, any>} row
 * @returns {{ id: string, email: string, fullName: string, role: string, isActive: boolean,
 *   lastLoginAt: Date | null }}
 */
function mapUserListItem(row) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    isActive: row.is_active,
    lastLoginAt: row.last_login_at,
  };
}

/**
 * Data access for the `users` table. The database handle is injected by `createApp` so the auth tests stay on the
 * test pool while production uses the shared pool.
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 */
export function createUsersRepository(db) {
  return {
    /**
     * Case-insensitive lookup by e-mail. `lower(email)` is unique-indexed, so this stays an index scan.
     * @param {string} email Already normalised by the auth service.
     * @returns {Promise<ReturnType<typeof mapUser> | null>}
     */
    async findByEmail(email) {
      const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1)`, [email]);
      return rows[0] ? mapUser(rows[0]) : null;
    },

    /**
     * Records a successful login. The `updated_at` trigger fires on this UPDATE as a side effect.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async touchLastLogin(id) {
      await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
    },

    /**
     * Read-only roster for the administration screen. Ordered by role then e-mail so the three roles stay grouped
     * without the page having to sort; the admin table has no pagination in M1 because the demo has three accounts.
     * @returns {Promise<ReturnType<typeof mapUserListItem>[]>}
     */
    async listForAdmin() {
      const { rows } = await db.query(`SELECT ${USER_LIST_COLUMNS} FROM users ORDER BY role, lower(email)`);
      return rows.map(mapUserListItem);
    },
  };
}
