import 'dotenv/config';
import pg from 'pg';

/**
 * Connection used only to run `CREATE DATABASE`. The default mirrors the Docker/PostgreSQL defaults from
 * `.env.example`; any other stand supplies its own role through `ADMIN_DATABASE_URL`, so no host, role or
 * password of a particular machine is baked into the repository.
 */
const DEFAULT_ADMIN_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/postgres';

/**
 * PostgreSQL folds unquoted identifiers, so only lowercase names that we are willing to quote verbatim are
 * accepted. This also stops a crafted URL from turning into anything other than one plain identifier.
 */
const SAFE_DATABASE_NAME = /^[a-z][a-z0-9_]*$/;

const PRIVILEGE_HINT = [
  'HINT: set ADMIN_DATABASE_URL to a role that is allowed to create databases',
  '(CREATEDB privilege or superuser), for example postgres://postgres@localhost:5432/postgres,',
  'or create the databases manually with createdb and run this script again.',
].join('\n');

class SetupError extends Error {}

/**
 * Extracts and validates the database name from a `postgres://` connection string.
 *
 * @param {string} variable Name of the environment variable, used in error messages.
 * @param {string} rawUrl Connection string exactly as it appears in the environment.
 * @returns {string} Database name, guaranteed to match {@link SAFE_DATABASE_NAME}.
 * @throws {SetupError} When the URL is unparseable, has no database name or has an unsafe one.
 */
function readDatabaseName(variable, rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SetupError(`${variable} is not a valid URL.`);
  }

  const name = url.pathname.replace(/^\//, '');
  if (name === '') {
    throw new SetupError(`${variable} does not name a database (expected .../<database> in the URL).`);
  }
  if (!SAFE_DATABASE_NAME.test(name)) {
    throw new SetupError(
      `${variable} names database "${name}", but only lowercase letters, digits and underscores are allowed ` +
        '(the name must start with a letter).',
    );
  }
  return name;
}

/**
 * Builds the list of databases to ensure, collapsing `DATABASE_URL` and `TEST_DATABASE_URL` when they point
 * to the same database so a single-database stand is reported once instead of twice.
 *
 * @param {Record<string, string | undefined>} source Environment-like object, usually `process.env`.
 * @returns {Array<{ name: string, variables: string[] }>} Unique targets in declaration order.
 * @throws {SetupError} When `DATABASE_URL` is missing or any URL is invalid.
 */
function collectTargets(source) {
  if (!source.DATABASE_URL) {
    throw new SetupError(
      'DATABASE_URL is not set. Copy .env.example to .env and adjust the connection strings for your stand.',
    );
  }

  const byName = new Map();
  for (const variable of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
    const rawUrl = source[variable];
    if (!rawUrl) continue;

    const name = readDatabaseName(variable, rawUrl);
    const target = byName.get(name) ?? { name, variables: [] };
    target.variables.push(variable);
    byName.set(name, target);
  }
  return [...byName.values()];
}

/**
 * Turns a driver error into a readable line. Node reports refused dual-stack connections as an AggregateError
 * with an empty own message, so falling back to the nested errors or the SQLSTATE code keeps the output useful
 * instead of printing a bare blank after the colon.
 *
 * @param {Error & { code?: string, errors?: Error[] }} error Error thrown by `pg`.
 * @returns {string} Human-readable reason.
 */
function describeError(error) {
  if (error.message) return error.message;
  if (Array.isArray(error.errors) && error.errors.length > 0) {
    return error.errors.map((nested) => nested.message || nested.code || 'unknown error').join('; ');
  }
  return error.code ?? 'unknown error';
}

/**
 * Removes the password from a string before it reaches stdout or a log. Error messages from the driver can
 * echo the connection string, and a bootstrap script must never print credentials.
 *
 * @param {string} text Message to sanitize.
 * @param {string} connectionString URL whose password should be masked.
 * @returns {string} Same text with every occurrence of the password replaced by `***`.
 */
function redact(text, connectionString) {
  try {
    const { password } = new URL(connectionString);
    return password ? text.split(password).join('***') : text;
  } catch {
    return text;
  }
}

/**
 * Creates every database from `DATABASE_URL` / `TEST_DATABASE_URL` that does not exist yet.
 *
 * Runs as a standalone CLI only: it deliberately does not import `src/config/env.js`, because bootstrapping
 * databases must work before the rest of the environment is valid (session secret, app URL, etc.).
 *
 * @returns {Promise<void>}
 * @throws {SetupError} On invalid input, unreachable admin database or denied `CREATE DATABASE`.
 */
async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL || DEFAULT_ADMIN_DATABASE_URL;
  const targets = collectTargets(process.env);

  const client = new pg.Client({ connectionString: adminUrl });
  try {
    await client.connect();
  } catch (error) {
    throw new SetupError(
      `Could not connect to the admin database from ADMIN_DATABASE_URL: ${redact(describeError(error), adminUrl)}\n` +
        PRIVILEGE_HINT,
    );
  }

  try {
    const { rows } = await client.query('SELECT datname FROM pg_database');
    const existing = new Set(rows.map((row) => row.datname));

    for (const target of targets) {
      if (existing.has(target.name)) {
        console.log(`${target.name}: already exists`);
        continue;
      }

      // The name passed the identifier check above; quoting it lets PostgreSQL treat it as a plain
      // identifier without ever concatenating unvalidated input into SQL.
      const quoted = client.escapeIdentifier(target.name);
      try {
        await client.query(`CREATE DATABASE ${quoted}`);
      } catch (error) {
        throw new SetupError(
          `Could not create database "${target.name}" (wanted by ${target.variables.join(', ')}): ` +
            `${redact(describeError(error), adminUrl)}\n${PRIVILEGE_HINT}`,
        );
      }
      console.log(`${target.name}: created`);
    }
  } finally {
    await client.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(`db:setup failed: ${error.message}`);
  process.exitCode = 1;
}
