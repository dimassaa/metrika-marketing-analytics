import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = process.cwd();
const README = join(ROOT, 'README.md');
const DOCS_DIR = join(ROOT, 'docs');
const DEPLOYMENT = join(DOCS_DIR, 'deployment.md');
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|svg)$/i;
const EXTERNAL_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Lists every markdown file under `docs/` in a stable order.
 * @param {string} dir
 * @returns {string[]}
 */
function walkMarkdown(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return walkMarkdown(path);
      return path.endsWith('.md') ? [path] : [];
    });
}

/**
 * Removes fenced blocks and inline code before link extraction.
 *
 * Documentation is full of command examples such as `curl http://localhost:3000/health` and markdown-looking
 * fragments inside backticks. Treating those as links produces false "broken link" failures and hides real ones,
 * so the test deliberately looks only at prose markup.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function stripCode(markdown) {
  return markdown
    .replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

/**
 * Extracts inline-link targets and reference definitions from markdown prose.
 *
 * Paths are resolved relative to the document that contains the link. Absolute site paths (`/app/...`), anchors
 * and external URLs are not repository files and are skipped.
 *
 * @param {string} markdown
 * @returns {string[]} Raw link targets, in document order.
 */
export function extractRelativeLinks(markdown) {
  const prose = stripCode(markdown);
  const links = [];

  for (const match of prose.matchAll(/!?\[[^\]]*]\(\s*(<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
    links.push(match[1].replace(/^<|>$/g, ''));
  }
  for (const match of prose.matchAll(/^ {0,3}\[[^\]]+]:\s*(\S+)\s*$/gm)) {
    links.push(match[1]);
  }

  return links.filter((link) => {
    if (!link || link.startsWith('#') || link.startsWith('?') || link.startsWith('/')) return false;
    if (EXTERNAL_SCHEME.test(link)) return false;
    return true;
  });
}

/**
 * Resolves a relative markdown target into an on-disk path, dropping the fragment and query string.
 * @param {string} documentPath Absolute path of the markdown file.
 * @param {string} link Raw target from the document.
 * @returns {string}
 */
function targetPath(documentPath, link) {
  const withoutFragment = link.split('#')[0].split('?')[0];
  const decoded = decodeURIComponent(withoutFragment);
  return resolve(dirname(documentPath), decoded);
}

const markdownFiles = [README, ...walkMarkdown(DOCS_DIR)];

describe('documentation link hygiene', () => {
  it('keeps every relative link and image pointing at a real file', () => {
    const broken = [];

    for (const file of markdownFiles) {
      const markdown = readFileSync(file, 'utf8');
      for (const link of extractRelativeLinks(markdown)) {
        const path = targetPath(file, link);
        if (!existsSync(path)) broken.push(`${file.slice(ROOT.length + 1)} -> ${link}`);
      }
    }

    expect(broken, broken.join('\n')).toEqual([]);
  });

  it('does not contain broken screenshot references', () => {
    const broken = [];

    for (const file of markdownFiles) {
      const markdown = readFileSync(file, 'utf8');
      for (const link of extractRelativeLinks(markdown)) {
        if (!IMAGE_EXTENSION.test(link.split('#')[0].split('?')[0])) continue;
        const path = targetPath(file, link);
        if (!existsSync(path)) broken.push(`${file.slice(ROOT.length + 1)} -> ${link}`);
      }
    }

    expect(broken, broken.join('\n')).toEqual([]);
  });

  it('does not leak author home paths', () => {
    const patterns = [
      /\/home\/[A-Za-z0-9._-]+\//,
      /\/root\/[A-Za-z0-9._-]+\//,
      /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/i,
      /[A-Za-z]:\/Users\/[A-Za-z0-9._-]+/i,
      /\/Users\/[A-Za-z0-9._-]+\//,
    ];
    const offenders = [];

    for (const file of markdownFiles) {
      const markdown = readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        if (pattern.test(markdown)) offenders.push(`${file.slice(ROOT.length + 1)} matches ${pattern}`);
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('keeps the deployment guide sections that operators rely on', () => {
    const deployment = readFileSync(DEPLOYMENT, 'utf8');

    expect(deployment).toMatch(/^## \d+\. Windows 10$/m);
    expect(deployment).toMatch(/^## \d+\. Docker-путь$/m);
    expect(deployment).toMatch(/^## \d+\. Резервное копирование и восстановление$/m);
    expect(deployment).toMatch(/^## \d+\. TLS и reverse proxy$/m);
  });

  it('ignores markdown-looking fragments inside fenced and inline code', () => {
    const sample = [
      'A [real link](../docs/deployment.md).',
      '`[inline spoiler](missing-inline.md)`',
      '```',
      '[fenced spoiler](missing-fenced.md)',
      '```',
      'A [fragment](#section) and [site path](/app/dashboard) are not files.',
    ].join('\n');

    expect(extractRelativeLinks(sample)).toEqual(['../docs/deployment.md']);
  });
});
