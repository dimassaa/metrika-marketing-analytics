const USER_COLUMNS = 'id, email, password_hash, full_name, role, is_active, last_login_at';

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
  };
}
