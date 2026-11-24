#!/usr/bin/env node
/**
 * Fresh-clone check for «Метрика».
 *
 * The point of this script is to answer a question the unit suite cannot: does the *committed* tree, with no local
 * files and no installed dependencies, come up from zero? It therefore never looks at the working copy. A detached
 * git worktree is created from a committed revision, `.env` is generated from `.env.example`, a throwaway database is
 * created and dropped, and the server is started on a free port.
 *
 * Failure is always loud: an unreachable admin database, a broken example environment or a failed step exits non-zero
 * with the captured output. The check is never downgraded to a warning, because a warning is how a broken clone ships.
 *
 * Usage (see `USAGE`): `npm run check:fresh -- [--sha <rev>] [--port <n>] [--keep]`.
 * Requires `git`, Node.js 24+ and a PostgreSQL role that can `CREATE DATABASE` (`ADMIN_DATABASE_URL`, defaulting to the
 * one in `db/setup.js`).
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLONE_DATABASE = 'metrika_clone_check';
const SAFE_DATABASE_NAME = /^[a-z][a-z0-9_]*$/;
/** Mirrors `db/setup.js`: the check must accept the same zero-config default as `npm run db:setup`. */
const DEFAULT_ADMIN_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/postgres';
/** Variables the generated `.env` owns. Inherited values are removed so the clone cannot borrow the author's stand. */
const MANAGED_VARIABLES = [
  'NODE_ENV',
  'PORT',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'SESSION_SECRET',
  'APP_URL',
  'COOKIE_SECURE',
  'DEMO_INSECURE_COOKIES',
  'AUTO_SEED_DEMO',
  'RUN_MIGRATIONS',
  'LOG_LEVEL',
];
const IS_WINDOWS = process.platform === 'win32';
const NPM = IS_WINDOWS ? 'npm.cmd' : 'npm';
const START_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 600_000;

export const USAGE = `Fresh-clone check for «Метрика» (npm run check:fresh)

Creates a detached git worktree of a committed revision in a temporary directory,
installs from package-lock.json, builds .env from .env.example, creates the throwaway
database ${CLONE_DATABASE}, applies migrations, seeds the demo data, builds the client,
starts the server on a free port and checks:
  GET /, GET /login, GET /health, POST /login (admin), GET /app/dashboard.

Options:
  --sha <rev>   Revision to check (default: HEAD)
  --port <n>    Port for the temporary stand (default: a free port)
  --keep        Keep the worktree and the database for inspection
  -h, --help    Print this help

Requires: git, Node.js 24+, a reachable PostgreSQL role that can CREATE DATABASE
(ADMIN_DATABASE_URL, default from db/setup.js) and an npm cache for --prefer-offline.
A failure always exits non-zero with the captured output; the check is never turned
into a warning.
`;

class CheckError extends Error {
  /**
   * @param {string} message What failed.
   * @param {{ stdout?: string, stderr?: string }} [output] Captured child-process output.
   */
  constructor(message, output = {}) {
    super(message);
    this.name = 'CheckError';
    this.stdout = output.stdout ?? '';
    this.stderr = output.stderr ?? '';
  }
}

/**
 * Parses command-line flags without touching the environment or the repository, so it can be unit-tested.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {{ sha: string, port: number | null, keep: boolean, help: boolean }}
 * @throws {CheckError} On an unknown flag, a missing value or a non-numeric port.
 */
export function parseArgs(argv) {
  const options = { sha: 'HEAD', port: null, keep: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--keep') {
      options.keep = true;
    } else if (argument === '--sha' || argument === '--port') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new CheckError(`${argument} requires a value.`);
      }
      index += 1;
      if (argument === '--sha') {
        options.sha = value;
      } else {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new CheckError(`--port must be an integer between 1 and 65535, got "${value}".`);
        }
        options.port = port;
      }
    } else {
      throw new CheckError(`Unknown argument "${argument}". Run with --help for usage.`);
    }
  }

  return options;
}

/**
 * Rewrites the example environment for a throwaway stand.
 *
 * Only whole-line assignments are replaced, so comments and the backup/proxy notes stay exactly as documented. The
 * session secret is generated per run and never printed; the database is the dedicated clone database.
 *
 * @param {string} template Contents of `.env.example`.
 * @param {{ databaseUrl: string, port: number, sessionSecret: string, appUrl: string }} values Stand values.
 * @returns {string} `.env` contents.
 * @throws {CheckError} When the template has no `DATABASE_URL=` assignment.
 */
export function renderEnv(template, values) {
  const replacements = new Map([
    ['NODE_ENV', 'development'],
    ['PORT', String(values.port)],
    ['DATABASE_URL', values.databaseUrl],
    // The integration suite is not part of this check; collapsing both names onto one database keeps `db:setup`
    // idempotent and means only one database has to be dropped afterwards.
    ['TEST_DATABASE_URL', values.databaseUrl],
    ['SESSION_SECRET', values.sessionSecret],
    ['APP_URL', values.appUrl],
  ]);

  let replacedDatabase = false;
  const rendered = template
    .split('\n')
    .map((line) => {
      const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
      if (!match) return line;
      const value = replacements.get(match[1]);
      if (value === undefined) return line;
      if (match[1] === 'DATABASE_URL') replacedDatabase = true;
      return `${match[1]}=${value}`;
    })
    .join('\n');

  if (!replacedDatabase) {
    throw new CheckError('.env.example has no DATABASE_URL assignment.');
  }
  return rendered;
}

/**
 * Swaps the database name in a `postgres://` URL.
 *
 * @param {string} rawUrl Template URL.
 * @param {string} name Destination database name.
 * @returns {string} URL that points at `name`.
 * @throws {CheckError} When the URL is unparseable.
 */
export function databaseUrlWithName(rawUrl, name) {
  if (!SAFE_DATABASE_NAME.test(name)) {
    throw new CheckError(`Unsafe database name "${name}".`);
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CheckError(`.env.example DATABASE_URL is missing or not a URL: "${rawUrl}"`);
  }
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

/**
 * @param {string[]} args Git arguments.
 * @param {string} cwd Working directory.
 * @returns {string} Trimmed stdout.
 * @throws {CheckError} On a non-zero exit.
 */
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new CheckError(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim() || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

/**
 * Runs one child process and captures its output.
 *
 * `npm.cmd` cannot be spawned directly on Windows after the CVE-2024-27980 hardening, so the npm invocation alone uses
 * a shell; the command and every argument are literals, never user input.
 *
 * @param {string} command Executable.
 * @param {string[]} args Arguments.
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, label: string, timeoutMs?: number, shell?: boolean }} options
 * @returns {Promise<{ stdout: string, stderr: string, durationMs: number }>}
 * @throws {CheckError} When the process exits non-zero, cannot start or times out.
 */
function run(command, args, options) {
  const { cwd, env = process.env, label, timeoutMs = STEP_TIMEOUT_MS, shell = false } = options;
  const startedAt = Date.now();

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new CheckError(`${label} timed out after ${Math.round(timeoutMs / 1000)} s.`, { stdout, stderr }));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new CheckError(`${label} could not start: ${error.message}`, { stdout, stderr }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ stdout, stderr, durationMs: Date.now() - startedAt });
      } else {
        reject(new CheckError(`${label} exited with code ${code}.`, { stdout, stderr }));
      }
    });
  });
}

/**
 * @returns {Promise<number>} A port that was free a moment ago.
 */
function findFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

/**
 * Builds a child environment that owns its database, port and secret.
 *
 * Inherited values are removed instead of overridden: `dotenv` does not replace an already-set variable, so leaving the
 * author's `DATABASE_URL` in place would silently point the clone at `metrika_dev` and prove nothing.
 *
 * @param {NodeJS.ProcessEnv} source Parent environment.
 * @returns {NodeJS.ProcessEnv}
 */
function cleanChildEnv(source) {
  const env = { ...source };
  for (const name of MANAGED_VARIABLES) delete env[name];
  return env;
}

/**
 * Removes a password from a driver message so a failed check cannot print credentials.
 *
 * @param {string} message
 * @param {string} connectionString
 * @returns {string}
 */
function redact(message, connectionString) {
  try {
    const { password } = new URL(connectionString);
    return password ? message.split(password).join('***') : message;
  } catch {
    return message;
  }
}

/**
 * Fails before any work when the admin database is unreachable, with the exact prerequisite in the message.
 *
 * @param {string} adminUrl Admin connection string.
 * @returns {Promise<void>}
 */
async function assertAdminReachable(adminUrl) {
  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (error) {
    throw new CheckError(
      `Admin database is unreachable (${redact(error.message, adminUrl)}).\n` +
        'Set ADMIN_DATABASE_URL to a role with CREATEDB, start PostgreSQL, and run the check again.',
    );
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Drops the clone database, terminating leftover connections (the server may still be shutting down).
 *
 * @param {string} adminUrl
 * @returns {Promise<void>}
 */
async function dropCloneDatabase(adminUrl) {
  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const quoted = client.escapeIdentifier(CLONE_DATABASE);
    await client.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {{ timeoutMs?: number, redirect?: 'follow' | 'manual', cookie?: string }} [options]
 * @returns {Promise<Response>}
 */
function get(baseUrl, path, options = {}) {
  return fetch(new URL(path, baseUrl), {
    headers: options.cookie ? { cookie: options.cookie } : undefined,
    redirect: options.redirect ?? 'follow',
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
}

/**
 * Polls `/health` until the server answers 200 or the deadline passes.
 *
 * @param {{ baseUrl: string, child: import('node:child_process').ChildProcess, output: () => string }} stand
 * @returns {Promise<Record<string, unknown>>} Parsed health body.
 */
async function waitForHealth({ baseUrl, child, output }) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = 'no response';

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new CheckError(`Server exited during startup.\n${output()}`);
    }
    try {
      const response = await get(baseUrl, '/health', { timeoutMs: 3_000 });
      if (response.status === 200) return response.json();
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await wait(250);
  }

  throw new CheckError(`Server did not become healthy within ${START_TIMEOUT_MS / 1000} s (${lastError}).\n${output()}`);
}

/**
 * Joins every `Set-Cookie` value into one request `Cookie` header (`name=value; …`).
 *
 * @param {Response} response
 * @returns {string}
 */
function cookieHeader(response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

/**
 * Exercises the public pages, the health contract and an authenticated page as the demo administrator.
 *
 * @param {{ baseUrl: string, expectedVersion: string, password: string }} context
 * @returns {Promise<string[]>} Checked steps, in order.
 */
async function checkHttp({ baseUrl, expectedVersion, password }) {
  const checked = [];

  const home = await get(baseUrl, '/');
  if (home.status !== 200 || !(await home.text()).includes('Метрика')) {
    throw new CheckError(`GET / expected 200 with the landing copy, got ${home.status}.`);
  }
  checked.push('GET /');

  const loginPage = await get(baseUrl, '/login');
  const loginHtml = await loginPage.text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(loginHtml)?.[1];
  const anonymousCookies = cookieHeader(loginPage);
  if (loginPage.status !== 200 || !csrf || !anonymousCookies) {
    throw new CheckError(`GET /login expected 200 with a CSRF token and a session cookie, got ${loginPage.status}.`);
  }
  checked.push('GET /login');

  const health = await get(baseUrl, '/health');
  const healthBody = await health.json();
  if (health.status !== 200 || healthBody.status !== 'ok' || healthBody.db !== 'up') {
    throw new CheckError(
      `GET /health expected 200 {"status":"ok","db":"up"}, got ${health.status} ${JSON.stringify(healthBody)}.`,
    );
  }
  if (healthBody.version !== expectedVersion) {
    throw new CheckError(`GET /health reports version "${healthBody.version}", package.json says "${expectedVersion}".`);
  }
  checked.push('GET /health');

  const anonymousDashboard = await get(baseUrl, '/app/dashboard', { redirect: 'manual' });
  if (![302, 303].includes(anonymousDashboard.status)) {
    throw new CheckError(`GET /app/dashboard without a session expected a redirect, got ${anonymousDashboard.status}.`);
  }
  checked.push('GET /app/dashboard (anonymous redirect)');

  const form = new URLSearchParams({
    email: 'admin@metrika.by',
    password,
    _csrf: csrf,
    next: '/app/dashboard',
  });
  const login = await fetch(new URL('/login', baseUrl), {
    method: 'POST',
    body: form,
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: anonymousCookies },
    signal: AbortSignal.timeout(10_000),
  });
  const sessionCookies = cookieHeader(login);
  if (![302, 303].includes(login.status) || !sessionCookies) {
    throw new CheckError(`POST /login expected a redirect with a rotated session, got ${login.status}.`);
  }
  checked.push('POST /login (admin)');

  const dashboard = await get(baseUrl, '/app/dashboard', { cookie: sessionCookies, timeoutMs: 15_000 });
  const dashboardHtml = await dashboard.text();
  if (dashboard.status !== 200 || !dashboardHtml.includes('app-shell')) {
    const page = dashboardHtml.includes('Вход в «Метрику»') ? 'the login page' : 'an unexpected page';
    throw new CheckError(
      `GET /app/dashboard with the admin session expected 200 with the app shell, got ${dashboard.status} (${page}).`,
    );
  }
  checked.push('GET /app/dashboard (admin)');

  return checked;
}

/**
 * @param {string} label Human-readable step name.
 * @param {() => Promise<unknown>} action
 * @returns {Promise<void>}
 */
async function step(label, action) {
  const startedAt = Date.now();
  await action();
  console.log(`  ok   ${label} (${((Date.now() - startedAt) / 1000).toFixed(1)} s)`);
}

/**
 * Runs the whole check and returns a summary for the journal.
 *
 * `cleanup` is a mutable object because the real outcome is only known after the `finally` block has tried to drop
 * the database; the caller prints what actually happened instead of assuming a successful drop.
 *
 * @param {ReturnType<typeof parseArgs>} options
 * @returns {Promise<{ sha: string, durationSeconds: number, url: string, cleanup: { database: string } }>}
 */
async function check(options) {
  const startedAt = Date.now();
  const adminUrl = process.env.ADMIN_DATABASE_URL || DEFAULT_ADMIN_DATABASE_URL;

  const sha = git(['rev-parse', options.sha], REPO_ROOT);
  if (git(['status', '--porcelain'], REPO_ROOT)) {
    console.log('note: the working tree has uncommitted changes; this check measures the committed revision only.');
  }

  await assertAdminReachable(adminUrl);

  const port = options.port ?? (await findFreePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const parentDirectory = mkdtempSync(join(tmpdir(), 'metrika-clone-'));
  const worktree = join(parentDirectory, 'repo');
  const cleanup = { database: 'not created' };
  let worktreeCreated = false;
  let databaseCreated = false;
  let server = null;
  let serverOutput = '';

  try {
    console.log(`Fresh-clone check at ${sha} in ${worktree}`);

    await step('git worktree add --detach', async () => {
      git(['worktree', 'add', '--detach', worktree, sha], REPO_ROOT);
      worktreeCreated = true;
    });

    const template = readFileSync(join(worktree, '.env.example'), 'utf8');
    const templateDatabaseUrl = /^DATABASE_URL=(.+)$/m.exec(template)?.[1];
    if (!templateDatabaseUrl) {
      throw new CheckError('.env.example has no DATABASE_URL assignment.');
    }
    const env = renderEnv(template, {
      databaseUrl: databaseUrlWithName(templateDatabaseUrl.trim(), CLONE_DATABASE),
      port,
      sessionSecret: randomBytes(32).toString('hex'),
      appUrl: baseUrl,
    });
    writeFileSync(join(worktree, '.env'), env, { mode: 0o600 });

    const childEnv = cleanChildEnv(process.env);
    const npmOptions = { cwd: worktree, env: childEnv, shell: IS_WINDOWS };

    await step('npm ci --prefer-offline', () =>
      run(NPM, ['ci', '--prefer-offline', '--no-audit', '--no-fund'], {
        ...npmOptions,
        label: 'npm ci',
        timeoutMs: 15 * 60_000,
      }),
    );
    await step('database create (db:setup)', async () => {
      await dropCloneDatabase(adminUrl);
      await run(NPM, ['run', 'db:setup'], { ...npmOptions, label: 'db:setup' });
      databaseCreated = true;
    });
    await step('npm run migrate', () => run(NPM, ['run', 'migrate'], { ...npmOptions, label: 'migrate' }));
    await step('npm run seed', () => run(NPM, ['run', 'seed'], { ...npmOptions, label: 'seed' }));
    await step('npm run build', () => run(NPM, ['run', 'build'], { ...npmOptions, label: 'build' }));

    const expectedVersion = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')).version;
    // Read the password from the checked revision, not from this checkout: an older SHA may carry a different demo
    // account password, and the check must not depend on the working tree it was launched from.
    const { DEMO_PASSWORD } = await import(pathToFileURL(join(worktree, 'db/seed/data.js')).href);
    await step('npm start + HTTP checks', async () => {
      server = spawn(process.execPath, ['src/server.js'], {
        cwd: worktree,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const append = (chunk) => {
        serverOutput += chunk;
      };
      server.stdout.on('data', append);
      server.stderr.on('data', append);
      server.on('error', (error) => {
        serverOutput += `\nserver spawn error: ${error.message}`;
      });
      await waitForHealth({ baseUrl, child: server, output: () => serverOutput });
      const checked = await checkHttp({ baseUrl, expectedVersion, password: DEMO_PASSWORD });
      console.log(`       checked: ${checked.join(', ')}`);
    });

    return { sha, durationSeconds: (Date.now() - startedAt) / 1000, url: baseUrl, cleanup };
  } catch (error) {
    if (error instanceof CheckError && (error.stdout || error.stderr)) {
      console.error('\n--- captured output ---');
      if (error.stdout) console.error(error.stdout.trimEnd());
      if (error.stderr) console.error(error.stderr.trimEnd());
      console.error('--- end of captured output ---');
    }
    if (serverOutput) {
      console.error('\n--- server output ---');
      console.error(serverOutput.trimEnd());
      console.error('--- end of server output ---');
    }
    throw error;
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      const deadline = Date.now() + 10_000;
      while (server.exitCode === null && Date.now() < deadline) await wait(100);
      if (server.exitCode === null) server.kill('SIGKILL');
    }

    if (options.keep) {
      cleanup.database = databaseCreated ? 'kept (--keep)' : 'not created';
      console.log(`\n--keep: worktree ${worktree}; database ${CLONE_DATABASE} — ${cleanup.database}.`);
    } else {
      if (worktreeCreated) {
        if (databaseCreated) {
          try {
            await dropCloneDatabase(adminUrl);
            cleanup.database = 'dropped';
          } catch (error) {
            cleanup.database = 'kept (drop failed)';
            console.error(`warning: could not drop ${CLONE_DATABASE}: ${redact(error.message, adminUrl)}`);
          }
        }
        try {
          git(['worktree', 'remove', '--force', worktree], REPO_ROOT);
        } catch {
          rmSync(worktree, { recursive: true, force: true });
        }
        try {
          git(['worktree', 'prune'], REPO_ROOT);
        } catch {
          // A stale worktree entry is local bookkeeping; the check result does not depend on it.
        }
      }
      rmSync(parentDirectory, { recursive: true, force: true });
    }
  }
}

/**
 * CLI entry point. Importing this module for its helpers has no side effects.
 */
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  // `db/setup.js` reads `.env` through `dotenv/config`; loading it here too means the same `ADMIN_DATABASE_URL` works
  // for both commands instead of silently falling back to the default role. Only the CLI path loads it, so importing
  // this module from a test has no side effects.
  dotenv.config();

  try {
    const summary = await check(options);
    console.log(
      `\nFresh-clone check PASS\n  sha: ${summary.sha}\n  duration: ${summary.durationSeconds.toFixed(1)} s\n  url: ${summary.url}\n  database: ${CLONE_DATABASE} — ${summary.cleanup.database}`,
    );
  } catch (error) {
    console.error(`\nFresh-clone check FAIL\n  ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
