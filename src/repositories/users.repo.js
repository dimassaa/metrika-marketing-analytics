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
 * Runs `fn` on one checked-out client so a privilege check and the update that follows it see the same snapshot.
 *
 * The last-admin rule spans rows: two admins demoting each other concurrently could each see the other as active and
 * leave the system with none. Both operations therefore lock the active admins before deciding. The pool is injected
 * with the repository, so tests never touch the production pool through this helper.
 *
 * @template T
 * @param {{ connect?: () => Promise<import('pg').PoolClient> }} db
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function inTransaction(db, fn) {
  if (typeof db.connect !== 'function') {
    throw new TypeError('users repository needs a pool-like db with connect() for guarded updates');
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Row shape used by the guarded updates: enough to decide the rule, without loading password hashes into memory. */
const USER_GUARD_COLUMNS = 'id::text AS id, role, is_active';
const USER_UPDATE_RETURNING = `RETURNING ${USER_LIST_COLUMNS}`;

/**
 * Locks the target and every active administrator in one statement.
 *
 * Locking in id order (the database does it for `FOR UPDATE`) prevents the deadlock two mutual demotions would
 * otherwise cause: each transaction would hold its own target row and wait for the other one.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} id
 * @returns {Promise<Array<{ id: string, role: string, is_active: boolean }>>}
 */
async function lockTargetAndActiveAdmins(client, id) {
  const { rows } = await client.query(
    `SELECT ${USER_GUARD_COLUMNS}
       FROM users
      WHERE id = $1::bigint OR (role = 'admin' AND is_active)
      ORDER BY id
      FOR UPDATE`,
    [id],
  );
  return rows;
}

/**
 * @param {Array<{ id: string, role: string, is_active: boolean }>} locked
 * @param {string} targetId
 * @returns {number} Active administrators other than the target.
 */
function otherActiveAdmins(locked, targetId) {
  return locked.filter((row) => row.id !== targetId && row.role === 'admin' && row.is_active).length;
}

/**
 * Data access for the `users` table. The database handle is injected by `createApp` so the auth tests stay on the
 * test pool while production uses the shared pool.
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>, connect?: () => Promise<import('pg').PoolClient> }} db
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
     * Full account row, credentials included. Only the profile/password paths may read the hash; the administration
     * screens use `listForAdmin`, which never selects it.
     * @param {string} id BIGINT id as a validated digit string.
     * @returns {Promise<ReturnType<typeof mapUser> | null>}
     */
    async findById(id) {
      const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1::bigint`, [id]);
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
     * without the page having to sort. The demo has a handful of accounts, so the table has no pagination.
     * @returns {Promise<ReturnType<typeof mapUserListItem>[]>}
     */
    async listForAdmin() {
      const { rows } = await db.query(`SELECT ${USER_LIST_COLUMNS} FROM users ORDER BY role, lower(email)`);
      return rows.map(mapUserListItem);
    },

    /**
     * @param {{ email: string, passwordHash: string, fullName: string, role: string }} user Already validated;
     *   the password arrives hashed, never plain.
     * @returns {Promise<ReturnType<typeof mapUserListItem>>}
     * @throws {Error} SQLSTATE 23505 when the lower-cased e-mail already exists; the service turns it into a 400.
     */
    async createUser({ email, passwordHash, fullName, role }) {
      const { rows } = await db.query(
        `INSERT INTO users (email, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4)
         RETURNING ${USER_LIST_COLUMNS}`,
        [email, passwordHash, fullName, role],
      );
      return mapUserListItem(rows[0]);
    },

    /**
     * Changes the role under the last-admin guard.
     *
     * Returns null when the user disappeared or when demoting the target would leave no active administrator. The
     * service reads the target first, so it can tell a 404 from the guard without a second query.
     * @param {string} id
     * @param {string} role One of `USER_ROLES`.
     * @returns {Promise<ReturnType<typeof mapUserListItem> | null>}
     */
    async updateUserRole(id, role) {
      return inTransaction(db, async (client) => {
        const locked = await lockTargetAndActiveAdmins(client, id);
        const target = locked.find((row) => row.id === id);
        if (!target) return null;
        if (target.role === role) {
          // No-op: do not touch `updated_at`, and the service skips session revocation and the audit row.
          const { rows } = await client.query(`SELECT ${USER_LIST_COLUMNS} FROM users WHERE id = $1::bigint`, [id]);
          return rows[0] ? mapUserListItem(rows[0]) : null;
        }
        if (target.role === 'admin' && target.is_active && role !== 'admin' && otherActiveAdmins(locked, id) === 0) {
          return null;
        }

        const { rows } = await client.query(
          `UPDATE users SET role = $2 WHERE id = $1::bigint ${USER_UPDATE_RETURNING}`,
          [id, role],
        );
        return rows[0] ? mapUserListItem(rows[0]) : null;
      });
    },

    /**
     * Sets the active flag under the last-admin guard. Deactivating the only active administrator returns null.
     * @param {string} id
     * @param {boolean} isActive
     * @returns {Promise<ReturnType<typeof mapUserListItem> | null>}
     */
    async setUserActive(id, isActive) {
      return inTransaction(db, async (client) => {
        const locked = await lockTargetAndActiveAdmins(client, id);
        const target = locked.find((row) => row.id === id);
        if (!target) return null;
        if (!isActive && target.role === 'admin' && target.is_active && otherActiveAdmins(locked, id) === 0) {
          return null;
        }

        const { rows } = await client.query(
          `UPDATE users SET is_active = $2 WHERE id = $1::bigint ${USER_UPDATE_RETURNING}`,
          [id, isActive],
        );
        return rows[0] ? mapUserListItem(rows[0]) : null;
      });
    },

    /**
     * @param {string} id
     * @param {string} passwordHash Argon2id hash from `@node-rs/argon2`; the plain password never reaches SQL.
     * @returns {Promise<boolean>} False when the user disappeared between the read and the update.
     */
    async updateUserPasswordHash(id, passwordHash) {
      const { rowCount } = await db.query('UPDATE users SET password_hash = $2 WHERE id = $1::bigint', [
        id,
        passwordHash,
      ]);
      return rowCount > 0;
    },

    /**
     * Deletes every server-side session of one user, which is what makes the old cookie stop working immediately.
     *
     * `connect-pg-simple` stores the session payload as JSON under `sess`; the user id is a string there, so the
     * cast compares BIGINT with BIGINT. This is the only revocation mechanism: there is no MemoryStore branch.
     * @param {string} userId
     * @returns {Promise<number>} Deleted row count.
     */
    async deleteUserSessions(userId) {
      const { rowCount } = await db.query("DELETE FROM sessions WHERE (sess->'user'->>'id')::bigint = $1::bigint", [
        userId,
      ]);
      return rowCount;
    },
  };
}
