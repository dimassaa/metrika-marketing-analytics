import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * These are contract tests over the delivery artefacts, not a build test: they read the Dockerfile and the Compose
 * file as text and fail when a security property silently disappears. A running container is verified separately by
 * the smoke commands recorded in `docs/screenshots/m6/README.md`; text alone never proves the image boots.
 */
const ROOT = process.cwd();

/** @param {string} path @returns {string} */
function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

const dockerfile = read('Dockerfile');
const dockerignore = read('.dockerignore');
const gitattributes = read('.gitattributes');
const compose = read('docker-compose.yml');
const entrypoint = read('docker/entrypoint.sh');

/**
 * Splits a Dockerfile into named stages so stage-local rules ("production only in the final stage") can be asserted
 * without matching the same words in a different stage.
 * @param {string} source Dockerfile text.
 * @returns {Array<{ name: string, body: string }>}
 */
function stages(source) {
  const chunks = source.split(/^FROM\s+/m).slice(1);
  return chunks.map((chunk) => {
    const [header, ...rest] = chunk.split('\n');
    const name = header.match(/\bAS\s+(\S+)/i)?.[1] ?? '';
    return { name, body: rest.join('\n') };
  });
}

const parsedStages = stages(dockerfile);
const finalStage = parsedStages.at(-1);

describe('Dockerfile', () => {
  it('declares at least three stages', () => {
    expect(parsedStages.length).toBeGreaterThanOrEqual(3);
  });

  it('names the client build and production dependency stages', () => {
    const names = parsedStages.map((stage) => stage.name);
    expect(names).toContain('client-build');
    expect(names).toContain('prod-deps');
  });

  it('sets NODE_ENV=production only in the final stage', () => {
    for (const stage of parsedStages.slice(0, -1)) {
      expect(stage.body, `${stage.name} must not pin a production environment`).not.toMatch(
        /NODE_ENV\s*=\s*production/,
      );
    }
    expect(finalStage.body).toMatch(/ENV\s+NODE_ENV\s*=\s*production/);
  });

  it('runs the container as the non-root node user', () => {
    const user = finalStage.body.match(/^USER\s+(\S+)/m)?.[1];
    expect(user).toBe('node');
    expect(user).not.toBe('root');
  });

  it('copies the whole built public tree from the build stage exactly once', () => {
    const copies = dockerfile.match(/^COPY\s+--from=client-build\s+\/app\/public\s+\.\/public\s*$/gm) ?? [];
    expect(copies).toHaveLength(1);
  });

  it('never copies public/assets or the public tree from the host into the runtime stage', () => {
    expect(finalStage.body).not.toMatch(/^COPY\s+(\.\/)?public(?:\/assets)?\s+/m);
    expect(dockerfile).not.toMatch(/^COPY\s+(\.\/)?public\/assets\s+/m);
  });

  it('never copies .env into the image', () => {
    expect(dockerfile).not.toMatch(/^COPY\s+.*\.env(?:\s|$)/m);
  });

  it('copies only the runtime directories named by the brief', () => {
    for (const path of ['src/', 'db/', 'scripts/']) {
      expect(finalStage.body).toMatch(new RegExp(`^COPY\\s+(--chown=\\S+\\s+)?${path.replace('/', '\\/')}\\s`, 'm'));
    }
    expect(finalStage.body).toMatch(/^COPY\s+(--chown=\S+\s+)?package\.json\s+package-lock\.json\s+\.\//m);
  });

  it('installs the PostgreSQL 18 client from PGDG', () => {
    expect(dockerfile).toMatch(/apt\.postgresql\.org/);
    expect(dockerfile).toMatch(/postgresql-client-18/);
  });

  it('defines a healthcheck that fails on a non-ok response', () => {
    expect(dockerfile).toMatch(/HEALTHCHECK/);
    expect(dockerfile).toMatch(/127\.0\.0\.1:3000\/health/);
    expect(dockerfile).toMatch(/r\.ok/);
  });
});

describe('.dockerignore', () => {
  it.each([
    '.env',
    '.git',
    'tests/',
    'docs/',
    'node_modules',
    'public/assets',
    'backups',
    'coverage',
    '.superpowers',
  ])('excludes %s', (entry) => {
    expect(dockerignore.split(/\r?\n/).map((line) => line.trim())).toContain(entry);
  });
});

describe('.gitattributes', () => {
  it('keeps shell scripts and the Dockerfile on LF for Windows clones', () => {
    const lines = gitattributes.split(/\r?\n/).map((line) => line.trim());
    expect(lines).toContain('*.sh text eol=lf');
    expect(lines).toContain('Dockerfile text eol=lf');
  });
});

describe('docker/entrypoint.sh', () => {
  it('uses a strict shell and never wraps the process in npm', () => {
    expect(entrypoint.startsWith('#!/bin/sh')).toBe(true);
    expect(entrypoint).toMatch(/set -eu/);
    // Comments may explain why npm is not used; only executable lines are the contract.
    const code = entrypoint
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/\bnpm\b/);
    expect(entrypoint).toMatch(/exec "\$@"/);
  });

  it('creates a session secret file with owner-only permissions when the variable is empty', () => {
    expect(entrypoint).toMatch(/SESSION_SECRET_FILE:-/);
    expect(entrypoint).toMatch(/chmod 600/);
    expect(entrypoint).toMatch(/randomBytes\(32\)/);
  });

  it('runs migrations unless explicitly disabled and seeds only on request', () => {
    expect(entrypoint).toMatch(/RUN_MIGRATIONS/);
    expect(entrypoint).toMatch(/node db\/migrate\.js/);
    expect(entrypoint).toMatch(/AUTO_SEED_DEMO/);
    expect(entrypoint).toMatch(/node scripts\/seed-demo\.js/);
  });
});

describe('docker-compose.yml', () => {
  it('uses PostgreSQL 18 and does not publish its port', () => {
    expect(compose).toMatch(/postgres:18/);
    expect(compose).not.toMatch(/privileged:\s*true/);
    expect(compose).not.toMatch(/5432:5432/);
    expect(compose).not.toMatch(/^\s*-\s*"?5432:/m);
  });

  it('healthchecks the database through its own container variables with escaped dollars', () => {
    expect(compose).toMatch(/pg_isready/);
    expect(compose).toMatch(/\$\$POSTGRES_USER/);
    expect(compose).toMatch(/\$\$POSTGRES_DB/);
  });

  it('mounts the PostgreSQL 18 volume at /var/lib/postgresql', () => {
    expect(compose).toMatch(/db_data:\/var\/lib\/postgresql/);
  });

  it('starts the app only after the database reports healthy', () => {
    expect(compose).toMatch(/condition:\s*service_healthy/);
    expect(compose).toMatch(/build:\s*\./);
  });

  it('binds the app port to loopback only and interpolates APP_PORT with a default', () => {
    expect(compose).toMatch(/127\.0\.0\.1:\$\{APP_PORT:-3000\}:3000/);
  });

  it('runs the app with a read-only rootfs, a 256m tmpfs and dropped capabilities', () => {
    expect(compose).toMatch(/read_only:\s*true/);
    expect(compose).toMatch(/\/tmp:mode=1777,size=256m/);
    expect(compose).toMatch(/cap_drop:\s*\n\s*-\s*ALL/);
    expect(compose).toMatch(/no-new-privileges:true/);
    expect(compose).toMatch(/init:\s*true/);
  });

  it('wires the demo-only cookie exception and the runtime file locations', () => {
    expect(compose).toMatch(/COOKIE_SECURE:\s*"?false"?/);
    expect(compose).toMatch(/DEMO_INSECURE_COOKIES:\s*"?true"?/);
    expect(compose).toMatch(/AUTO_SEED_DEMO:\s*"?true"?/);
    expect(compose).toMatch(/SESSION_SECRET_FILE:\s*\/app\/data\/session-secret/);
    expect(compose).toMatch(/BACKUP_KEY_FILE:\s*\/app\/data\/backup\.key/);
    expect(compose).toMatch(/BACKUP_DIR:\s*\/backup/);
    expect(compose).toMatch(/RESTORE_TMP_DIR:\s*\/app\/data\/tmp/);
  });

  it('never passes the backup key through the environment', () => {
    expect(compose).not.toMatch(/^\s*BACKUP_KEY:\s*/m);
  });

  it('healthchecks the app against its own /health response', () => {
    expect(compose).toMatch(/127\.0\.0\.1:3000\/health/);
    expect(compose).toMatch(/r\.ok\s*\?\s*0\s*:\s*1/);
  });

  it('declares the three named volumes', () => {
    for (const volume of ['db_data', 'app_data', 'backup_data']) {
      expect(compose).toMatch(new RegExp(`^\\s{2}${volume}:`, 'm'));
    }
  });
});
