import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Repository hygiene guard.
 *
 * The test answers one question: can this tree be handed to a stranger? It therefore looks at the *index*, not the
 * working directory — a file that exists locally but is not tracked cannot leak through a clone.
 *
 * Two deliberate properties keep the guard from lying about itself:
 * 1. every forbidden pattern is assembled at runtime from parts, so a literal in this file cannot match itself;
 * 2. this file is excluded from the content scan, because documenting a forbidden shape means writing it down.
 *
 * The author's real name is deliberately not checked: it legitimately appears in git metadata and in the licence the
 * owner may add, and a hard-coded name check fails on the test that contains it.
 */

const ROOT = process.cwd();
const SELF = 'tests/unit/repo-hygiene.test.js';
const ENV_FILE = '.env';
const ENV_TEMPLATE = '.env.example';
const LARGE_FILE_LIMIT = 5 * 1024 * 1024;
/** Binary formats that may legitimately exceed the size ceiling (fonts and documentation images). */
const LARGE_BINARY_EXTENSIONS = /\.(?:png|woff2?|ttf|otf)$/i;
const BINARY_EXTENSIONS = /\.(?:png|jpe?g|webp|gif|ico|svg|woff2?|ttf|otf|docx|zip|pdf|dump)$/i;

/**
 * Reads the index in one call. `-z` keeps file names with spaces and Cyrillic characters intact.
 * @returns {string[]} Repository-relative paths, in git's order.
 */
export function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return output.split('\0').filter(Boolean);
}

/**
 * Builds the forbidden-path predicates without embedding a single scannable literal.
 * @returns {Array<{ label: string, matches: (path: string) => boolean }>}
 */
export function forbiddenPathRules() {
  const dot = '.';
  const envPrefix = `${dot}${'env'}`;
  // `.env`, `.env.local`, `config/.env.production`, `apps/web/.env-staging`; `.env.example` is the one allowed file and
  // `.environment.md` is a normal document, so the prefix must end at a separator.
  const envSegment = new RegExp(`^${envPrefix}(?:$|[.\\-_])`);
  const assets = `public/${'assets'}/`;
  const modules = `${'node'}${'_'}${'modules'}/`;
  const backups = `${'back'}${'ups'}/`;
  const encrypted = `${dot}${'enc'}`;

  return [
    {
      label: 'environment file',
      matches: (path) =>
        path.split('/').some((segment) => envSegment.test(segment) && segment !== ENV_TEMPLATE),
    },
    { label: 'built Vite output', matches: (path) => path.startsWith(assets) },
    { label: 'installed dependency tree', matches: (path) => path.includes(modules) },
    { label: 'log file', matches: (path) => path.endsWith(`${dot}${'log'}`) },
    { label: 'backup artefact', matches: (path) => path.startsWith(backups) && path.endsWith(encrypted) },
  ];
}

/**
 * True when a source file writes to stdout through a console method.
 *
 * Direct `console.log`, the `console.info`/`console.debug` siblings and computed access (`console['log']`,
 * `console . log`) all reach stdout and all turn into log noise in a server process. `console.error` is deliberately
 * not matched: a CLI script may report a failure on stderr, and the rule is about stdout side effects.
 *
 * @param {string} source File contents.
 * @returns {boolean}
 */
export function writesToStdout(source) {
  const methods = ['log', 'info', 'debug'].join('|');
  const direct = new RegExp(`${'console'}\\s*\\.\\s*(?:${methods})\\b`);
  const computed = new RegExp(`${'console'}\\s*\\[\\s*['"\`](?:${methods})['"\`]\\s*\\]`);
  return direct.test(source) || computed.test(source);
}

/**
 * @param {string[]} paths Repository-relative paths.
 * @returns {string[]} One line per violation.
 */
export function findForbiddenPaths(paths) {
  const rules = forbiddenPathRules();
  const offenders = [];
  for (const path of paths) {
    for (const rule of rules) {
      if (rule.matches(path)) offenders.push(`${path} (${rule.label})`);
    }
  }
  return offenders;
}

/**
 * @param {string[]} paths Repository-relative paths.
 * @returns {Array<{ path: string, bytes: number }>} Tracked files above the ceiling, newest git order.
 */
export function findOversizedFiles(paths) {
  return paths
    .filter((path) => !LARGE_BINARY_EXTENSIONS.test(path))
    .flatMap((path) => {
      const absolute = join(ROOT, path);
      if (!existsSync(absolute)) return [];
      const { size } = statSync(absolute);
      return size > LARGE_FILE_LIMIT ? [{ path, bytes: size }] : [];
    });
}

/**
 * Regexes for machine-local absolute paths, assembled at runtime.
 * @returns {Array<{ label: string, pattern: RegExp }>}
 */
export function homePathPatterns() {
  const user = '[A-Za-z0-9._-]+';
  return [
    { label: 'posix home', pattern: new RegExp(`/${'home'}/${user}/`) },
    { label: 'root home', pattern: new RegExp(`/${'root'}/${user}/`) },
    { label: 'macOS home', pattern: new RegExp(`/${'Users'}/${user}/`) },
    { label: 'windows home', pattern: new RegExp(`[A-Za-z]:[\\\\/]${'Users'}[\\\\/]${user}`, 'i') },
  ];
}

/**
 * @param {Array<{ path: string, text: string }>} files Text files with their repository-relative path.
 * @returns {string[]} Offenders in input order.
 */
export function findHomePaths(files) {
  const patterns = homePathPatterns();
  const offenders = [];
  for (const file of files) {
    // The guard documents the forbidden shapes; scanning it would flag its own examples.
    if (file.path === SELF) continue;
    for (const { label, pattern } of patterns) {
      if (pattern.test(file.text)) offenders.push(`${file.path} (${label})`);
    }
  }
  return offenders;
}

/**
 * @returns {string[]} Tracked text files, binaries excluded by extension.
 */
function trackedTextFiles() {
  return trackedFiles().filter(
    (path) => !BINARY_EXTENSIONS.test(path) && existsSync(join(ROOT, path)) && !statSync(join(ROOT, path)).isDirectory(),
  );
}

/**
 * Lists every entry under `dir`, recursively, in a stable order.
 * @param {string} dir Absolute directory.
 * @returns {string[]} Repository-relative file paths.
 */
function walk(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const absolute = join(dir, name);
      if (statSync(absolute).isDirectory()) return walk(absolute);
      return [relative(ROOT, absolute).replaceAll('\\', '/')];
    });
}

const INDEX = trackedFiles();

describe('repository hygiene', () => {
  it('tracks no environment file, build output, dependency tree, log or backup', () => {
    const offenders = findForbiddenPaths(INDEX);

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('flags nested environment files but not the template or a word that merely starts the same way', () => {
    const synthetic = [
      '.env',
      'config/.env.local',
      'apps/web/.env.production',
      'deploy/.env-staging',
      '.env.example',
      'src/environment.md',
    ];

    expect(findForbiddenPaths(synthetic)).toEqual([
      '.env (environment file)',
      'config/.env.local (environment file)',
      'apps/web/.env.production (environment file)',
      'deploy/.env-staging (environment file)',
    ]);
  });

  it('keeps the example environment file tracked', () => {
    expect(INDEX).toContain(ENV_TEMPLATE);
  });

  it('tracks no oversized file outside fonts and documentation images', () => {
    const offenders = findOversizedFiles(INDEX).map(({ path, bytes }) => `${path} (${bytes} bytes)`);

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('leaks no machine-local absolute path in tracked text files', () => {
    const files = trackedTextFiles().map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
    const offenders = findHomePaths(files);

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('does not flag its own examples or machine-local text in the guard itself', () => {
    // A synthetic copy of the guard's own documented shapes must be reported, which proves the patterns work.
    const synthetic = `docs/example.md\ntext ${'/home/'}someone/project\n`;
    expect(findHomePaths([{ path: 'docs/example.md', text: synthetic }])).toHaveLength(1);
    // …and the same text inside this file is ignored by the exemption above.
    expect(findHomePaths([{ path: SELF, text: synthetic }])).toEqual([]);
  });

  it('lists every parseEnv key in .env.example', () => {
    const envSource = readFileSync(join(ROOT, 'src/config/env.js'), 'utf8');
    const schemaBody = envSource.split('const envSchema = z.object({')[1]?.split('});')[0] ?? '';
    const keys = [...schemaBody.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThanOrEqual(10);

    const template = readFileSync(join(ROOT, ENV_TEMPLATE), 'utf8');
    const missing = keys.filter((key) => !new RegExp(`^${key}=`, 'm').test(template));

    expect(missing, `missing in ${ENV_TEMPLATE}: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps the npm lockfile in the index', () => {
    expect(INDEX).toContain('package-lock.json');
  });

  it('ships the M6 screenshot evidence', () => {
    const directory = join(ROOT, 'docs/screenshots/m6');

    expect(existsSync(directory)).toBe(true);
    expect(readdirSync(directory).length).toBeGreaterThan(0);
  });

  it('writes no stdout console call into src/ (CLI scripts may print on purpose)', () => {
    const files = walk(join(ROOT, 'src')).filter((path) => /\.(?:js|jsx)$/.test(path));
    const offenders = files.filter((path) => writesToStdout(readFileSync(join(ROOT, path), 'utf8')));

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('recognises direct, sibling and computed stdout calls without flagging console.error', () => {
    expect(writesToStdout("console.log('x')")).toBe(true);
    expect(writesToStdout('console . info(1)')).toBe(true);
    expect(writesToStdout("console['debug'](1)")).toBe(true);
    expect(writesToStdout('console["log"](1)')).toBe(true);
    expect(writesToStdout("console.error('x')")).toBe(false);
    expect(writesToStdout("console.table('x')")).toBe(false);
  });
});
