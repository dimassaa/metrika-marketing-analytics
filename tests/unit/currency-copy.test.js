import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Recursively collects user-facing source files.
 *
 * The rule is a copy rule, not a code rule: comments and docs may discuss the Belarusian rouble by name, while a
 * screen or an island string must name the currency as BYN. Restricting the scan to views and the client keeps the
 * guard on copy without flagging an explanatory comment in a service.
 *
 * @param {string} directory
 * @param {string[]} extensions
 * @returns {string[]}
 */
function filesUnder(directory, extensions) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesUnder(path, extensions));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      files.push(path);
    }
  }
  return files;
}

describe('user-facing currency copy', () => {
  it('never spells the currency as roubles in views or client strings', () => {
    const files = [
      ...filesUnder('src/views', ['.ejs']),
      ...filesUnder('client', ['.js', '.jsx']),
    ];
    const offenders = files.filter((file) => /рубл/i.test(readFileSync(file, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
