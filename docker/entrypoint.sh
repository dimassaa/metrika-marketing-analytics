#!/bin/sh
# Container start-up: materialise secrets, apply migrations, optionally seed the demo stand, then replace this shell
# with the application. `exec` keeps the app as a direct child of the container's init process, so SIGTERM reaches
# Node and the graceful shutdown in `src/server.js` runs.
set -eu

DATA_DIR=/app/data
SECRET_FILE="${SESSION_SECRET_FILE:-$DATA_DIR/session-secret}"

# A secret supplied by the operator always wins. Otherwise the named volume keeps a generated 32-byte hex secret
# across restarts; regenerating it on every boot would silently invalidate every existing session.
if [ -z "${SESSION_SECRET:-}" ]; then
  if [ -s "$SECRET_FILE" ]; then
    SESSION_SECRET=$(cat "$SECRET_FILE")
  else
    SESSION_SECRET=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
    mkdir -p "$(dirname "$SECRET_FILE")"
    # Create the file already owner-only: umask closes the window between creation and chmod.
    umask 077
    printf '%s' "$SESSION_SECRET" > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
  fi
  export SESSION_SECRET
fi

# A restore may stage a dump larger than the 256 MB `/tmp` tmpfs, so the documented restore temporary directory is a
# directory on the app-data volume, not `/tmp`.
mkdir -p "$DATA_DIR/tmp"
chmod 700 "$DATA_DIR/tmp"

# Migrations are idempotent and hold an advisory lock, so restarts and concurrent replicas are safe. `node` is used
# directly instead of `npm run migrate` to keep the process tree free of a wrapper that would not forward signals.
if [ "${RUN_MIGRATIONS:-true}" != "false" ]; then
  node db/migrate.js
fi

# The guard inside `scripts/seed-demo.js` decides whether the demo data is needed; this flag only opts into checking.
if [ "${AUTO_SEED_DEMO:-false}" = "true" ]; then
  node scripts/seed-demo.js
fi

exec "$@"
