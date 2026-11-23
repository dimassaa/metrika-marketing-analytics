# syntax=docker/dockerfile:1

# `client-build` holds both the source public tree and the Vite output. The runtime copies this single directory,
# which is what keeps `og-cover.svg`, fonts and `app.css` next to the fingerprinted bundles in `public/assets`.
FROM node:24-bookworm-slim AS client-build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY vite.config.js ./
COPY client ./client
# Islands import shared formatters and labels from `src/lib`; without them Rollup cannot resolve the bundle.
COPY src/lib ./src/lib
# `.dockerignore` excludes the host's `public/assets`, so this is the source tree only and Vite writes a fresh build.
COPY public ./public
RUN npm run build

# Production dependencies are installed in their own stage: the runtime image never contains Vite, Supertest or
# Vitest, and `NODE_ENV` is not pinned here so the final stage remains the only owner of the production environment.
FROM node:24-bookworm-slim AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS runtime

# PostgreSQL 18 client from PGDG: `pg_dump`/`pg_restore` refuse a server whose major is newer than the client's,
# and Debian bookworm only ships 15. The client is a runtime need, not a build-time convenience, because Task 2
# backs up the database from inside this image.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client-18; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY --chown=node:node package.json package-lock.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node src/ ./src
COPY --chown=node:node db/ ./db
COPY --chown=node:node scripts/ ./scripts
# The one and only frontend copy: source `public/` and the freshly built `public/assets` travel together.
COPY --from=client-build /app/public ./public
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# Named volumes inherit this ownership on first mount. `/app/data` keeps the session secret, backup key and restore
# temporary files; `/backup` holds encrypted dumps and must be writable by the non-root process.
RUN mkdir -p /app/data /backup \
 && chmod 0755 /usr/local/bin/entrypoint.sh \
 && chown -R node:node /app /backup

USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=15s --start-period=30s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.js"]
