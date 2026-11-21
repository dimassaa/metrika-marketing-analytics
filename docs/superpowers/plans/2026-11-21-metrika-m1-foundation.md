# M1 «Фундамент» — план реализации

> **Для агентов:** обязательный навык — `superpowers:subagent-driven-development` (рекомендуется) или
> `superpowers:executing-plans`. Выполнять задачи по порядку, отмечать шаги `- [x]`, коммитить в конце задачи.

**Цель:** пустой репозиторий → запускаемое приложение с PostgreSQL, детерминированным сидом, дизайн-системой,
публичным лендингом, авторизацией на 3 роли, каркасом приложения и зелёными тестами.

**Архитектура:** Express MVC (routes → controllers → services → repositories → EJS), серверные сессии в PostgreSQL,
CSRF double-submit, RBAC по матрице прав. React на этом этапе не нужен — острова появятся в M4.

**Стек:** Node 24 LTS (локально 26), Express 5, EJS 3 + express-ejs-layouts, PostgreSQL 18, `pg`, Zod, pino,
`@node-rs/argon2`, `express-session` + `connect-pg-simple`, helmet, express-rate-limit, Vitest + Supertest.

**Спеки:** `docs/superpowers/specs/2026-11-21-marketing-analytics-design.md`,
`docs/superpowers/specs/2026-11-21-metrics-spec.md`,
`docs/superpowers/specs/2026-11-21-assignment-traceability.md`.

## Global Constraints

- Только JavaScript, ESM, без TypeScript; импорты с `.js`.
- Один стилевой файл `public/css/app.css`; никаких CSS-фреймворков, `<style>`, вторых `.css`.
- Весь UI-текст русский; код и коммиты английские.
- Деньги — целые копейки (`BIGINT`), вывод в BYN с запятой и знаком НБРБ; запрещены `$`, `₽`, `руб.`.
- Даты: `timestamptz` UTC, календарные `date`; отображение Europe/Minsk; «сегодня» = data anchor
  (`MAX(daily_stats.stat_date)`), fallback — текущая дата Minsk.
- PostgreSQL 18, FK/CHECK/UNIQUE, никаких ORM.
- RBAC на сервере, CSRF на всех небезопасных методах, пароли argon2id.
- Сессии: httpOnly, sameSite=lax, secure в production, TTL 8 часов, regenerate при входе.
- Порты: приложение 3000; БД `metrika_dev` и `metrika_test` на localhost.
- Никаких CDN; шрифты и изображения локальные.
- Коммит в конце каждой задачи от имени владельца репозитория (git config настроен).

## Review Focus

1. **Пустая БД (без сида).** Любая страница приложения должна отдавать 200 и честное пустое состояние, а не 500;
   data anchor без статистики падает на текущую дату. Тест — Task 7.
2. **Нулевые знаменатели.** `CAC/LTV/ROMI` при отсутствии клиентов или расхода возвращают `null`, а не
   `NaN/Infinity`; в интерфейсе «—». В M1 проверяется data anchor и пустые KPI. Тест — Task 7.
3. **Прямой URL мимо навигации.** Viewer/analyst, открывший `/app/admin/users` вручную, получает 403,
   а не 404/редирект. Тест — Task 7.
4. **Открытый редирект.** `?next=https://evil.example` после входа ведёт на `/app/dashboard`, не наружу.
   Тест — Task 6.
5. **Заблокированный пользователь и CSRF.** Неактивный пользователь не входит; POST без CSRF-токена получает 403
   и не создаёт сессию. Тесты — Task 6.

---

## Карта файлов M1

```
package.json .env.example .env(local) vitest.config.js README.md
src/
  server.js app.js
  config/env.js permissions.js
  lib/logger.js errors.js db.js csrf.js seo.js dates.js
  middleware/requestId.js errors.js auth.js csrf.js rateLimit.js
  routes/public.routes.js auth.routes.js app.routes.js
  controllers/public.controller.js auth.controller.js app.controller.js admin.controller.js
  services/auth.service.js audit.service.js
  repositories/users.repo.js audit.repo.js reference.repo.js
  views/layouts/public.ejs app.ejs
  views/partials/head.ejs public-header.ejs public-footer.ejs sidebar.ejs topbar.ejs
  views/pages/home.ejs login.ejs dashboard.ejs admin-users.ejs coming-soon.ejs
  views/errors/403.ejs 404.ejs 500.ejs
db/
  migrate.js migrations/001_init.sql seed/seed.js seed/data.js
tests/
  helpers/app.js helpers/db.js helpers/csrf.js
  unit/config-env.test.js unit/permissions.test.js unit/single-stylesheet.test.js
  integration/health.test.js migrations.test.js seed.test.js landing.test.js auth.test.js rbac.test.js
public/
  css/app.css fonts/ img/logo.svg img/favicon.svg img/og-cover.svg
docs/screenshots/m1/
```

---

### Task 1: Каркас, конфигурация, логи, ошибки, `/health`

**Files:**
- Create: `package.json`, `.env.example`, `vitest.config.js`, `src/config/env.js`, `src/lib/logger.js`,
  `src/lib/errors.js`, `src/lib/db.js`, `src/middleware/requestId.js`, `src/middleware/errors.js`,
  `src/app.js`, `src/server.js`, `tests/helpers/env.js`
- Test: `tests/unit/config-env.test.js`, `tests/integration/health.test.js`

**Interfaces:**
- Consumes: ничего.
- Produces: `env` (объект), `parseEnv(source)` (бросает при невалидном), `logger`, классы `AppError`,
  `NotFoundError`, `ForbiddenError`, `UnauthorizedError`, `ValidationError`; `pool`, `query(text, params)`,
  `withTransaction(fn)`, `closeDb()`, `pingDb()`; `createApp({ db })`.

- [ ] **Step 1: Инициализировать npm-проект и зависимости**

```bash
npm init -y
npm pkg set type=module
npm i express@^5 ejs@^3 express-ejs-layouts@^4 pg@^8 zod@^4 dotenv@^16 pino@^9 pino-http@^10 \
  helmet@^8 compression@^1 express-session@^1 connect-pg-simple@^10 @node-rs/argon2@^2 \
  express-rate-limit@^7
npm i -D vitest@^3 supertest@^7
npm pkg set scripts.dev="node --watch src/server.js" scripts.start="node src/server.js" \
  scripts.migrate="node db/migrate.js" scripts.seed="node db/seed/seed.js" \
  scripts.test="vitest run" scripts.test:watch="vitest" engines.node=">=22"
```

- [ ] **Step 2: Создать `.env.example` и локальный `.env`**

`.env.example` (коммитится):
```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://user:password@localhost:5432/metrika_dev
TEST_DATABASE_URL=postgres://user:password@localhost:5432/metrika_test
SESSION_SECRET=change-me-to-a-random-32-byte-hex-string
APP_URL=http://localhost:3000
COOKIE_SECURE=false
LOG_LEVEL=info
```
Локальный `.env` — те же ключи, реальные значения:
`DATABASE_URL=postgres://dimass@localhost:5432/metrika_dev`, `TEST_DATABASE_URL=postgres://dimass@localhost:5432/metrika_test`,
`SESSION_SECRET` из `openssl rand -hex 32`. Создать БД: `createdb metrika_dev; createdb metrika_test`.
Windows-инструкция появится в M6; здесь достаточно локального Linux-стенда.

- [ ] **Step 3: Написать падающий тест валидации env**

`tests/unit/config-env.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { parseEnv } from '../../src/config/env.js';

const base = {
  NODE_ENV: 'test', PORT: '3000', DATABASE_URL: 'postgres://u@localhost/db',
  SESSION_SECRET: 'x'.repeat(32), APP_URL: 'http://localhost:3000',
  COOKIE_SECURE: 'false', LOG_LEVEL: 'info',
};

describe('parseEnv', () => {
  it('returns typed config', () => {
    expect(parseEnv(base)).toMatchObject({ port: 3000, cookieSecure: false, nodeEnv: 'test' });
  });
  it('rejects short session secret', () => {
    expect(() => parseEnv({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });
  it('rejects non-numeric port', () => {
    expect(() => parseEnv({ ...base, PORT: 'abc' })).toThrow(/PORT/);
  });
});
```

- [ ] **Step 4: Запустить тест и убедиться, что он падает**

Run: `npx vitest run tests/unit/config-env.test.js`
Expected: FAIL — `Failed to resolve import "../../src/config/env.js"`.

- [ ] **Step 5: Реализовать `src/config/env.js`, `src/lib/logger.js`, `src/lib/errors.js`, `src/lib/db.js`**

`env.js`: `import 'dotenv/config'`; `parseEnv(source)` через Zod; `SESSION_SECRET` минимум 32 символа;
`COOKIE_SECURE` через `z.enum(['true','false']).transform(v => v === 'true')`; экспорт `env = parseEnv(process.env)`.
`logger.js`: pino с `level: env.logLevel`, в test — `level: 'silent'`; `redact` для `req.headers.cookie`,
`req.headers.authorization`, `password`.
`errors.js`: `AppError extends Error` с `statusCode`, `code`, `isOperational = true`; подклассы 400/401/403/404.
`db.js`: `Pool` с `connectionString: env.databaseUrl`, `max: 10`; `query`, `withTransaction` (BEGIN/COMMIT/ROLLBACK,
`client.release()` в finally), `pingDb()` → `SELECT 1`, `closeDb()`.
`tests/helpers/env.js`: выставляет `NODE_ENV=test`, требует `TEST_DATABASE_URL`, иначе бросает с понятным текстом;
подключается через `setupFiles` в `vitest.config.js` (создать его в этой задаче:
`fileParallelism: false` до появления изоляции по схемам — зафиксировать в `IMPROVEMENTS.md`).

- [ ] **Step 6: Написать падающий интеграционный тест `/health`**

`tests/integration/health.test.js`:
```js
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';

describe('GET /health', () => {
  it('returns 200 with a healthy db', async () => {
    const app = createApp({ db: { query: async () => ({ rows: [{ ok: 1 }] }) } });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'up' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('returns 503 when db is down', async () => {
    const app = createApp({ db: { query: async () => { throw new Error('boom'); } } });
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.db).toBe('down');
  });
});
```

- [ ] **Step 7: Запустить и убедиться в падении**

Run: `npx vitest run tests/integration/health.test.js`
Expected: FAIL — нет `createApp`.

- [ ] **Step 8: Реализовать `src/app.js`, `src/server.js`, requestId и error middleware**

`createApp({ db })`:
- `app.set('trust proxy', 1)`; `app.disable('x-powered-by')`;
- middleware nonce: `res.locals.nonce = crypto.randomBytes(16).toString('base64')` **до** helmet;
- `helmet` с CSP из `design §10`: `script-src 'self'` + функция `(req,res) => \`'nonce-${res.locals.nonce}'\``,
  `style-src 'self'`, `style-src-attr 'unsafe-inline'` (Recharts иначе блокируется), `img-src 'self' data:`,
  `font-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`;
- `compression()`, `express.json({ limit: '100kb' })`, `express.urlencoded({ extended: false, limit: '100kb' })`;
- requestId (заголовок `x-request-id`, `crypto.randomUUID()`);
- pino-http с `genReqId: req => req.id`;
- `GET /health` → `db.query('SELECT 1')`, ответ `{ status, db, version }`, 503 при ошибке;
- 404 и центральный error handler: JSON для `/api/*`, HTML `errors/500.ejs` для остальных (шаблон создаётся
  позже; до Task 7 — plain text с тем же статусом, чтобы тесты были зелёными);
- `server.js`: создаёт app с реальным `pool`, слушает `env.port`, graceful shutdown по SIGINT/SIGTERM.

- [ ] **Step 9: Прогнать тесты**

Run: `npx vitest run tests/unit/config-env.test.js tests/integration/health.test.js`
Expected: 5 passed.

- [ ] **Step 10: Коммит**

```bash
git add package.json package-lock.json .env.example vitest.config.js src tests
git commit -m "feat: bootstrap express app with validated env and health check"
```

---

### Task 2: Схема БД и раннер миграций

**Files:**
- Create: `db/migrations/001_init.sql`, `db/migrate.js`, `tests/helpers/db.js`
- Test: `tests/integration/migrations.test.js`

**Interfaces:**
- Consumes: `env.databaseUrl`, `env.testDatabaseUrl`.
- Produces: `runMigrations({ connectionString })` → `Promise<string[]>` (применённые версии);
  хелперы `resetTestDatabase()`, `getTestPool()`, `closeTestPool()`; таблица `schema_migrations`.

- [ ] **Step 1: Написать падающий тест миграций**

`tests/integration/migrations.test.js` — три теста:
1. после `resetTestDatabase()` существует 15 таблиц (`users, sessions, channels, campaigns, daily_stats, customers,
   touchpoints, orders, goals, alerts, scenarios, audit_log, import_batches, media_assets, schema_migrations`);
2. повторный `runMigrations` возвращает `[]` и не бросает;
3. ограничения: заказ с `margin_cents > revenue_cents` отклоняется; удаление канала с кампанией отклоняется;
   `users` не принимает `role='owner'`.

Использовать `expect(pool.query(...)).rejects.toThrow(/violates/)`.

- [ ] **Step 2: Запустить и убедиться в падении**

Run: `npx vitest run tests/integration/migrations.test.js`
Expected: FAIL — нет `runMigrations`.

- [ ] **Step 3: Написать `db/migrations/001_init.sql`**

Точная схема (порядок таблиц важен для FK):

```sql
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','analyst','viewer')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));
CREATE INDEX users_role_idx ON users (role);

CREATE TABLE sessions (
  sid VARCHAR NOT NULL COLLATE "default",
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT sessions_pkey PRIMARY KEY (sid)
);
CREATE INDEX sessions_expire_idx ON sessions (expire);

CREATE TABLE channels (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]+$'),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'paid' CHECK (kind IN ('paid','owned','earned')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  target_cac_cents BIGINT CHECK (target_cac_cents >= 0),
  target_romi_pct NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]+$'),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','finished')),
  started_on DATE NOT NULL,
  ended_on DATE,
  budget_cents BIGINT CHECK (budget_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ended_on IS NULL OR ended_on >= started_on)
);
CREATE INDEX campaigns_channel_idx ON campaigns (channel_id);
CREATE INDEX campaigns_status_idx ON campaigns (status);

CREATE TABLE daily_stats (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  stat_date DATE NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  leads INTEGER NOT NULL DEFAULT 0 CHECK (leads >= 0),
  spend_cents BIGINT NOT NULL DEFAULT 0 CHECK (spend_cents >= 0),
  UNIQUE (campaign_id, stat_date)
);
CREATE INDEX daily_stats_date_idx ON daily_stats (stat_date);

CREATE TABLE customers (
  id BIGSERIAL PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  first_channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  first_campaign_id BIGINT REFERENCES campaigns(id) ON DELETE RESTRICT,
  acquired_at TIMESTAMPTZ NOT NULL,
  first_order_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customers_first_order_idx ON customers (first_order_at);
CREATE INDEX customers_first_channel_idx ON customers (first_channel_id);

CREATE TABLE touchpoints (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  campaign_id BIGINT REFERENCES campaigns(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL DEFAULT 'click' CHECK (kind IN ('click','impression','visit')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX touchpoints_customer_time_idx ON touchpoints (customer_id, occurred_at);
CREATE INDEX touchpoints_time_idx ON touchpoints (occurred_at);

CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  campaign_id BIGINT REFERENCES campaigns(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL,
  revenue_cents BIGINT NOT NULL CHECK (revenue_cents >= 0),
  margin_cents BIGINT NOT NULL CHECK (margin_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (margin_cents <= revenue_cents)
);
CREATE INDEX orders_time_idx ON orders (occurred_at);
CREATE INDEX orders_customer_idx ON orders (customer_id, occurred_at);

CREATE TABLE goals (
  id BIGSERIAL PRIMARY KEY,
  metric TEXT NOT NULL CHECK (metric IN ('cac','romi','ltv_cac','payback','new_customers')),
  channel_id BIGINT REFERENCES channels(id) ON DELETE CASCADE,
  target_value NUMERIC(14,2) NOT NULL CHECK (target_value >= 0),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE UNIQUE INDEX goals_unique_idx ON goals (metric, COALESCE(channel_id, 0), period_start, period_end);

CREATE TABLE alerts (
  id BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  rule TEXT NOT NULL CHECK (rule IN ('cac_spike','romi_below_target','romi_negative','payback_long','ltv_cac_low')),
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  period_start DATE NOT NULL,
  value NUMERIC(14,2),
  threshold NUMERIC(14,2),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','dismissed')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, rule, period_start)
);
CREATE INDEX alerts_status_idx ON alerts (status, detected_at DESC);

CREATE TABLE scenarios (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  params JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scenarios_created_idx ON scenarios (created_at DESC);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id);

CREATE TABLE import_batches (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('daily_stats','customers','touchpoints','orders')),
  filename TEXT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  rows_total INTEGER NOT NULL CHECK (rows_total >= 0),
  rows_ok INTEGER NOT NULL CHECK (rows_ok >= 0),
  rows_failed INTEGER NOT NULL CHECK (rows_failed >= 0),
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE media_assets (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT UNIQUE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  checksum TEXT NOT NULL,
  bytes BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER channels_updated_at BEFORE UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER campaigns_updated_at BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

- [ ] **Step 4: Реализовать `db/migrate.js`**

`runMigrations({ connectionString })`: advisory lock `pg_advisory_lock(742001)`, `CREATE TABLE IF NOT EXISTS
schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`, читает
`db/migrations/*.sql` по имени, применяет отсутствующие в транзакции, пишет версию, снимает lock в `finally`.
CLI-режим: `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)`, затем
`runMigrations({ connectionString: env.databaseUrl })`, лог и `exit(0/1)`.

- [ ] **Step 5: Реализовать `tests/helpers/db.js`**

`getTestPool()` — singleton Pool на `env.testDatabaseUrl`; `resetTestDatabase()` — `DROP SCHEMA public CASCADE;
CREATE SCHEMA public;` + `runMigrations` (только при `process.env.NODE_ENV === 'test'`); `closeTestPool()`.
`vitest.config.js` уже создан в Task 1 (`environment: 'node'`, `fileParallelism: false`,
`setupFiles: ['tests/helpers/env.js']`).

- [ ] **Step 6: Прогнать миграционные тесты**

Run: `npm test -- tests/integration/migrations.test.js`
Expected: 3 passed.

- [ ] **Step 7: Применить миграции к dev-БД и проверить вручную**

Run: `npm run migrate` → `applied 001_init.sql`; затем
`psql postgres://dimass@localhost:5432/metrika_dev -c '\dt'` → 15 таблиц.
Expected: команда завершается с кодом 0.

- [ ] **Step 8: Коммит**

```bash
git add db tests/helpers/db.js tests/integration/migrations.test.js
git commit -m "feat: add postgres schema with migrations and integrity constraints"
```

---

### Task 3: Детерминированный сид демо-данных

**Files:**
- Create: `src/lib/dates.js`, `db/seed/data.js`, `db/seed/seed.js`
- Test: `tests/integration/seed.test.js`

**Interfaces:**
- Consumes: `runMigrations`, `pool`.
- Produces: `seed({ anchorDate })` → `{ channels, campaigns, customers, orders, touchpoints, users }` (counts);
  `getDataAnchor()` считается позже в репозитории, сид лишь создаёт данные по вчерашний день Minsk.

- [ ] **Step 1: Написать падающий тест сида**

`tests/integration/seed.test.js`:
```js
// после resetTestDatabase()
const first = await seed();
expect(first.channels).toBe(8);
expect(first.campaigns).toBe(32);
expect(first.customers).toBeGreaterThanOrEqual(4000);
expect(first.orders).toBeGreaterThanOrEqual(8000);
expect(first.users).toBe(3);

const { rows: [anchor] } = await pool.query('SELECT max(stat_date) AS d FROM daily_stats');
expect(anchor.d).toBe(minskYesterday());

const bad = await pool.query('SELECT count(*)::int AS n FROM orders WHERE margin_cents > revenue_cents');
expect(bad.rows[0].n).toBe(0);

const mismatch = await pool.query(`
  SELECT count(*)::int AS n FROM customers c
  JOIN LATERAL (SELECT channel_id FROM touchpoints t WHERE t.customer_id = c.id ORDER BY occurred_at LIMIT 1) f ON true
  WHERE f.channel_id <> c.first_channel_id`);
expect(mismatch.rows[0].n).toBe(0);

const before = await pool.query('SELECT sum(revenue_cents)::text AS s FROM orders');
const second = await seed();
const after = await pool.query('SELECT sum(revenue_cents)::text AS s FROM orders');
expect(second.orders).toBe(first.orders);
expect(after.rows[0].s).toBe(before.rows[0].s);
```
Также проверить: 3 пользователя с ролями admin/analyst/viewer, у всех `password_hash` начинается с `$argon2`.

- [ ] **Step 2: Запустить и убедиться в падении**

Run: `npm test -- tests/integration/seed.test.js`
Expected: FAIL — нет `seed`.

- [ ] **Step 3: Реализовать `src/lib/dates.js`**

`minskToday()`, `minskYesterday()`, `toDateOnly(date)` (`YYYY-MM-DD` в Minsk), `addDays(date, n)`,
`startOfMonth(date)`, `formatDateRu(date)`, `isoWeekStart(date)`. Без внешних библиотек: `Intl.DateTimeFormat`
с `timeZone: 'Europe/Minsk'`, арифметика через `Date.UTC`.

- [ ] **Step 4: Заполнить `db/seed/data.js`**

Каналы (code, name, kind, target CAC BYN, target ROMI %):
`instagram/Instagram/paid/45/120`, `google/Google Ads/paid/55/140`, `yandex/Яндекс Директ/paid/48/110`,
`tiktok/TikTok/paid/35/80`, `telegram/Telegram Ads/paid/40/100`, `email/Email/owned/5/300`,
`seo/SEO/earned/12/250`, `bloggers/Блогеры/paid/60/90`.
Кампании: по 4 на канал (32), коды `instagram_retarget`, `instagram_cold`, …; статус `active`, кроме одной
`finished`; бюджет 3 000–25 000 BYN; даты внутри периода.
Пользователи: `admin@metrika.by` (Администратор), `analyst@metrika.by` (Маркетолог-аналитик),
`viewer@metrika.by` (Наблюдатель), пароль `Metrika2026!` (хэшируется при сиде).

- [ ] **Step 5: Реализовать `db/seed/seed.js`**

Требования:
- детерминированный PRNG `mulberry32(20261121)`, никакого `Math.random()`;
- идемпотентность: `TRUNCATE users, sessions, channels, campaigns, daily_stats, customers, touchpoints, orders,
  goals, alerts, scenarios, audit_log, import_batches, media_assets RESTART IDENTITY CASCADE`;
- период: 14 месяцев по вчерашний день Minsk включительно;
- 4 000 клиентов, распределение по каналам weighted (instagram 22%, google 18%, yandex 14%, tiktok 12%,
  telegram 9%, email 10%, seo 9%, bloggers 6%);
- 9 000–10 000 заказов, 1–5 на клиента, первый заказ = `first_order_at`, последующие — позже, не позже anchor;
  чек 60–180 BYN, маржа 35–55% от чека;
- 2–5 касаний на клиента: 70% — канал привлечения, остальные — другие; времена до первого заказа и между заказами;
  самое раннее касание всегда совпадает с `first_channel_id`;
- дневная статистика: spend с сезонностью (декабрь ×1.25, июль–август ×0.85), недельным профилем и шумом ±15%;
  impressions/clicks/leads согласованы (CTR 1–4%, CR 2–8%);
- канал `tiktok` деградирует в последние 2 месяца (CAC +30%), `seo` растёт;
- цели: `cac` blended 50 BYN, `romi` 120%, `ltv_cac` 3, `payback` 12 на период последних 12 месяцев;
- bulk insert батчами по 500 строк (не по одной), всё в одной транзакции;
- CLI-режим запускает `seed()` и печатает сводку.

- [ ] **Step 6: Прогнать тест сида**

Run: `npm test -- tests/integration/seed.test.js`
Expected: PASS; повторный запуск не меняет суммы.

- [ ] **Step 7: Прогнать сид на dev-БД и глазами проверить цифры**

Run: `npm run seed && psql $DATABASE_URL -c "select c.name, count(o.id) from channels c join campaigns cp on cp.channel_id=c.id join orders o on o.campaign_id=cp.id group by 1 order by 2 desc"`
Expected: 8 строк, суммы правдоподобны, нет нулевых каналов.

- [ ] **Step 8: Коммит**

```bash
git add src/lib/dates.js db/seed tests/integration/seed.test.js
git commit -m "feat: add deterministic seeded demo dataset for belarusian market"
```

---

### Task 4: Дизайн-система, шрифты, guard «один CSS»

**Files:**
- Create: `public/css/app.css`, `public/fonts/*`, `public/img/logo.svg`, `public/img/favicon.svg`,
  `public/img/og-cover.svg`, `src/views/partials/head.ejs`
- Test: `tests/unit/single-stylesheet.test.js`

**Interfaces:**
- Consumes: ничего.
- Produces: классы и токены, на которые опираются все шаблоны M1–M6: `.container`, `.card`, `.btn`, `.btn--primary`,
  `.btn--ghost`, `.input`, `.field`, `.table`, `.badge`, `.badge--healthy|watch|risk`, `.kpi`, `.skeleton`,
  `.empty-state`, `.byn`, `.u-hidden`, `.stack`, `.grid`.

- [ ] **Step 1: Скачать шрифты локально**

Inter и Inter Tight (variable, latin + cyrillic) — из пакетов Fontsource через npm pack (без CDN в рантайме):

```bash
mkdir -p /tmp/fonts-inter /tmp/fonts-inter-tight
npm pack @fontsource-variable/inter --pack-destination /tmp/fonts-inter
npm pack @fontsource-variable/inter-tight --pack-destination /tmp/fonts-inter-tight
tar -xzf /tmp/fonts-inter/*.tgz -C /tmp/fonts-inter
tar -xzf /tmp/fonts-inter-tight/*.tgz -C /tmp/fonts-inter-tight
mkdir -p /home/dimass/opencode/10/public/fonts
cp /tmp/fonts-inter/package/files/inter-latin-wght-normal.woff2 \
   /tmp/fonts-inter/package/files/inter-cyrillic-wght-normal.woff2 \
   /home/dimass/opencode/10/public/fonts/
cp /tmp/fonts-inter-tight/package/files/inter-tight-latin-wght-normal.woff2 \
   /tmp/fonts-inter-tight/package/files/inter-tight-cyrillic-wght-normal.woff2 \
   /home/dimass/opencode/10/public/fonts/
cp /tmp/fonts-inter/package/LICENSE /home/dimass/opencode/10/public/fonts/LICENSE-inter.txt
cp /tmp/fonts-inter-tight/package/LICENSE /home/dimass/opencode/10/public/fonts/LICENSE-inter-tight.txt
```
Имена файлов уточнить по факту в `package/files/` (могут содержать `wght`).
Шрифт НБРБ уже скачан: скопировать `/tmp/nbrb/nbrb.woff2` и `/tmp/nbrb/nbrb.ttf` в `public/fonts/`.
Если `/tmp/nbrb` пропал — скачать `https://www.nbrb.by/coinsbanknotes/byn-ico/nbrb_font.zip` и распаковать.

- [ ] **Step 2: Написать падающий guard-тест**

`tests/unit/single-stylesheet.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('single stylesheet rule', () => {
  it('links exactly one stylesheet from every view', () => {
    for (const file of walk('src/views').filter((f) => f.endsWith('.ejs'))) {
      const html = readFileSync(file, 'utf8');
      const links = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)];
      expect(links.length, file).toBeLessThanOrEqual(1);
      if (links.length) expect(links[0][0]).toContain('/css/app.css');
      expect(html).not.toMatch(/<style[\s>]/i);
    }
  });

  it('has only app.css in public/css', () => {
    expect(readdirSync('public/css')).toEqual(['app.css']);
  });
});
```

- [ ] **Step 3: Запустить и убедиться в падении**

Run: `npm test -- tests/unit/single-stylesheet.test.js`
Expected: FAIL — нет `public/css`.

- [ ] **Step 4: Написать `public/css/app.css`**

Структура файла (порядок обязателен):
1. `@font-face`: Inter (400–700, variable), Inter Tight (400–600), `nbrb` с `unicode-range: U+E901, U+42, U+59, U+4E`.
2. `:root` — все токены из `AGENTS.md` §6 + spacing 4…96, radii, shadows, status colors, `--font-body`,
   `--font-display`, `--font-byn`.
3. Reset (box-sizing, margins, `img{max-width:100%}`, `button{font:inherit}`).
4. Base: `body` — canvas, Inter 14/1.64 warm-gray; headings — Inter Tight 400 ink, трекинг; `a`; `::selection`.
5. Layout: `.container` (max 1200, padding 24), `.section` (96 gap), `.grid`, `.stack`.
6. Components: `.card` (white, 10px, hairline, 24 padding, shadow-card), `.btn` (pill, 8/16), `.btn--primary`
   (cyan, единственный filled), `.btn--ghost`, `.btn--danger` (текстовая), `.input`/`.field`/`.field__error`
   (6px, focus ring 2px cyan), `.table` (hairline, sticky optional), `.badge` + статусы, `.kpi`, `.empty-state`,
   `.skeleton` (shimmer без градиента — пульсация opacity), `.alert`.
7. `.byn` — `font-family: var(--font-byn); font-feature-settings: "liga"; speak: none;` и сброс
   `letter-spacing`/`font-style`/`font-weight`.
8. Utilities и `@media (max-width: 1024px)`, `(max-width: 768px)`.
9. `prefers-reduced-motion`: отключить анимации.

Запрещено: `@import`, `<style>`, вторые файлы, Tailwind-утилиты, градиенты (кроме скелетона-пульсации).

- [ ] **Step 5: Создать SVG-ассеты**

`logo.svg`: знак-искра + слово «Метрика» (текст в SVG не использовать — путь или `<text>` с font-family Inter Tight,
но для надёжности wordmark рендерится HTML-текстом рядом с иконкой). `favicon.svg`: 32×32, cyan-искра на прозрачном.
`og-cover.svg`: 1200×630, canvas, заголовок «Считайте деньги каналов, а не клики», подпись «Метрика».
Все — outline-стиль, без градиентов. PNG-версия для OG появится в M6.

- [ ] **Step 6: Создать `src/views/partials/head.ejs`**

`<meta charset>`, viewport, `<title><%= seo.title %></title>`, description, canonical, robots, OG/Twitter,
`<link rel="stylesheet" href="/css/app.css">`, favicon, preload двух woff2, `<%- jsonLd || '' %>`.
Ровно один stylesheet.

- [ ] **Step 7: Прогнать guard-тест**

Run: `npm test -- tests/unit/single-stylesheet.test.js`
Expected: PASS.

- [ ] **Step 8: Визуальная проверка токенов**

Создать временную `public/tokens.html`? Нет — запрещено плодить файлы вне плана. Вместо этого после Task 5
проверить лендинг в agent-browser и убедиться: canvas `#fafaf9`, карточка `#ffffff`, cyan только на CTA,
шрифты загрузились (`document.fonts.check('14px Inter')`), знак BYN отображается глифом.

- [ ] **Step 9: Коммит**

```bash
git add public src/views/partials/head.ejs tests/unit/single-stylesheet.test.js
git commit -m "feat: add seline-inspired design tokens, local fonts and stylesheet guard"
```

---

### Task 5: Публичный лендинг и SEO

**Files:**
- Create: `src/lib/seo.js`, `src/routes/public.routes.js`, `src/controllers/public.controller.js`,
  `src/views/layouts/public.ejs`, `src/views/partials/public-header.ejs`, `src/views/partials/public-footer.ejs`,
  `src/views/pages/home.ejs`, `src/views/errors/404.ejs`
- Modify: `src/app.js` (подключить роуты), `src/middleware/errors.js` (html 404)
- Test: `tests/integration/landing.test.js`

**Interfaces:**
- Consumes: `createApp`, `head.ejs`, `app.css`.
- Produces: `buildSeo({ title, description, path, imagePath, noindex })` → `{ title, description, canonical,
  ogImage, robots, jsonLd }`; маршруты `/`, `/robots.txt`, `/sitemap.xml`.

- [ ] **Step 1: Написать падающий тест лендинга**

`tests/integration/landing.test.js`:
- GET `/` → 200, `content-type` html, один `<h1>`, `lang="ru"`, title 20–60 символов, description ≤160;
- canonical `http://localhost:3000/`;
- JSON-LD парсится и содержит `"@type":"WebApplication"`;
- GET `/robots.txt` → 200, содержит `Disallow: /app` и `Disallow: /api`;
- GET `/sitemap.xml` → 200, содержит `<loc>http://localhost:3000/</loc>`;
- GET `/nope` → 404 и HTML-страница, не JSON.

- [ ] **Step 2: Запустить и убедиться в падении**

Run: `npm test -- tests/integration/landing.test.js`
Expected: FAIL — 404.

- [ ] **Step 3: Реализовать `seo.js` и `public.controller.js`**

`buildSeo`: `canonical = new URL(path, env.appUrl).toString()`; `ogImage` по умолчанию `/img/og-cover.svg`;
`jsonLd` — объект `WebApplication` (name «Метрика», applicationCategory BusinessApplication,
operatingSystem «Web», offers price 0 BYN, inLanguage ru) плюс `Organization`.
Контроллер рендерит `pages/home` с `layout: 'layouts/public'`, `seo`, `jsonLd` (сериализованный через
`JSON.stringify(...).replace(/</g, '\\u003c')`).
`head.ejs` (создан в Task 4) содержит `<script type="application/ld+json" nonce="<%= nonce %>">`, где `nonce`
приходит из `res.locals`; JSON-LD сериализуется с экранированием `<`.
`/sitemap.xml` — статический список `/`; `/robots.txt` — `text/plain`.
`errors/404.ejs` — публичный layout, заголовок «Страница не найдена», ссылка на главную и на вход.

- [ ] **Step 4: Сверстать `public.ejs`, header, footer, home**

Секции лендинга (все тексты по-русски, без вымысла):
1. Header: логотип, ссылки-якоря «Возможности», «Как считаем», «Безопасность», кнопка «Войти».
2. Hero: h1 «Считайте деньги каналов, а не клики» (одна cyan-подсветка на «деньги каналов»), подзаголовок,
   CTA «Войти в демо» + ghost «Как считаем».
3. Preview-карточка: CSS-макет дашборда (KPI CAC/LTV/ROMI, линия, bars) с подписью «Демонстрационные данные».
4. Формулы: три карточки CAC, LTV, ROMI с формулами и одним предложением смысла.
5. Возможности: 3 карточки (когорты, атрибуция, сценарии бюджета).
6. Как работает: импорт CSV → расчёт → решение; 3 шага.
7. Безопасность: 3 пункта (argon2id, шифрованные бэкапы, роли).
8. FAQ: 4 `<details>` (откуда данные, что если нет истории, кто видит, как считается LTV).
9. Footer: «Демонстрационный проект», ссылки на вход и разделы, год.
Никаких отзывов, логотипов клиентов и обещаний, которых нет в продукте.

- [ ] **Step 5: Подключить роуты и 404**

`app.js`: `app.use('/', publicRoutes)`; `app.use((req,res) => ...)` — для `/api/*` JSON 404,
иначе `res.status(404).render('errors/404', { layout: 'layouts/public', seo: buildSeo({...,noindex:true}) })`.
`notFound` должен работать без БД.

- [ ] **Step 6: Прогнать тест, проверить в браузере**

Run: `npm test -- tests/integration/landing.test.js`
Expected: PASS.
Затем `npm run dev`, `agent-browser open http://localhost:3000`,
`agent-browser screenshot /tmp/landing.png`, проверить шрифты (`document.fonts.check`), отсутствие ошибок
(`agent-browser console`), мобильную ширину 390×844.

- [ ] **Step 7: Коммит**

```bash
git add src/lib/seo.js src/routes/public.routes.js src/controllers/public.controller.js \
  src/views tests/integration/landing.test.js src/app.js src/middleware/errors.js
git commit -m "feat: add public landing page with seo metadata and sitemap"
```

---

### Task 6: Авторизация, сессии, CSRF, RBAC-примитивы

**Files:**
- Create: `src/config/permissions.js`, `src/lib/session.js`, `src/lib/csrf.js`, `src/middleware/auth.js`,
  `src/middleware/csrf.js`, `src/middleware/rateLimit.js`, `src/services/auth.service.js`,
  `src/services/audit.service.js`, `src/repositories/users.repo.js`, `src/repositories/audit.repo.js`,
  `src/controllers/auth.controller.js`, `src/routes/auth.routes.js`, `src/views/pages/login.ejs`,
  `src/views/errors/403.ejs`
- Modify: `src/app.js` (session, csrf, locals), `src/views/partials/head.ejs` (nonce для JSON-LD)
- Create: `src/routes/app.routes.js` (минимальный защищённый `/app` + `/app/dashboard`-заглушка; Task 7 заменит обработчик)
- Test: `tests/integration/auth.test.js`, `tests/unit/permissions.test.js`

**Interfaces:**
- Consumes: `pool`, `users`, `audit_log`, `env`.
- Produces: `can(role, permission)`; `requireAuth`, `requirePermission(permission)`; `issueCsrfToken(req)`,
  `verifyCsrfToken(req, token)`; `login(email, password, ip)` → `{ id, email, fullName, role }`; сессия
  `req.session.user`; locals `currentUser`, `can`, `csrfToken`.

- [ ] **Step 1: Написать падающие тесты RBAC и авторизации**

`tests/unit/permissions.test.js`:
```js
expect(can('admin', 'users:manage')).toBe(true);
expect(can('analyst', 'users:manage')).toBe(false);
expect(can('analyst', 'import:run')).toBe(true);
expect(can('viewer', 'channels:manage')).toBe(false);
expect(can('viewer', 'dashboard:view')).toBe(true);
```
`tests/integration/auth.test.js` (после `resetTestDatabase(); await seed()`; `agent = request.agent(app)`):
1. GET `/login` 200 и содержит `name="_csrf"`;
2. POST `/login` без CSRF → 403, в `sessions` нет строки;
3. POST с CSRF и верным паролем → 302 `/app/dashboard`, cookie `metrika.sid`;
4. неверный пароль → 401, текст «Неверный email или пароль», нет утечки «пользователь не найден»;
5. неактивный пользователь (admin деактивирует analyst в БД) → 401 с тем же сообщением;
6. `next=https://evil.example` → 302 на `/app/dashboard`;
7. `next=/app/admin/users` для admin → 302 туда;
8. logout POST с CSRF → 302 `/login`, последующий `/app/dashboard` → 302 `/login?next=...`;
9. 6-я попытка входа за 15 минут → 429.

Хелпер `tests/helpers/csrf.js`: `getCsrf(agent)` — GET страницы, regex `name="_csrf" value="([^"]+)"`.
Хелпер `tests/helpers/app.js`: `makeApp()` — `createApp({ db: pool })`, `loginAs(agent, email)`.

- [ ] **Step 2: Запустить и убедиться в падении**

Run: `npm test -- tests/integration/auth.test.js tests/unit/permissions.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать матрицу прав и middleware**

`permissions.js`:
```js
const VIEWER = ['dashboard:view','channels:view','campaigns:view','cohorts:view','attribution:view',
  'scenarios:view','alerts:view','goals:view','export'];
const ANALYST = [...VIEWER, 'channels:manage','campaigns:manage','goals:manage','import:run',
  'scenarios:manage','alerts:manage'];
const ADMIN = [...ANALYST, 'users:manage','audit:view'];
export const PERMISSIONS = { viewer: VIEWER, analyst: ANALYST, admin: ADMIN };
export function can(role, permission) { return (PERMISSIONS[role] ?? []).includes(permission); }
```
`requireAuth`: для `/api/*` → 401 JSON; иначе `redirect('/login?next=' + encodeURIComponent(req.originalUrl))`.
`requirePermission(perm)`: 403 → render `errors/403` с публичным layout и текстом «Недостаточно прав»
(шаблон создаётся в этой задаче).

- [ ] **Step 4: Реализовать сессию, CSRF, argon2 и вход**

`session.js`: `PgStore({ pool, tableName: 'sessions' })`; cookie `metrika.sid`, `maxAge: 8*3600*1000`.
`csrf.js`: `issueCsrfToken(req)` — если нет `req.session.csrfToken`, `randomBytes(32).toString('base64url')`;
`verifyCsrfToken` — `timingSafeEqual` по буферам равной длины, иначе false.
`csrf.js` middleware: для GET/HEAD/OPTIONS — выставить токен в locals; для остальных — взять `x-csrf-token`
или `_csrf`, при ошибке `ForbiddenError('CSRF token mismatch')`.
`auth.service.js`: нормализация email (`trim().toLowerCase()`), `findByEmail`, `verify(hash, password)`;
неактивный → `UnauthorizedError('Неверный email или пароль')`; успех → обновить `last_login_at`.
`audit.service.js`: `record({ userId, action, entity, entityId, payload, ip })`.
`auth.controller.js`: GET login (если уже вошёл → `/app/dashboard`); POST login — Zod, `login()`,
`req.session.regenerate`, установить `req.session.user`, аудит `auth.login`, redirect по safe `next`;
POST logout — destroy, clearCookie, аудит `auth.logout`.
`app.routes.js` (временный, до Task 7): `GET /app` → redirect `/app/dashboard`, `GET /app/dashboard` —
`requireAuth` + plain text «Дашборд»; это минимальный seam, чтобы проверить guard, Task 7 заменит на EJS.
`createApp({ db, sessionStore })`: если `sessionStore` не передан — `PgStore`; в тестах передаётся
`new session.MemoryStore()`; обновить `tests/integration/health.test.js`, чтобы он передавал memory store.
`rateLimit.js`: `rateLimit({ windowMs: 15*60*1000, limit: 5, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => `${req.ip}:${(req.body?.email ?? '').toLowerCase()}`, handler: 429 render login })`.
В `app.js` порядок: session → csrf → locals → routes.

- [ ] **Step 5: Сверстать `login.ejs`**

Двухколоночная карточка: слева форма (email, пароль, скрытый `_csrf`, ошибка, submit «Войти»), справа — короткий
текст о демо и три демо-аккаунта с ролями (без пароля в UI; пароль в README). Ссылка «На главную». `autocomplete`
корректный, `aria-describedby` для ошибок, focus на email.

- [ ] **Step 6: Прогнать тесты**

Run: `npm test -- tests/integration/auth.test.js tests/unit/permissions.test.js`
Expected: все passed. Если rate-limit мешает другим тестам — сбрасывать store между тестами
(`loginLimiter.resetKey(...)`) или создавать приложение с `skipRateLimit` для тестов; решение зафиксировать в коде.

- [ ] **Step 7: Ручная проверка в браузере**

Войти admin/analyst/viewer, проверить cookie `HttpOnly`, редиректы, ошибку, выход, консоль.

- [ ] **Step 8: Коммит**

```bash
git add src/config/permissions.js src/lib/session.js src/lib/csrf.js src/middleware src/services \
  src/repositories src/controllers/auth.controller.js src/routes/auth.routes.js src/views/pages/login.ejs \
  src/app.js tests
git commit -m "feat: add session auth with csrf protection and role-based access"
```

---

### Task 7: Каркас приложения, data anchor, RBAC-экраны, ошибки

**Files:**
- Create: `src/repositories/reference.repo.js`, `src/controllers/app.controller.js`,
  `src/controllers/admin.controller.js`, `src/views/layouts/app.ejs`, `src/views/partials/sidebar.ejs`,
  `src/views/partials/topbar.ejs`, `src/views/pages/dashboard.ejs`,
  `src/views/pages/admin-users.ejs`, `src/views/pages/coming-soon.ejs`, `src/views/errors/500.ejs`
- Modify: `src/routes/app.routes.js` (заменить заглушку из Task 6), `src/app.js`, `src/middleware/errors.js`,
  `src/views/errors/404.ejs` (ссылка на дашборд при входе), `src/views/errors/403.ejs` (то же)
- Test: `tests/integration/rbac.test.js`

**Interfaces:**
- Consumes: `requireAuth`, `requirePermission`, `can`, `pool`.
- Produces: `getDataAnchor()` → `Date` (YYYY-MM-DD строка), `formatAnchorRu(date)`; локальные переменные
  шаблонов `currentUser`, `can`, `activeNav`, `dataAnchor`, `csrfToken`.

- [ ] **Step 1: Написать падающий тест каркаса**

`tests/integration/rbac.test.js` (сид выполнен):
1. без входа GET `/app/dashboard` → 302 `/login?next=%2Fapp%2Fdashboard`;
2. viewer: 200 dashboard, в HTML нет ссылки `/app/admin/users`;
3. viewer GET `/app/admin/users` → 403;
4. analyst GET `/app/admin/users` → 403, но `/app/import` → 200 (заглушка);
5. admin GET `/app/admin/users` → 200, видит 3 пользователя и роли;
6. dashboard содержит «Данные по» и дату anchor;
7. пустая статистика (`TRUNCATE daily_stats, touchpoints, orders, customers RESTART IDENTITY CASCADE`, пользователи
   остаются): dashboard → 200, текст «Данных пока нет», anchor = сегодня Minsk; KPI показывают «—», а не `NaN`;
8. GET `/app/unknown` → 404 HTML.

- [ ] **Step 2: Запустить и убедиться в падении**

Run: `npm test -- tests/integration/rbac.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать `reference.repo.js`, контроллеры и маршруты**

`getDataAnchor()`: `SELECT max(stat_date)::text AS d FROM daily_stats`; если null → `minskToday()`.
Dashboard view-model на M1: `{ dataAnchor, kpis: null, isEmpty: true }` — цифры появятся в M3; шаблон показывает
четыре KPI с «—» и пустое состояние. Не выдумывать числа.
`admin.controller.js`: список пользователей `SELECT id, email, full_name, role, is_active, last_login_at`.
Маршруты: `/app` redirect, `/app/dashboard`, `/app/admin/users` (`users:manage`), заглушки для остальных разделов
(`channels`, `campaigns`, `cohorts`, `attribution`, `scenarios`, `alerts`, `goals`, `profile` — только `requireAuth`;
`import` — `import:run`; `audit` — `audit:view`) — все за `requireAuth`.
Заглушка честная: «Раздел появится на следующем этапе» + ссылка на дашборд, без фейковых данных.

- [ ] **Step 4: Сверстать `app.ejs`, sidebar, topbar**

Сайдбар: логотип, группы «Аналитика» (Дашборд, Каналы, Кампании, Когорты, Атрибуция), «Решения»
(Сценарии, Алерты, Цели), «Данные» (Импорт, Аудит), «Администрирование» (Пользователи — только admin).
Активный пункт: cyan-полоса слева + ink-текст. Низ: имя, роль, «Выйти».
Topbar: заголовок страницы, «Данные по 20.11.2026», переключатель периода (пока неактивный select с 30/90/180),
аватар-инициалы.
Контент: max 1200, отступ 32.
Мобильный: сайдбар в `<details>`/checkbox без JS, либо скрыт с кнопкой (простой CSS-характер).

- [ ] **Step 5: Сверстать dashboard и ошибки**

Dashboard: 4 KPI-карточки (Расход, Новые клиенты, CAC, ROMI) со значением «—» и подсказкой; блок «Что дальше»
с шагами (импорт/сид) и ссылкой. Пустое состояние с иконкой-контуром.
403/404/500: публичный layout, заголовок, короткое объяснение, ссылка «На главную»/«В дашборд», код ошибки.
500 создаётся здесь; 403/404 созданы в Task 5–6 и дополняются ссылкой на дашборд для вошедших.

- [ ] **Step 6: Прогнать тесты и проверить в браузере**

Run: `npm test -- tests/integration/rbac.test.js`
Expected: PASS.
Браузер: 3 роли, мобильная ширина, консоль.

- [ ] **Step 7: Коммит**

```bash
git add src/repositories/reference.repo.js src/routes/app.routes.js src/controllers/app.controller.js \
  src/controllers/admin.controller.js src/views src/middleware/errors.js src/app.js \
  tests/integration/rbac.test.js tests/helpers
git commit -m "feat: add authenticated app shell with data anchor and rbac screens"
```

---

### Task 8: E2E-смоук, README, отчёт этапа

**Files:**
- Create: `README.md`, `docs/screenshots/m1/*.png`, `docs/screenshots/m1/README.md`, `IMPROVEMENTS.md`
- Modify: `.gitignore` при необходимости

**Interfaces:** не добавляет кода.

- [ ] **Step 1: Запустить полный прогон**

```bash
npm test
npm run migrate
npm run seed
npm run dev
```
Expected: все тесты зелёные, сервер на 3000.

- [ ] **Step 2: E2E через agent-browser (каждый пункт — реальный клик)**

1. `/` → проверить h1, CTA, скриншот desktop и 390×844.
2. «Войти» → форма; неверный пароль → сообщение; верный admin → дашборд.
3. Проверить «Данные по …», KPI «—», пустое состояние, отсутствие ошибок в консоли.
4. `/app/admin/users` → 3 пользователя; выйти.
5. Войти analyst → нет пункта «Пользователи»; прямой `/app/admin/users` → 403.
6. Войти viewer → нет «Импорт»; прямой `/app/import` → 403.
7. Проверить 404.
8. `agent-browser console` после каждого экрана — ноль ошибок.

Команды фиксировать в `docs/screenshots/m1/README.md` (список шагов и что проверено).

- [ ] **Step 3: Скриншоты**

Сохранить в `docs/screenshots/m1/`: `landing-desktop.png`, `landing-mobile.png`, `login.png`,
`dashboard-admin.png`, `admin-users.png`, `forbidden-viewer.png`.

- [ ] **Step 4: Написать `README.md`**

Секции: что это, стек, скриншот, быстрый старт (Node 24, PostgreSQL 18, `createdb`, `.env`, migrate, seed, dev),
демо-аккаунты и пароль, скрипты, структура, ссылки на спеки, статус этапов (M1 готов, дальше по дорожной карте),
лицензия данных (демо, вымышленные).

- [ ] **Step 5: Записать улучшения**

`IMPROVEMENTS.md`: OG-картинка в PNG (сейчас SVG), интеграционные тесты последовательные (fileParallelism false),
заглушки разделов до M2–M5.

- [ ] **Step 6: Финальный коммит этапа**

```bash
git add README.md IMPROVEMENTS.md docs/screenshots/m1
git commit -m "docs: add m1 readme, screenshots and verification log"
```

---

## Приёмка M1

- [ ] `npm test` — зелёный.
- [ ] `npm run migrate && npm run seed && npm run dev` на чистой БД.
- [ ] Вход тремя ролями, RBAC на прямых URL, безопасный `next`, CSRF, rate-limit.
- [ ] Лендинг: title/description/canonical/OG/JSON-LD/robots/sitemap, один `<h1>`.
- [ ] Ровно один stylesheet, шрифты локальные, знак BYN глифом.
- [ ] Data anchor отображается; пустая БД не ломает дашборд.
- [ ] E2E-лог и скриншоты в `docs/screenshots/m1/`.
- [ ] Ноль ошибок в консоли, мобильная ширина не ломается.
- [ ] `IMPROVEMENTS.md` обновлён.
