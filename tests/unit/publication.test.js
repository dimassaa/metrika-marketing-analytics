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
 * These assertions describe the hand-off contract rather than the prose: the repository must carry a licence file
 * that is either the rights-reserved placeholder or the licence the owner chose, a publication note that names the
 * tag and its blockers, a version that the README example agrees with, and a fresh-clone check that is wired into npm.
 */

const ROOT = process.cwd();
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const publication = read('docs/publication.md');
const readme = read('README.md');

const SHORT_DESCRIPTION_MARKER = 'Короткое описание';
const LONG_DESCRIPTION_MARKER = 'Расширенное описание';
const TAG_ANNOTATION = 'M6 delivery: Docker, encrypted backups, deployment and user guides';
/** Titles a licence file may carry instead of an explicit copyright line. */
const RECOGNIZED_LICENSE_TITLE =
  /\b(?:MIT|Apache(?:\s+License)?|BSD|ISC|GNU(?:\s+General\s+Public\s+License)?|GPL|LGPL|MPL|Mozilla\s+Public\s+License|Unlicense|Creative\s+Commons|Proprietary)\b/i;
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

/**
 * True while `LICENSE` still carries the shipped placeholder.
 *
 * The placeholder is recognised by its own wording rather than by the file name or a hash, so the owner can replace
 * the file wholesale with MIT or a proprietary text without touching the test.
 *
 * @param {string} text Contents of `LICENSE`.
 * @returns {boolean}
 */
export function isPlaceholderLicense(text) {
  return /No license is granted yet/i.test(text) || /license text is pending the owner/i.test(text);
}

/**
 * Describes what is wrong with a licence file, or returns null when it is acceptable.
 *
 * The two branches are deliberately different. A placeholder must keep reserving the rights and must not grant a
 * licence; a chosen licence only has to identify itself, either through a copyright line or a recognised title.
 * Requiring the placeholder wording forever would make the documented MIT path fail the suite.
 *
 * @param {string} text Contents of `LICENSE`.
 * @returns {string | null} Human-readable violation, or null.
 */
export function licenseViolation(text) {
  if (text.trim().length === 0) return 'the file is empty';

  if (isPlaceholderLicense(text)) {
    if (!/Copyright/i.test(text)) return 'the placeholder lost its copyright line';
    if (!/All rights reserved/i.test(text)) return 'the placeholder no longer reserves the rights';
    if (/Permission is hereby granted/i.test(text)) return 'the placeholder grants a licence';
    return null;
  }

  if (/Copyright/i.test(text) || RECOGNIZED_LICENSE_TITLE.test(text)) return null;
  return 'the file has neither a copyright line nor a recognised licence title';
}

describe('licence hand-off', () => {
  it('accepts the shipped placeholder and any owner-chosen licence', () => {
    expect(existsSync(join(ROOT, 'LICENSE'))).toBe(true);
    const license = read('LICENSE');

    expect(licenseViolation(license)).toBeNull();
  });

  it('keeps the placeholder honest: rights reserved, no granted licence', () => {
    const placeholder = [
      'Copyright (c) 2026. No license is granted yet; the license text is pending the owner\'s',
      'decision. All rights reserved until then.',
    ].join('\n');

    expect(isPlaceholderLicense(placeholder)).toBe(true);
    expect(licenseViolation(placeholder)).toBeNull();
    expect(licenseViolation(placeholder.replace('All rights reserved until then.', 'Use is permitted.'))).toMatch(
      /reserves the rights/,
    );
    expect(licenseViolation(`${placeholder}\nPermission is hereby granted, free of charge.`)).toMatch(/grants a licence/);
  });

  it('does not fail when the owner replaces the placeholder with MIT', () => {
    const mit = [
      'MIT License',
      '',
      'Copyright (c) 2026 The Owner',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software…',
    ].join('\n');

    expect(isPlaceholderLicense(mit)).toBe(false);
    expect(licenseViolation(mit)).toBeNull();
  });

  it('accepts a proprietary notice and rejects an empty or unrelated file', () => {
    const proprietary = 'Copyright (c) 2026 The Owner. All rights reserved. No part may be reused without permission.';
    expect(licenseViolation(proprietary)).toBeNull();
    expect(licenseViolation('Apache License, Version 2.0')).toBeNull();
    expect(licenseViolation('   \n')).toMatch(/empty/);
    expect(licenseViolation('Just some notes.')).toMatch(/copyright line|licence title/);
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

  it('keeps package.json and the lockfile root on the same version', () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages?.['']?.version).toBe(pkg.version);
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
