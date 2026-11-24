import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 2.1 contrast guard for the single stylesheet.
 *
 * The test reads the real tokens from `public/css/app.css` instead of a copy, so a colour tweak that quietly drops
 * below the floor fails here. Text pairs are measured against both surfaces the app uses: white cards and the stone
 * canvas. Non-text pairs (focus ring, status dots) have a 3:1 floor.
 */
const cssPath = fileURLToPath(new URL('../../public/css/app.css', import.meta.url));
const readmePath = fileURLToPath(new URL('../../docs/screenshots/m6/README.md', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

/**
 * Reads the `:root` token block. Components reference tokens only, so these values are the whole palette.
 *
 * @param {string} source Stylesheet text.
 * @returns {Record<string, string>} Token name (without `--`) → hex value.
 */
function readTokens(source) {
  const root = /:root\s*\{([\s\S]*?)\}/.exec(source)?.[1];
  if (!root) throw new Error('`:root` token block not found in app.css');
  return Object.fromEntries(
    [...root.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((match) => [match[1], match[2].toLowerCase()]),
  );
}

/**
 * Relative luminance per WCAG 2.1.
 *
 * @param {string} hex `#rrggbb`.
 * @returns {number} 0..1.
 */
function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * @param {string} foreground `#rrggbb`.
 * @param {string} background `#rrggbb`.
 * @returns {number} Contrast ratio, 1..21.
 */
function contrast(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Splits a stylesheet into selector/declaration pairs. Media queries are unwrapped by the regex because each nested
 * block still matches on its own; `@`-prelude fragments are ignored by the selector allowlists.
 *
 * @param {string} source Stylesheet text.
 * @returns {Array<{ selector: string, body: string }>}
 */
function rules(source) {
  // Comments sit between rules and would otherwise be glued onto the following selector.
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({ selector: match[1].trim(), body: match[2] }))
    .filter((rule) => !rule.selector.startsWith('@'));
}

const tokens = readTokens(css);
const white = tokens['color-pure-white'];
const canvas = tokens['color-stone-canvas'];

/** @type {Array<[string, string, number, number]>} name, background token, minimum, actual */
const textPairs = [
  ['ink on white', 'color-ink-black', 4.5],
  ['ink on canvas', 'color-ink-black', 4.5],
  ['soot on white', 'color-soot', 4.5],
  ['soot on canvas', 'color-soot', 4.5],
  ['warm gray on white', 'color-warm-gray', 4.5],
  ['warm gray on canvas', 'color-warm-gray', 4.5],
  ['healthy status on white', 'color-status-healthy', 4.5],
  ['healthy status on canvas', 'color-status-healthy', 4.5],
  ['watch status on white', 'color-status-watch', 4.5],
  ['watch status on canvas', 'color-status-watch', 4.5],
  ['risk status on white', 'color-status-risk', 4.5],
  ['risk status on canvas', 'color-status-risk', 4.5],
];

describe('contrast tokens', () => {
  it.each(textPairs)('%s meets the WCAG AA text floor', (label, token, minimum) => {
    const background = label.endsWith('on white') ? white : canvas;
    expect(tokens[token], `token ${token}`).toBeTruthy();
    expect(contrast(tokens[token], background), label).toBeGreaterThanOrEqual(minimum);
  });

  it('keeps the ash gray out of meaningful text', () => {
    // Ash gray is a border/disabled tone: 2.52:1 on white is legal only for disabled and placeholder content, which
    // WCAG explicitly exempts from the 4.5:1 text floor.
    expect(contrast(tokens['color-ash-gray'], white)).toBeLessThan(4.5);

    // Negative lookbehind keeps `border-color` out: a border is a non-text surface, not coloured copy.
    const textRules = rules(css).filter((rule) =>
      /(?<!-)color:\s*var\(--color-ash-gray\)/.test(rule.body),
    );
    expect(textRules.length).toBeGreaterThan(0);
    for (const rule of textRules) {
      // The only allowed text use is a disabled control (`.input:disabled` and friends).
      expect(rule.selector, `ash-gray text in "${rule.selector}"`).toMatch(/:disabled/);
    }
  });

  it('records the highlight pair as an explicit owner exception', () => {
    const ratio = contrast(tokens['color-cyan-edge'], tokens['color-sky-wash']);
    // Below AA even for large text (3:1). The pair is a deliberate brand decision; the test locks both the measured
    // value and the note so the exception cannot silently spread to body copy.
    expect(ratio).toBeLessThan(3);
    expect(ratio).toBeGreaterThan(2);

    const comment = /\/\*([\s\S]*?)\*\/\s*\.highlight/.exec(css)?.[1] ?? '';
    expect(comment, 'highlight rule must carry the exception comment').toMatch(/Owner exception/i);
    expect(comment).toContain('2.29');

    const readme = readFileSync(readmePath, 'utf8');
    expect(readme).toContain('#3398e1');
    expect(readme).toContain('#c1e1f7');
    expect(readme).toContain('2,29');
  });

  it('uses a focus ring that clears 3:1 on both surfaces', () => {
    const ring = tokens['color-cyan-focus'];
    expect(ring, 'a dedicated focus token keeps the ring measurable').toBeTruthy();
    expect(contrast(ring, white)).toBeGreaterThanOrEqual(3);
    expect(contrast(ring, canvas)).toBeGreaterThanOrEqual(3);

    // The brand cyan is 2.99:1 on the canvas — the reason the ring is one step darker.
    expect(contrast(tokens['color-cyan-edge'], canvas)).toBeLessThan(3);
  });

  it('paints every focus outline with the measured ring token', () => {
    const focusRules = rules(css).filter((rule) => rule.selector.includes('focus'));
    const outlineRules = focusRules.filter((rule) => /outline:/.test(rule.body));
    expect(outlineRules.length).toBeGreaterThanOrEqual(5);

    for (const rule of outlineRules) {
      if (/outline:\s*none/.test(rule.body)) {
        // The pointer-focus reset is only legal because `:focus-visible` right above it restores the ring.
        expect(rule.selector).toContain(':focus:not(:focus-visible)');
        continue;
      }
      expect(rule.body, rule.selector).toContain('2px solid var(--color-cyan-focus)');
      expect(rule.body, rule.selector).toMatch(/outline-offset:\s*-?2px/);
    }
  });

  it('marks status by text plus a dot, never by colour alone', () => {
    const badge = rules(css).find((rule) => rule.selector === '.badge');
    const dot = rules(css).find((rule) => rule.selector === '.badge::before');
    expect(badge).toBeTruthy();
    expect(dot).toBeTruthy();
    // `currentColor` ties the dot to the status text, so a status never loses its label when colour is unavailable.
    expect(dot.body).toContain('background-color: currentColor');
    expect(badge.body).toContain('var(--color-warm-gray)');
  });

  it('keeps compact interactive targets at least 24 px', () => {
    const rule = (selector) => rules(css).find((entry) => entry.selector === selector);

    // A `<summary>` measured 23.67 px with 2 px padding; the explicit floor is what the browser audit checks.
    expect(rule('.chart__table summary')?.body).toMatch(/min-height:\s*24px/);
    expect(rule('.chart__table summary')?.body).toMatch(/padding-block:\s*3px/);
    expect(rule('.table__channel')?.body).toMatch(/min-height:\s*24px/);
    expect(rule('.range')?.body).toMatch(/min-height:\s*24px/);
    expect(rule('.choice')?.body).toMatch(/min-height:\s*28px/);
    expect(rule('.btn--sm')?.body).toMatch(/min-height:\s*28px/);

    // Dense row links get padding, but not the block channel link: 10 px there grew every row.
    const dense = rules(css).find((entry) => entry.selector.includes('.table td a:not(.btn)'));
    expect(dense?.selector).toContain(':not(.table__channel)');
  });

  it('keeps the reduced-motion override global', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(reduced).toContain('animation-duration: 0.01ms !important');
    expect(reduced).toContain('transition-duration: 0.01ms !important');
    expect(reduced).toContain('scroll-behavior: auto !important');
  });
});
