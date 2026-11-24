import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  databaseUrlWithName,
  parseArgs,
  renderEnv,
} from '../../scripts/fresh-clone-check.js';

/**
 * Publication readiness guard.
 *
 * These assertions describe the hand-off contract rather than the prose: the repository must carry a licence
 * placeholder (no licence is chosen for the owner), a publication note that names the tag and its blockers, a
 * version that the README example agrees with, and a fresh-clone check that is wired into npm.
 */

const ROOT = process.cwd();
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const pkg = JSON.parse(read('package.json'));
const publication = read('docs/publication.md');
const readme = read('README.md');

const SHORT_DESCRIPTION_MARKER = 'Короткое описание';
const LONG_DESCRIPTION_MARKER = 'Расширенное описание';
const TAG_ANNOTATION = 'M6 delivery: Docker, encrypted backups, deployment and user guides';
const TOPICS = [
  'nodejs',
  'express',
  'postgresql',
  'ejs',
  'react',
  'recharts',
  'marketing-analytics',
  'cac',
  'ltv',
  'romi',
  'course-project',
];

/**
 * Returns the first markdown blockquote that follows `marker`, joined into one line.
 *
 * The publication note uses a blockquote so the same sentence can be pasted into the GitHub "About" field without
 * reformatting; the test measures exactly that pasted text.
 *
 * @param {string} markdown
 * @param {string} marker Text that introduces the quote.
 * @returns {string | null} Quote content, or null when the marker or quote is missing.
 */
export function blockquoteAfter(markdown, marker) {
  const index = markdown.indexOf(marker);
  if (index === -1) return null;

  const lines = markdown.slice(index + marker.length).split('\n');
  const quote = [];
  let started = false;
  for (const line of lines) {
    if (line.startsWith('>')) {
      quote.push(line.replace(/^>\s?/, ''));
      started = true;
      continue;
    }
    if (started) break;
  }
  return quote.length > 0 ? quote.join(' ').replace(/\s+/g, ' ').trim() : null;
}

describe('licence hand-off', () => {
  it('ships a LICENSE file that reserves the rights without choosing a licence', () => {
    expect(existsSync(join(ROOT, 'LICENSE'))).toBe(true);
    const license = read('LICENSE');

    expect(license).toMatch(/^Copyright \(c\) \d{4}/m);
    expect(license).toMatch(/All rights reserved/i);
    // A licence grant would mean the owner's decision was made for them.
    expect(license).not.toMatch(/Permission is hereby granted/i);
  });

  it('records the licence status in the publication note', () => {
    expect(publication).toMatch(/Статус лицензии:/);
    expect(publication).toMatch(/плейсхолдер|решение владельца/i);
  });
});

describe('publication note', () => {
  it('fits both GitHub description fields', () => {
    const short = blockquoteAfter(publication, SHORT_DESCRIPTION_MARKER);
    const long = blockquoteAfter(publication, LONG_DESCRIPTION_MARKER);

    expect(short, 'missing short description blockquote').toBeTruthy();
    expect(long, 'missing long description blockquote').toBeTruthy();
    expect(short.length).toBeLessThanOrEqual(160);
    expect(long.length).toBeLessThanOrEqual(350);
  });

  it('lists every GitHub topic', () => {
    for (const topic of TOPICS) {
      expect(publication, `missing topic ${topic}`).toContain(topic);
    }
  });

  it('points the social preview at the committed 1200×630 PNG', () => {
    expect(publication).toContain('public/img/og-cover.png');
    expect(publication).toContain('1200×630');
    expect(existsSync(join(ROOT, 'public/img/og-cover.png'))).toBe(true);
  });

  it('proposes v1.0.0 with the exact annotation and keeps tagging owner-only', () => {
    expect(publication).toMatch(/^## .*v1\.0\.0/m);
    expect(publication).toContain(TAG_ANNOTATION);
    expect(publication).toMatch(/Тег и пуш — только владелец/);
  });

  it('names the known limitations and the pre-tag checklist', () => {
    expect(publication).toMatch(/^## .*Известные ограничения/m);
    expect(publication).toMatch(/^## .*(?:Предлаговый|Предтеговый|Чек-лист)/m);
    const limitations = publication.split(/^## .*Известные ограничения/m)[1] ?? '';
    expect(limitations.split('\n').filter((line) => line.startsWith('- ')).length).toBeGreaterThanOrEqual(5);
  });
});

describe('version and health contract', () => {
  it('releases the project as 1.0.0 with Node 24 as the floor', () => {
    expect(pkg.version).toBe('1.0.0');
    expect(pkg.engines?.node).toBe('>=24');
  });

  it('shows the same version in both README health examples', () => {
    const versions = [...readme.matchAll(/"version":"([^"]+)"/g)].map((match) => match[1]);

    expect(versions).toHaveLength(2);
    expect(new Set(versions)).toEqual(new Set([pkg.version]));
    expect(readme).toContain('"status":"ok"');
    expect(readme).toContain('"status":"error"');
  });
});

describe('fresh-clone check', () => {
  it('is wired into npm and implemented by the script', () => {
    expect(pkg.scripts['check:fresh']).toBe('node scripts/fresh-clone-check.js');
    expect(existsSync(join(ROOT, 'scripts/fresh-clone-check.js'))).toBe(true);
  });

  it('prints its usage when asked and fails loudly instead of skipping', () => {
    const help = execFileSync(process.execPath, ['scripts/fresh-clone-check.js', '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(help).toContain('check:fresh');
    expect(help).toContain('--sha');

    const source = read('scripts/fresh-clone-check.js');
    // A silent skip would let a broken clone ship; every failure path must exit non-zero.
    expect(source).toMatch(/process\.exitCode\s*=\s*1/);
    expect(source).not.toMatch(/skip/i);
  });

  it('targets a dedicated throwaway database and a random session secret', () => {
    const source = read('scripts/fresh-clone-check.js');

    expect(source).toContain('metrika_clone_check');
    expect(source).toContain('randomBytes');
  });
});

describe('fresh-clone environment generation', () => {
  const template = read('.env.example');
  const values = {
    databaseUrl: 'postgres://user:secret@db.example:5432/metrika_clone_check',
    port: 3456,
    sessionSecret: 'a'.repeat(64),
    appUrl: 'http://127.0.0.1:3456',
  };

  it('parses flags with sane defaults and rejects malformed input', () => {
    expect(parseArgs([])).toEqual({ sha: 'HEAD', port: null, keep: false, help: false });
    expect(parseArgs(['--sha', 'abc123', '--port', '3100', '--keep'])).toEqual({
      sha: 'abc123',
      port: 3100,
      keep: true,
      help: false,
    });
    expect(() => parseArgs(['--sha'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--port', '0'])).toThrow(/between 1 and 65535/);
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
  });

  it('rewrites only the assignment lines and keeps every documented key', () => {
    const env = renderEnv(template, values);
    const lines = env.split('\n');

    expect(lines).toHaveLength(template.split('\n').length);
    expect(env).toContain(`DATABASE_URL=${values.databaseUrl}`);
    expect(env).toContain(`TEST_DATABASE_URL=${values.databaseUrl}`);
    expect(env).toContain(`SESSION_SECRET=${values.sessionSecret}`);
    expect(env).toContain('PORT=3456');
    expect(env).toContain('APP_URL=http://127.0.0.1:3456');
    expect(env).toContain('NODE_ENV=development');
    expect(env).not.toContain('replace-with-a-random');
    // The copy-paste instructions for generating a secret must survive the rewrite.
    expect(env).toContain('node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  });

  it('fails when the example has no database assignment', () => {
    expect(() => renderEnv('# empty\nPORT=3000\n', values)).toThrow(/no DATABASE_URL assignment/);
  });

  it('moves a connection string to the clone database and refuses unsafe names', () => {
    expect(databaseUrlWithName('postgres://postgres:postgres@localhost:5432/metrika_dev', 'metrika_clone_check')).toBe(
      'postgres://postgres:postgres@localhost:5432/metrika_clone_check',
    );
    expect(() => databaseUrlWithName('postgres://localhost/metrika_dev', 'bad name; DROP')).toThrow(/Unsafe database/);
    expect(() => databaseUrlWithName('not a url', 'metrika_clone_check')).toThrow(/not a URL/);
  });
});
