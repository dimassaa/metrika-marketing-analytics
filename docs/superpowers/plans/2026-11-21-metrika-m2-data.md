# M2 «Данные и администрирование» — план реализации

> **Для агентов:** обязательный навык — `superpowers:subagent-driven-development` (рекомендуется) или
> `superpowers:executing-plans`. Выполнять задачи по порядку, отмечать шаги `- [x]`, коммитить в конце задачи.

**Цель:** превратить каркас M1 в рабочую систему ввода и администрирования данных: CRUD каналов, кампаний,
целей и пользователей, потоковый CSV-импорт 4 типов с атомарной транзакцией и отчётом ошибок, CSV-экспорт
с учётом фильтров, хранение медиаресурсов (`BYTEA`) с отдачей по `/media/:id`, полный журнал аудита и E2E-проверка.

**Архитектура:** Express MVC (`routes → controllers → services → repositories → EJS`), серверный рендер форм и таблиц,
валидация Zod на сервере и HTML5 на клиенте, сессии и CSRF double-submit из M1, RBAC по матрице прав, транзакции
через `withTransaction(fn)`. React-острова на этом этапе не используются (появляются в M4).

**Стек:** Node 24 LTS (локально 26), Express 5, EJS 3 + `express-ejs-layouts`, PostgreSQL 18 (`pg`), Zod 4, pino,
`@node-rs/argon2`, `express-session` + `connect-pg-simple`, `helmet`, `express-rate-limit`, `multer` (новый, только для
multipart-загрузки CSV и медиа в память с жёстким лимитом размера), Vitest + Supertest, `agent-browser`.

**Спеки:** `docs/superpowers/specs/2026-11-21-marketing-analytics-design.md` (§5–§10),
`docs/superpowers/specs/2026-11-21-metrics-spec.md` (§8–§9),
`docs/superpowers/specs/2026-11-21-assignment-traceability.md`.

## Global Constraints

- Только JavaScript, ESM, без TypeScript; импорты с `.js`.
- Один стилевой файл `public/css/app.css`; никаких CSS-фреймворков, `<style>`, вторых `.css`.
- Весь UI-текст русский; код и коммиты английские.
- Деньги — целые копейки (`BIGINT`), вывод в BYN с запятой и знаком НБРБ (`<span class="byn">BYN</span>`); запрещены `$`, `₽`, `руб.`.
- Даты: `timestamptz` UTC, календарные `date`; отображение Europe/Minsk; «сегодня» = data anchor
  (`MAX(daily_stats.stat_date)`), fallback — текущая дата Minsk.
- PostgreSQL 18, FK/CHECK/UNIQUE, никаких ORM. Удаление истории клиентов и заказов запрещено (`ON DELETE RESTRICT`).
- RBAC на сервере, CSRF на всех небезопасных методах (для `multipart/form-data` — через заголовок `X-CSRF-Token` или query/поле после `multer`), пароли argon2id (минимум 10 символов).
- Сессии: httpOnly, sameSite=lax, secure в production, TTL 8 часов, regenerate при входе.
- Порты: приложение 3000; БД `metrika_dev` и `metrika_test` на localhost.
- Никаких CDN; шрифты и изображения локальные.
- Коммит в конце каждой задачи от имени владельца репозитория (git config настроен).

### Фактические интерфейсы M1 (доступные к началу M2)

**Уже в репозитории (`src/` и `db/` после Task 1–2 M1):**
- `src/config/env.js`: `env` (`{ nodeEnv, port, databaseUrl, testDatabaseUrl, sessionSecret, appUrl, cookieSecure, logLevel }`), `parseEnv(source)`.
- `src/lib/db.js`: `pool`, `query(text, params)`, `withTransaction(fn)` (`fn(client)` в `BEGIN/COMMIT/ROLLBACK`), `pingDb()`, `closeDb()`.
- `src/lib/logger.js`: `logger` (pino, silent в `test`).
- `src/lib/errors.js`: `AppError`, `ValidationError` (400), `UnauthorizedError` (401), `ForbiddenError` (403), `NotFoundError` (404).
- `src/middleware/requestId.js`: `requestId`.
- `src/middleware/errors.js`: `notFound`, `errorHandler` (JSON для `/api/*`, HTML/text для страниц).
- `db/migrate.js` + `db/migrations/001_init.sql`: 15 таблиц (`users`, `sessions`, `channels`, `campaigns`, `daily_stats`, `customers`, `touchpoints`, `orders`, `goals`, `alerts`, `scenarios`, `audit_log`, `import_batches`, `media_assets`, `schema_migrations`), триггеры `set_updated_at()`.
- `tests/helpers/db.js`: `getTestPool()`, `resetTestDatabase()`, `closeTestPool()`.

**Интерфейсы M1 из Task 3–7 (потребляются в M2 без переименования):**
- `src/app.js`: `createApp({ db, sessionStore })`.
- `src/lib/dates.js`: `minskToday()`, `minskYesterday()`, `toDateOnly(date)`, `addDays(date, n)`, `startOfMonth(date)`, `formatDateRu(date)`, `isoWeekStart(date)`.
- `src/lib/seo.js`: `buildSeo({ title, description, path, imagePath, noindex })`.
- `src/lib/csrf.js` и `src/middleware/csrf.js`: `issueCsrfToken(req)`, `verifyCsrfToken(req, token)`, middleware проверки `_csrf` / `x-csrf-token`.
- `src/config/permissions.js`: `PERMISSIONS`, `can(role, permission)` (`channels:view`, `channels:manage`, `campaigns:view`, `campaigns:manage`, `goals:view`, `goals:manage`, `import:run`, `export`, `users:manage`, `audit:view`).
- `src/middleware/auth.js`: `requireAuth`, `requirePermission(permission)`.
- `src/middleware/rateLimit.js`: `loginLimiter` (в M2 дополняется `importLimiter`).
- `src/services/audit.service.js` + `src/repositories/audit.repo.js`: `record({ userId, action, entity, entityId, payload, ip })`.
- `src/repositories/users.repo.js`: `findByEmail(email)`, `findById(id)` (в M2 расширяется методами администрирования).
- `src/repositories/reference.repo.js`: `getDataAnchor()`, `formatAnchorRu(date)`.
- `db/seed/seed.js`: `seed({ anchorDate })`.
- `tests/helpers/csrf.js`: `getCsrf(agent)`; `tests/helpers/app.js`: `makeApp()`, `loginAs(agent, email, password)`.
- Layouts и partials: `src/views/layouts/app.ejs`, `src/views/layouts/public.ejs`, `src/views/partials/{head,sidebar,topbar}.ejs`, `src/views/errors/{403,404,500}.ejs`.
- CSS-классы из `public/css/app.css`: `.container`, `.card`, `.btn`, `.btn--primary`, `.btn--ghost`, `.btn--danger`, `.input`, `.field`, `.field__error`, `.table`, `.badge`, `.badge--healthy|watch|risk`, `.kpi`, `.skeleton`, `.empty-state`, `.byn`, `.u-hidden`, `.stack`, `.grid`, `.alert`.

### Новая зависимость M2 и обоснование

- **`multer@^2.0.0`** — единственная новая runtime-зависимость. Нужна для разбора `multipart/form-data` в памяти (`multer.memoryStorage()`) с жёстким потоковым отсечением по `limits.fileSize` (2 МБ) в T5 (CSV-импорт) и T7 (загрузка `media_assets`). Чистый JS, не тянет TypeScript и CSS.
- **CSV-парсер (`csv-parse`) НЕ устанавливаем:** формат в метрик-спеке §8 жёстко фиксирован (UTF-8, опциональный BOM, разделитель `;`, 4 известные схемы без многострочных текстовых полей). Собственный парсер `src/lib/csv.js` на 45 строк с поддержкой BOM, кавычек `""` и подсчётом номеров строк проще, прозрачнее на защите и не несёт внешних зависимостей.

## Review Focus

1. **Частичная запись при импорте (import partial writes).** Если в CSV на 100 строк 11 строк битые (>10%) или внутри транзакции случается ошибка FK, в БД не должна остаться ни одна строка из этого файла, а в `import_batches` фиксируется отчёт с `rows_ok = 0` и списком ошибок. Проверяется в `tests/integration/import.test.js` (Task 5).
2. **Дубликаты ключей (duplicate keys).** Повторный код канала/кампании, дубль email без учёта регистра (`Admin@metrika.by`), пересекающийся период цели или повторный импорт тех же строк (`daily_stats` обновляет, `customers`/`touchpoints`/`orders` пропускают как дубли) не должны ронять сервер с 500 — только 400/409 или штатный `skipped` в отчёте. Проверяется в `channels.test.js` (T1), `campaigns.test.js` (T2), `users-admin.test.js` (T3), `goals.test.js` (T4), `import.test.js` (T5).
3. **Эскалация привилегий и самоблокировка (role escalation & self-lockout).** `viewer` не может вызвать никакой POST/PATCH/DELETE (403); `analyst` не может управлять пользователями, читать `/app/audit` или загружать глобальную OG-обложку (403); `admin` не может деактивировать самого себя или понизить собственную роль. Проверяется в `users-admin.test.js` (T3) и `tests/e2e/m2.e2e.js` (T8).
4. **Превышение лимитов загрузки (oversized upload).** Файл > 2 МБ или CSV > 10 000 строк отклоняется с 413/400 до начала транзакции БД; файл с неверным MIME/сигнатурой (`image/svg+xml` со скриптом или `.exe` под видом `.png`) отклоняется в T7. Проверяется в `import.test.js` (T5) и `media.test.js` (T7).
5. **XSS через названия каналов, кампаний и имена файлов.** Попытка сохранить `<script>alert(1)</script>` в `channels.name`, `campaigns.name`, `users.full_name` или `import_batches.filename` рендерится в EJS строго через `<%= %>` как экранированный текст `&lt;script&gt;`, не исполняясь в браузере. Проверяется в `channels.test.js` (T1) и в браузерной консоли `agent-browser` (T8).

---

## Карта файлов M2

```
src/
  lib/
    money.js             (парсинг BYN -> cents, форматирование cents -> "1 234,56")
    csv.js               (парсинг и сериализация CSV с ';', BOM, лимит строк)
  validators/
    channels.schema.js
    campaigns.schema.js
    users.schema.js
    goals.schema.js
    import.schema.js
  repositories/
    channels.repo.js
    campaigns.repo.js
    users.repo.js        (расширение M1: create, updateRole, setActive, updatePasswordHash)
    goals.repo.js
    import.repo.js
    export.repo.js
    media.repo.js
    audit.repo.js        (расширение M1: listWithFilters, countWithFilters)
  services/
    channels.service.js
    campaigns.service.js
    users.service.js
    goals.service.js
    import.service.js
    export.service.js
    media.service.js
    audit.service.js     (расширение M1: listAuditLog)
  controllers/
    channels.controller.js
    campaigns.controller.js
    admin.controller.js  (расширение M1: CRUD пользователей + журнал аудита + медиа)
    goals.controller.js
    import.controller.js
    export.controller.js
    media.controller.js
  routes/
    app.routes.js        (подключение всех страниц и POST-действий M2)
    public.routes.js     (добавление GET /media/:id)
  views/pages/
    channels.ejs
    channel-detail.ejs
    campaigns.ejs
    goals.ejs
    import.ejs
    import-batch.ejs
    audit.ejs
    admin-users.ejs      (расширение M1: формы создания, смены роли, сброса пароля, блокировки)
    profile.ejs          (смена собственного пароля и загрузка аватара)
tests/
  unit/
    money-csv.test.js
    import-validators.test.js
  integration/
    channels.test.js
    campaigns.test.js
    users-admin.test.js
    goals.test.js
    import.test.js
    export.test.js
    media.test.js
docs/screenshots/m2/
```

---

### Task 1: Денежные/форматные хелперы и управление каналами (список, создание, редактирование, архивирование)

**Решение по архивированию канала:** канал **не удаляется физически** (в БД `campaigns.channel_id` и `customers.first_channel_id` имеют `ON DELETE RESTRICT`), а переводится в `is_active = false` (архив) и может быть реактивирован. **Нельзя архивировать канал, у которого есть кампании со статусом `'active'`** — сервис выбрасывает `ValidationError('Нельзя архивировать канал с активными кампаниями: сначала остановите или завершите их')`. Исторические данные архивного канала остаются в отчётах, но при создании новой кампании архивный канал выбрать нельзя.

**Маршруты:**
- `GET /app/channels` (`requireAuth`, `requirePermission('channels:view')`) — список каналов с фильтром `status=all|active|archived` и `kind=all|paid|owned|earned`.
- `GET /app/channels/:id` (`requireAuth`, `requirePermission('channels:view')`) — карточка канала (паспорт канала, целевые CAC/ROMI, список его кампаний и форма редактирования для `channels:manage`; графики метрик добавятся в M4).
- `POST /app/channels` (`requireAuth`, `requirePermission('channels:manage')`) — создание канала.
- `POST /app/channels/:id` (`requireAuth`, `requirePermission('channels:manage')`) — редактирование названия, типа, целевого CAC (BYN) и целевого ROMI (%).
- `POST /app/channels/:id/archive` (`requireAuth`, `requirePermission('channels:manage')`) — архивирование/реактивация.

**Files:**
- Create: `src/lib/money.js`, `src/lib/format.js`, `src/validators/channels.schema.js`, `src/repositories/channels.repo.js`, `src/services/channels.service.js`, `src/controllers/channels.controller.js`, `src/views/pages/channels.ejs`, `src/views/pages/channel-detail.ejs`
- Modify: `src/routes/app.routes.js`
- Test: `tests/unit/money-csv.test.js`, `tests/integration/channels.test.js`

**Interfaces:**
- Consumes: `query`, `withTransaction`, `ValidationError`, `NotFoundError`, `requireAuth`, `requirePermission`, `auditService.record`.
- Produces:
  - `src/lib/money.js`: `parseBynToCents(input)` → `bigint` (принимает `'1 234,56'`, `'1234.56'`, `'50'`, бросает `ValidationError` на отрицательных, пустых, `NaN`, > 2 знаков после запятой); `formatCentsToByn(cents)` → `'1 234,56'` (`null` → `'—'`).
  - `src/lib/format.js`: `formatPercent(value, { signed })` (`+12,4%`, `−8,1%` с типографским минусом `U+2212`, `null` → `'—'`), `formatInteger(n)` (`12 345`).
  - `channelsRepo`: `listChannels({ onlyActive, kind })`, `findChannelById(id)`, `findChannelByCode(code)`, `createChannel({ code, name, kind, targetCacCents, targetRomiPct })`, `updateChannel(id, { name, kind, targetCacCents, targetRomiPct })`, `setChannelActive(id, isActive)`, `countActiveCampaigns(channelId)`.
  - `channelsService`: `listChannelsForView(filters)`, `getChannelDetail(id)`, `createChannel(input, actor)`, `updateChannel(id, input, actor)`, `toggleChannelArchive(id, isActive, actor)`.

- [ ] **Step 1: Написать падающий юнит-тест `parseBynToCents` и форматирования**

`tests/unit/money-csv.test.js`:
- `parseBynToCents('1 234,56') === 123456n`, `parseBynToCents('45.5') === 4550n`, `parseBynToCents('0') === 0n`;
- `parseBynToCents('-10')`, `parseBynToCents('12,345')`, `parseBynToCents('abc')` бросают `ValidationError`;
- `formatCentsToByn(123456n) === '1 234,56'`, `formatCentsToByn(0n) === '0,00'`, `formatCentsToByn(null) === '—'`;
- `formatPercent(-8.1, { signed: true }) === '−8,1%'` (символ `\u2212`).

- [ ] **Step 2: Запустить юнит-тест и убедиться в падении**

Run: `npx vitest run tests/unit/money-csv.test.js`
Expected: FAIL — `Cannot find module '../../src/lib/money.js'`.

- [ ] **Step 3: Реализовать `src/lib/money.js` и `src/lib/format.js` и добиться зелёного юнит-теста**

Никакого `parseFloat` при переводе в копейки: разбирать строку регулярным выражением `/^(\d+)(?:[.,](\d{1,2}))?$/` после удаления пробелов, неразрывных пробелов и суффикса `BYN`, собирать `BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'))`.

- [ ] **Step 4: Написать падающий интеграционный тест каналов**

`tests/integration/channels.test.js` (после `resetTestDatabase(); await seed()`):
1. `GET /app/channels` под `viewer` → 200, содержит 8 демо-каналов и суммы в формате `45,00` + `<span class="byn">BYN</span>`, форма создания скрыта;
2. `POST /app/channels` под `viewer` → 403;
3. `POST /app/channels` под `analyst` с `{ code: 'viber_ads', name: 'Viber Ads', kind: 'paid', targetCacByn: '38,50', targetRomiPct: '115' }` → 302 на `/app/channels`, в БД `target_cac_cents = 3850`, в `audit_log` запись `action = 'channel.create'`;
4. `POST /app/channels` с дублирующимся `code: 'instagram'` или невалидным `code: 'Bad-Code!'` → 400, страница списка с текстом ошибки;
5. `POST /app/channels/:id/archive` для канала `instagram` (у которого есть активные кампании) → 400 с сообщением про активные кампании, `is_active` остаётся `true`;
6. после перевода всех кампаний канала в `paused`/`finished` — `POST /app/channels/:id/archive` → 302, `is_active = false`, запись `channel.archive` в `audit_log`;
7. XSS-проверка: создание канала с `name: '<script>alert(1)</script>'` сохраняет строку и на `GET /app/channels` отдаёт `&lt;script&gt;alert(1)&lt;/script&gt;`.

- [ ] **Step 5: Запустить интеграционный тест и убедиться в падении**

Run: `npx vitest run tests/integration/channels.test.js`
Expected: FAIL.

- [ ] **Step 6: Реализовать схему, репозиторий, сервис, контроллер и шаблоны `channels.ejs` / `channel-detail.ejs`**

В `channels.repo.js` список каналов возвращать одним SQL-запросом с `COUNT(cp.id)` всего и активных кампаний (`LEFT JOIN campaigns cp ON cp.channel_id = c.id GROUP BY c.id`), чтобы избежать N+1. При конфликте `UNIQUE(code)` (код PG `23505`) сервис бросает `ValidationError('Канал с таким кодом уже существует')`.

- [ ] **Step 7: Прогнать тесты и закоммитить**

Run: `npx vitest run tests/unit/money-csv.test.js tests/integration/channels.test.js`
Expected: PASS.
Commit: `feat: add channels management with money formatting and archive guards`

---

### Task 2: Управление кампаниями (CRUD, фильтры, привязка к каналу, защита от удаления с данными)

**Решение по удалению кампании:** хотя в схеме `daily_stats.campaign_id` имеет `ON DELETE CASCADE`, согласно `AGENTS.md` §2 и дорожной карте M2 («запрет удаления с данными») сервис `campaignsService.deleteCampaign(id, actor)` **разрешает физическое удаление только пустой ошибочно созданной кампании**, у которой 0 строк в `daily_stats`, 0 в `orders`, 0 в `touchpoints` и 0 в `customers`. Если есть хотя бы одна связанная запись, сервис бросает `ValidationError('Нельзя удалить кампанию со статистикой или заказами — переведите её в статус «Завершена»')`.

**Маршруты:**
- `GET /app/campaigns` (`requireAuth`, `requirePermission('campaigns:view')`) — список кампаний с фильтрами `channelId`, `status` (`active|paused|finished`), `q` (поиск по названию/коду) и итоговыми суммами бюджета и расхода за всё время.
- `POST /app/campaigns` (`requireAuth`, `requirePermission('campaigns:manage')`) — создание кампании (привязка к активному каналу).
- `POST /app/campaigns/:id` (`requireAuth`, `requirePermission('campaigns:manage')`) — редактирование названия, статуса, дат `started_on`/`ended_on` и бюджета (`budgetByn`).
- `POST /app/campaigns/:id/delete` (`requireAuth`, `requirePermission('campaigns:manage')`) — удаление пустой кампании.

**Files:**
- Create: `src/validators/campaigns.schema.js`, `src/repositories/campaigns.repo.js`, `src/services/campaigns.service.js`, `src/controllers/campaigns.controller.js`, `src/views/pages/campaigns.ejs`
- Modify: `src/routes/app.routes.js`, `src/views/pages/channel-detail.ejs` (таблица кампаний канала и быстрая форма добавления)
- Test: `tests/integration/campaigns.test.js`

**Interfaces:**
- Consumes: `query`, `withTransaction`, `parseBynToCents`, `formatCentsToByn`, `channelsRepo.findChannelById`, `auditService.record`.
- Produces:
  - `campaignsRepo`: `listCampaigns({ channelId, status, search })` (с `SUM(ds.spend_cents)` и `COUNT(ds.id)`), `findCampaignById(id)`, `findCampaignByCode(code)`, `createCampaign({ channelId, code, name, status, startedOn, endedOn, budgetCents })`, `updateCampaign(id, fields)`, `getCampaignUsageCounts(id)` → `{ statsCount, ordersCount, touchpointsCount, customersCount }`, `deleteCampaignById(id)`.
  - `campaignsService`: `listCampaignsForView(filters)`, `createCampaign(input, actor)`, `updateCampaign(id, input, actor)`, `deleteCampaign(id, actor)`.

- [ ] **Step 1: Написать падающий интеграционный тест кампаний**

`tests/integration/campaigns.test.js`:
1. `GET /app/campaigns?status=active` → 200, возвращает только активные кампании; фильтр `channelId` оставляет только 4 кампании выбранного канала;
2. `POST /app/campaigns` под `analyst` с валидными данными и `budgetByn: '5 000,00'` → 302, в БД `budget_cents = 500000`, запись в `audit_log` `campaign.create`;
3. `POST /app/campaigns` с `endedOn < startedOn` или привязкой к архивному каналу → 400 `ValidationError`;
4. `POST /app/campaigns/:id/delete` для сидированной кампании (есть `daily_stats` и `orders`) → 400, кампания остаётся в БД;
5. `POST /app/campaigns/:id/delete` для только что созданной пустой кампании → 302, кампания удалена, в `audit_log` запись `campaign.delete`;
6. `POST /app/campaigns` под `viewer` → 403.

- [ ] **Step 2: Запустить тест и убедиться в падении**

Run: `npx vitest run tests/integration/campaigns.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать валидатор, репозиторий, сервис, контроллер и `campaigns.ejs`**

Проверка дат в Zod: `.refine(d => !d.endedOn || d.endedOn >= d.startedOn, 'Дата окончания не может быть раньше даты старта')`. Бюджет вводится в BYN, хранится в `budget_cents`.

- [ ] **Step 4: Прогнать тесты и закоммитить**

Run: `npx vitest run tests/integration/campaigns.test.js`
Expected: PASS.
Commit: `feat: add campaigns crud with filters and data integrity delete guard`

---

### Task 3: Администрирование пользователей, профиль и журнал аудита (BO-14, BO-15)

**Правила:**
- Только роль `admin` (`users:manage`) управляет пользователями и видит `/app/audit` (`audit:view`).
- Создание пользователя: `email`, `fullName`, `role` (`admin|analyst|viewer`), временный пароль (≥ 10 символов, хешируется `@node-rs/argon2`).
- Сброс пароля администратором устанавливает новый временный пароль (≥ 10 символов) и инвалидирует активные сессии этого пользователя в таблице `sessions` (`DELETE FROM sessions WHERE (sess->'user'->>'id')::bigint = $1`).
- Деактивация (`is_active = false`) также немедленно удаляет сессии пользователя из `sessions`.
- **Запрет самоблокировки и самопонижения:** если `targetUserId === actor.id`, нельзя сделать `is_active = false` и нельзя сменить собственную роль с `admin` на другую (`ValidationError('Нельзя заблокировать собственную учётную запись или снять с себя роль администратора')`).
- Любой авторизованный пользователь на `/app/profile` может сменить собственный пароль (введя текущий и новый ≥ 10 символов).

**Маршруты:**
- `GET /app/admin/users` (`requirePermission('users:manage')`) — таблица пользователей, форма создания, действия смены роли, блокировки и сброса пароля.
- `POST /app/admin/users` (`requirePermission('users:manage')`) — создание пользователя.
- `POST /app/admin/users/:id/role` (`requirePermission('users:manage')`) — смена роли.
- `POST /app/admin/users/:id/toggle-active` (`requirePermission('users:manage')`) — блокировка/разблокировка.
- `POST /app/admin/users/:id/reset-password` (`requirePermission('users:manage')`) — сброс пароля.
- `GET /app/audit` (`requirePermission('audit:view')`) — журнал аудита с фильтрами `entity`, `userId`, `action` и пагинацией по 50 записей.
- `GET /app/profile`, `POST /app/profile/password` (`requireAuth`) — профиль и смена своего пароля.

**Files:**
- Create: `src/validators/users.schema.js`, `src/services/users.service.js`, `src/views/pages/audit.ejs`, `src/views/pages/profile.ejs`
- Modify: `src/repositories/users.repo.js`, `src/repositories/audit.repo.js`, `src/services/audit.service.js`, `src/controllers/admin.controller.js`, `src/views/pages/admin-users.ejs`, `src/routes/app.routes.js`
- Test: `tests/integration/users-admin.test.js`

**Interfaces:**
- Consumes: `query`, `withTransaction`, `@node-rs/argon2` (`hash`, `verify`), `auditService.record`.
- Produces:
  - `usersRepo`: `listUsers()`, `createUser({ email, passwordHash, fullName, role })`, `updateUserRole(id, role)`, `setUserActive(id, isActive)`, `updateUserPasswordHash(id, passwordHash)`, `deleteUserSessions(userId)`.
  - `usersService`: `createUser(input, actor)`, `changeUserRole(targetId, role, actor)`, `toggleUserActive(targetId, isActive, actor)`, `resetUserPassword(targetId, newPassword, actor)`, `changeOwnPassword(userId, { currentPassword, newPassword }, ip)`.
  - `auditRepo.listAuditEntries({ entity, userId, action, limit, offset })` (JOIN с `users` для `user_email`, без раскрытия секретов в `payload`).

- [ ] **Step 1: Написать падающий интеграционный тест управления пользователями и аудита**

`tests/integration/users-admin.test.js`:
1. `POST /app/admin/users` под `admin` создаёт `junior@metrika.by` с ролью `analyst` и паролем `TempPass2026!`; новый пользователь успешно входит через `POST /login`;
2. дубль email в другом регистре `JUNIOR@metrika.by` или пароль короче 10 символов → 400 `ValidationError`;
3. `POST /app/admin/users/:id/role` меняет роль `junior` на `viewer`;
4. `POST /app/admin/users/:adminId/toggle-active` (попытка админа деактивировать самого себя) → 400, админ остаётся активным;
5. `POST /app/admin/users/:adminId/role` (попытка админа сменить себе роль на `viewer`) → 400;
6. деактивация `junior` удаляет его сессию: уже залогиненный агент `junior` на следующем `GET /app/dashboard` получает 302 `/login`;
7. сброс пароля `junior` админом позволяет войти только с новым паролем; в `audit_log` никогда не попадает открытый пароль или хеш (`JSON.stringify(row.payload)` не содержит `TempPass`);
8. `GET /app/audit?entity=user` под `admin` → 200, отображает все действия `user.create`, `user.role_change`, `user.deactivate`, `user.password_reset`; под `analyst` → 403.

- [ ] **Step 2: Запустить тест и убедиться в падении**

Run: `npx vitest run tests/integration/users-admin.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать схемы, методы репозитория, `users.service.js`, контроллеры и шаблоны `admin-users.ejs`, `audit.ejs`, `profile.ejs`**

В `middleware/auth.js` убедиться, что `requireAuth` при наличии `req.session.user` проверяет актуальность или что `deleteUserSessions(userId)` удаляет строки из `sessions` (а в тестах с `MemoryStore` сервис дополнительно проверяет `usersRepo.findById(req.session.user.id)` в `requireAuth` — если `!user || !user.is_active`, сессия уничтожается и возвращается 302 `/login`). Это гарантирует мгновенный отзыв доступа при любом `sessionStore`.

- [ ] **Step 4: Прогнать тесты и закоммитить**

Run: `npx vitest run tests/integration/users-admin.test.js`
Expected: PASS.
Commit: `feat: add user administration, session revocation and audit log viewer`

---

### Task 4: Цели и плановые показатели (CRUD, правила пересечения периодов, валидация — BO-10)

**Правила:**
- Согласно таблице прав (`assignment-traceability.md` §2: «Каналы, кампании, цели: admin +, analyst +, viewer −») просмотр `/app/goals` доступен всем (`goals:view`), создание/редактирование/удаление — ролям `admin` и `analyst` (`goals:manage`).
- Поля цели (`goals`): `metric` (`'cac' | 'romi' | 'ltv_cac' | 'payback' | 'new_customers'`), `channel_id` (`NULL` = глобальная blended-цель по всей компании, иначе FK на `channels.id`), `target_value` (`NUMERIC(14,2)` >= 0; для `cac` пользователь вводит в BYN с копейками, хранится в BYN как `NUMERIC(14,2)`, например `50.00`; для `romi` — проценты; для `ltv_cac` — коэффициент; для `payback` — месяцы; для `new_customers` — целое число), `period_start`, `period_end` (`period_end >= period_start`).
- **Правило запрета пересечения периодов (overlap rule):** для одной и той же пары `(metric, COALESCE(channel_id, 0))` не может существовать двух целей, чьи интервалы `[period_start, period_end]` пересекаются (`existing.period_start <= new.period_end AND existing.period_end >= new.period_start`). Перед `INSERT`/`UPDATE` сервис проверяет пересечение в транзакции и при наличии конфликта бросает `ValidationError('Для этой метрики и канала уже задана цель на пересекающийся период')`.

**Маршруты:**
- `GET /app/goals` (`requirePermission('goals:view')`) — список целей с фильтром по каналу и метрике (факт/план/отклонение появится в M5 после движка метрик M3; в M2 отображаются плановые значения, период и статус «активна на отчётную дату» по `dataAnchor`).
- `POST /app/goals` (`requirePermission('goals:manage')`) — создание цели.
- `POST /app/goals/:id` (`requirePermission('goals:manage')`) — обновление `target_value` и дат периода.
- `POST /app/goals/:id/delete` (`requirePermission('goals:manage')`) — удаление цели.

**Files:**
- Create: `src/validators/goals.schema.js`, `src/repositories/goals.repo.js`, `src/services/goals.service.js`, `src/controllers/goals.controller.js`, `src/views/pages/goals.ejs`
- Modify: `src/routes/app.routes.js`
- Test: `tests/integration/goals.test.js`

**Interfaces:**
- Consumes: `query`, `withTransaction`, `getDataAnchor`, `auditService.record`.
- Produces:
  - `goalsRepo`: `listGoals({ channelId, metric })`, `findGoalById(id)`, `findOverlappingGoal({ metric, channelId, periodStart, periodEnd, excludeId })`, `createGoal({ metric, channelId, targetValue, periodStart, periodEnd, createdBy })`, `updateGoal(id, { targetValue, periodStart, periodEnd })`, `deleteGoal(id)`.
  - `goalsService`: `listGoalsForView(filters)`, `createGoal(input, actor)`, `updateGoal(id, input, actor)`, `deleteGoal(id, actor)`.

- [ ] **Step 1: Написать падающий интеграционный тест целей**

`tests/integration/goals.test.js`:
1. `GET /app/goals` под `viewer` → 200, отображает сидированные глобальные цели;
2. `POST /app/goals` под `analyst` создаёт цель для канала `instagram` (`metric: 'cac'`, `targetValue: '42,50'`, `periodStart: '2026-12-01'`, `periodEnd: '2026-12-31'`) → 302, запись в `audit_log` `goal.create`;
3. `POST /app/goals` для того же канала `instagram` и метрики `cac` с пересекающимся периодом `'2026-12-15' .. '2027-01-15'` → 400 с текстом о пересечении периодов;
4. `POST /app/goals` для того же канала и метрики `cac` на непересекающийся период `'2027-01-01' .. '2027-01-31'` → 302 (успех);
5. `POST /app/goals` с `periodEnd < periodStart` или отрицательным `targetValue` → 400;
6. `POST /app/goals/:id/delete` под `viewer` → 403; под `analyst` → 302, цель удалена.

- [ ] **Step 2: Запустить тест и убедиться в падении**

Run: `npx vitest run tests/integration/goals.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать валидатор, репозиторий, сервис, контроллер и `goals.ejs`**

В `goals.schema.js` принимать числа как с запятой, так и с точкой (`'42,50'` → `42.5`), для `new_customers` требовать целое число (`Number.isInteger`).

- [ ] **Step 4: Прогнать тесты и закоммитить**

Run: `npx vitest run tests/integration/goals.test.js`
Expected: PASS.
Commit: `feat: add goals crud with period overlap validation`

---

### Task 5: Инфраструктура импорта CSV (4 типа, dry-run, атомарная транзакция, шаблоны, отчёт ошибок — BO-11)

**Спецификация CSV (строго по `2026-11-21-metrics-spec.md` §8):**
- Кодировка UTF-8 (опциональный BOM `\uFEFF` в начале файла срезается), разделитель `;`, десятичный разделитель сумм — запятая или точка (`1 234,56` или `1234.56`).
- Лимиты: размер файла **≤ 2 МБ** (`2 * 1024 * 1024` байт), число строк данных (без заголовка) **≤ 10 000**, имя файла санитизируется (`basename`, удаление управляющих символов, обрезка до 120 символов).
- Rate-limit на импорт: `importLimiter` — не более 20 запросов за 15 минут на пользователя (в тестах сбрасывается аналогично `loginLimiter`).
- Обязательные колонки и ключи дедупликации по типам (`kind`):

| `kind` | Обязательные колонки (заголовок `;`) | Дедупликация и правила связности |
|---|---|---|
| `daily_stats` | `campaign_code;stat_date;impressions;clicks;leads;spend` | Ключ `(campaign_id, stat_date)` — **обновление** (`ON CONFLICT (campaign_id, stat_date) DO UPDATE`). `campaign_code` обязан существовать в `campaigns`, иначе ошибка строки. `spend` в BYN → `spend_cents`. |
| `customers` | `external_id;first_channel_code;first_campaign_code;first_order_at` | Ключ `external_id` — **пропуск** (`ON CONFLICT (external_id) DO NOTHING`, помечается как `duplicate`). `first_channel_code` обязателен и должен существовать; `first_campaign_code` может быть пустым, но если задан — должен существовать и принадлежать этому каналу. `acquired_at` = `COALESCE(first_order_at, now())`. |
| `touchpoints` | `customer_external_id;channel_code;campaign_code;occurred_at;kind` | Ключ `(customer_external_id, occurred_at, channel_code)` — **пропуск** дубля. `customer_external_id` и `channel_code` обязаны существовать; `kind` ∈ `click\|impression\|visit`. Если у клиента ещё не был задан заказ и новое касание раньше `acquired_at`, сдвигаем `acquired_at`, но `first_channel_id` **никогда не перезаписывается** задним числом, если уже задан. |
| `orders` | `external_id;customer_external_id;campaign_code;occurred_at;revenue;margin` | Ключ `external_id` — **пропуск** дубля. `customer_external_id` обязан существовать (заказ без клиента — ошибка строки). `revenue` и `margin` в BYN → `revenue_cents`, `margin_cents`; `margin >= 0` и `margin <= revenue`, иначе ошибка строки. Если у клиента `first_order_at IS NULL` или `occurred_at < first_order_at`, обновляется `first_order_at`. |

- Лишние колонки в заголовке не блокируют импорт, но возвращаются в `warnings: string[]`. Отсутствие любой обязательной колонки отклоняет весь файл сразу (400).
- **Правило 10% и атомарность:** сначала все строки парсятся и проверяются (включая резолв кодов каналов/кампаний/клиентов). Каждая ошибка записывается как `{ row: number, field: string, message: string }` (номер строки — 1-based, с учётом заголовка: первая строка данных = 2).
  - Если вызван режим `dryRun = true` (предпросмотр): в БД ничего не пишется, возвращается отчёт `{ rowsTotal, rowsValid, rowsDuplicate, rowsFailed, warnings, errors, wouldCommit: rowsFailed / rowsTotal <= 0.1 }`.
  - Если `dryRun = false`:
    - при `rowsTotal === 0` → `ValidationError('Файл не содержит строк данных')`;
    - при `rowsFailed / rowsTotal > 0.10` (ошибок больше 10%) — **ни одна валидная строка не применяется** (транзакция данных не выполняется), но в `import_batches` сохраняется запись с `rows_total`, `rows_ok = 0`, `rows_failed`, `errors` JSONB, чтобы пользователь видел постоянную ссылку на отчёт ошибок;
    - при `rowsFailed / rowsTotal <= 0.10` — все валидные строки применяются в одной транзакции `withTransaction`, и в той же транзакции создаётся запись `import_batches` и запись `audit_log` (`action: 'import.run'`).

**Маршруты:**
- `GET /app/import` (`requirePermission('import:run')`) — страница загрузки CSV (выбор `kind`, чекбокс «Только проверить без сохранения (dry-run)», ссылки на 4 шаблона, таблица последних 20 `import_batches`).
- `GET /app/import/templates/:kind.csv` (`requirePermission('import:run')`) — скачивание эталонного CSV-шаблона с BOM, заголовком и 2 примерами строк для каждого из 4 типов.
- `POST /app/import` (`requirePermission('import:run')`, `importLimiter`, `multer` single `'file'`) — выполнение dry-run или боевого импорта.
- `GET /app/import/batches/:id` (`requirePermission('import:run')`) — детальный отчёт по пакету импорта с таблицей ошибок по строкам.

**Files:**
- Modify: `package.json` (`npm i multer@^2.0.0`), `src/middleware/rateLimit.js` (`importLimiter`)
- Create: `src/lib/csv.js`, `src/validators/import.schema.js`, `src/repositories/import.repo.js`, `src/services/import.service.js`, `src/controllers/import.controller.js`, `src/views/pages/import.ejs`, `src/views/pages/import-batch.ejs`
- Modify: `src/routes/app.routes.js`
- Test: `tests/unit/import-validators.test.js`, `tests/integration/import.test.js`

**Interfaces:**
- Consumes: `withTransaction`, `query`, `parseBynToCents`, `auditService.record`.
- Produces:
  - `src/lib/csv.js`: `parseCsv(bufferOrString, { delimiter = ';', maxRows = 10000 })` → `{ headers: string[], rows: Array<{ rowNumber: number, values: Record<string, string> }> }`; `stringifyCsv(headers, rows, { withBom = true })` → `string`.
  - `importService.runImport({ kind, filename, buffer, dryRun, actor })` → `{ batchId, kind, dryRun, committed, rowsTotal, rowsOk, rowsDuplicate, rowsFailed, warnings, errors }`.
  - `importService.getTemplateCsv(kind)` → `{ filename, content }`.

- [ ] **Step 1: Установить `multer` и написать падающие юнит-тесты CSV-парсера и валидаторов строк**

```bash
npm i multer@^2.0.0
```
В `tests/unit/import-validators.test.js` проверить:
1. `parseCsv` корректно срезает UTF-8 BOM `\uFEFF`, разбирает `;`, кавычки и возвращает `rowNumber: 2` для первой строки данных;
2. `parseCsv` бросает `ValidationError('Превышен лимит 10 000 строк')` на 10 001 строке;
3. валидатор строки `orders` отклоняет `margin > revenue` и отрицательную сумму;
4. валидатор `daily_stats` принимает `spend: '1 200,50'` и возвращает `spendCents: 120050n`;
5. неизвестные лишние колонки возвращаются в `warnings`, а отсутствие обязательной колонки `spend` бросает `ValidationError`.

- [ ] **Step 2: Запустить юнит-тест и убедиться в падении**

Run: `npx vitest run tests/unit/import-validators.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать `src/lib/csv.js` и `src/validators/import.schema.js`, добиться зелёного юнит-теста**

Run: `npx vitest run tests/unit/import-validators.test.js`
Expected: PASS.

- [ ] **Step 4: Написать падающий интеграционный тест импорта всех 4 типов и граничных условий**

`tests/integration/import.test.js`:
1. `GET /app/import/templates/daily_stats.csv` → 200, `text/csv`, начинается с `\uFEFFcampaign_code;stat_date;impressions;clicks;leads;spend`;
2. `POST /app/import` (`kind=daily_stats`, `dryRun=true`) с 3 валидными строками → 200, `rowsOk: 3`, но в таблице `daily_stats` и `import_batches` количество записей не изменилось;
3. боевой импорт `daily_stats` (2 новые даты + 1 существующая `(campaign_id, stat_date)`) → обновляет `spend_cents` существующей даты и вставляет 2 новые, создаёт `import_batches` и запись в `audit_log`;
4. боевой импорт `customers` (2 новых + 1 существующий `external_id`) → вставляет 2, пропускает 1 дубль (`rowsDuplicate: 1`, `rowsFailed: 0`);
5. боевой импорт `touchpoints` и `orders` для импортированных клиентов → вставляет записи, повторная отправка того же файла даёт `rowsDuplicate`, не создавая дублей в БД;
6. **тест атомарности (порог 10%):** файл `orders` из 5 строк, где 1 строка валидна, а в 1 строке `margin > revenue` (20% ошибок > 10%) → `committed: false`, валидный заказ **не появился** в таблице `orders`, в `import_batches` записано `rows_ok = 0, rows_failed = 1` и `errors[0].row === 3`;
7. файл из 10 строк `orders`, где 9 валидны и 1 с несуществующим `customer_external_id` (10% ошибок ≤ 10%) → `committed: true`, 9 заказов в БД, `rows_ok = 9, rows_failed = 1`;
8. загрузка буфера размером 2.1 МБ → 400/413 «Файл превышает допустимый размер 2 МБ»;
9. `POST /app/import` под `viewer` → 403.

- [ ] **Step 5: Запустить интеграционный тест и убедиться в падении**

Run: `npx vitest run tests/integration/import.test.js`
Expected: FAIL.

- [ ] **Step 6: Реализовать `import.repo.js`, `import.service.js`, `import.controller.js` и шаблоны `import.ejs`, `import-batch.ejs`**

Для корректной работы CSRF с `multipart/form-data`: на маршруте `POST /app/import` (или в `csrf` middleware) разрешить передачу токена через заголовок `X-CSRF-Token` либо проверять `req.body._csrf` после вызова `upload.single('file')`. Имя файла санитизировать функцией `sanitizeFilename(raw)`.

- [ ] **Step 7: Прогнать тесты и закоммитить**

Run: `npx vitest run tests/unit/import-validators.test.js tests/integration/import.test.js`
Expected: PASS.
Commit: `feat: add csv import pipeline with dry-run, 10% error threshold and batch reports`

---

### Task 6: Экспорт отчётов в CSV с учётом текущих фильтров и аудитом (BO-12)

**Правила (`2026-11-21-metrics-spec.md` §8 и `assignment-traceability.md` §2):**
- Экспорт доступен всем авторизованным ролям, включая `viewer` (`requirePermission('export')`).
- Формат: UTF-8 с BOM (`\uFEFF`), разделитель `;`, десятичная запятая для сумм в BYN (`1234,56`, без пробелов тысяч внутри CSV-чисел, чтобы Excel открывал колонку как число), заголовок `Content-Type: text/csv; charset=utf-8` и `Content-Disposition: attachment; filename="metrika-<dataset>-<YYYY-MM-DD>.csv"`.
- Поддерживаемые наборы данных (`dataset`) и их фильтры:
  - `channels` (`status`, `kind`) — колонки `code;name;kind;is_active;target_cac_byn;target_romi_pct;campaigns_count`;
  - `campaigns` (`channelId`, `status`, `q`) — колонки `code;name;channel_code;status;started_on;ended_on;budget_byn;spend_byn`;
  - `daily_stats` (`channelId`, `campaignId`, `from`, `to`) — колонки `stat_date;channel_code;campaign_code;impressions;clicks;leads;spend_byn`;
  - `orders` (`channelId`, `from`, `to`) — колонки `external_id;customer_external_id;first_channel_code;campaign_code;occurred_at;revenue_byn;margin_byn`.
- Защита от CSV-инъекций (Formula Injection): если строковое значение ячейки начинается с `=`, `+`, `-`, `@`, `\t`, `\r`, при сериализации в `stringifyCsv` экранировать его или предварять апострофом `'`, кроме отрицательных чисел.
- Каждый вызов экспорта пишет в `audit_log`: `action: 'export.csv'`, `entity: dataset`, `payload: { filters, rowsCount }`.

**Маршруты:**
- `GET /app/export/:dataset.csv` (`requireAuth`, `requirePermission('export')`) — скачивание CSV с query-фильтрами текущего экрана. На страницах `channels.ejs` и `campaigns.ejs` добавить ghost-кнопку «Экспорт CSV», передающую текущие query-параметры.

**Files:**
- Create: `src/repositories/export.repo.js`, `src/services/export.service.js`, `src/controllers/export.controller.js`
- Modify: `src/lib/csv.js` (защита от formula injection), `src/routes/app.routes.js`, `src/views/pages/channels.ejs`, `src/views/pages/campaigns.ejs`
- Test: `tests/integration/export.test.js`

**Interfaces:**
- Consumes: `query`, `stringifyCsv`, `getDataAnchor`, `auditService.record`.
- Produces: `exportService.exportDataset({ dataset, filters, actor })` → `{ filename, csvContent, rowsCount }`.

- [ ] **Step 1: Написать падающий интеграционный тест экспорта**

`tests/integration/export.test.js`:
1. `GET /app/export/channels.csv?kind=paid` под `viewer` → 200, `content-type` содержит `text/csv`, `content-disposition` содержит `attachment; filename="metrika-channels-`, тело начинается с `\uFEFFcode;name;kind;`, в выдаче только `paid`-каналы (6 из 8);
2. `GET /app/export/campaigns.csv?status=finished` → содержит только завершённые кампании;
3. `GET /app/export/daily_stats.csv?from=2026-11-01&to=2026-11-10` → все `stat_date` лежат внутри диапазона;
4. в `audit_log` создана запись `action = 'export.csv'` с `user_id` наблюдателя и `rowsCount`;
5. `GET /app/export/unknown.csv` → 400 `ValidationError`.

- [ ] **Step 2: Запустить тест и убедиться в падении**

Run: `npx vitest run tests/integration/export.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать `export.repo.js`, `export.service.js`, `export.controller.js` и кнопки в шаблонах**

- [ ] **Step 4: Прогнать тесты и закоммитить**

Run: `npx vitest run tests/integration/export.test.js`
Expected: PASS.
Commit: `feat: add filtered csv export with utf-8 bom and audit logging`

---

### Task 7: Ресурсные медиаданные в БД (`media_assets`, BYTEA, `/media/:id` с ETag и кэшем)

**Требование бланка и спеки (`design.md` §2, §7, §8; `AGENTS.md` §8):**
- Изображения хранятся в таблице `media_assets` (`id`, `slug`, `filename`, `mime_type`, `size_bytes`, `checksum`, `bytes BYTEA`) и отдаются по публичному маршруту `GET /media/:id` (а также по `GET /media/slug/:slug` или `/media/:idOrSlug` для `og-cover`).
- **MIME whitelist и проверка магических байтов (magic bytes):** разрешены только `image/png` (`89 50 4E 47`), `image/jpeg` (`FF D8 FF`), `image/webp` (`RIFF....WEBP`). Загрузка `image/svg+xml`, `text/html` или файла, у которого заголовок буфера не совпадает с заявленным MIME, отклоняется с `ValidationError('Допустимы только изображения PNG, JPEG или WebP')` (исключает stored XSS через SVG).
- Лимит размера изображения — **1 МБ** (`1024 * 1024` байт).
- `checksum` — SHA-256 от `bytes` в hex. Заголовок `ETag: "<checksum>"`, `Cache-Control: public, max-age=86400, immutable`, `X-Content-Type-Options: nosniff`. Если клиент прислал `If-None-Match: "<checksum>"`, сервер отвечает `304 Not Modified` без тела.
- Сценарии загрузки в UI:
  1. Загрузка/обновление OG-обложки сайта (`slug = 'og-cover'`, только `admin` на странице `/app/admin/users` или в блоке настроек бренда; `seo.js` использует `/media/slug/og-cover` если запись есть, иначе fallback `/img/og-cover.svg`).
  2. Загрузка аватара пользователя (`slug = 'avatar-user-' + user.id`, любой авторизованный пользователь на `/app/profile`; отображается в `topbar.ejs`).
- В `db/seed/seed.js` добавить детерминированную минимальную валидную PNG-обложку `slug = 'og-cover'`, чтобы `/media/slug/og-cover` работал сразу после `npm run seed`.

**Маршруты:**
- `GET /media/:id` и `GET /media/slug/:slug` (публичные, без `requireAuth`, чтобы соцсети и браузер читали `og:image`).
- `POST /app/profile/avatar` (`requireAuth`, `multer` single `'avatar'`) — загрузка своего аватара.
- `POST /app/admin/media/og-cover` (`requireAuth`, `requirePermission('users:manage')`, `multer` single `'file'`) — обновление OG-обложки.

**Files:**
- Create: `src/repositories/media.repo.js`, `src/services/media.service.js`, `src/controllers/media.controller.js`
- Modify: `src/routes/public.routes.js`, `src/routes/app.routes.js`, `src/views/pages/profile.ejs`, `src/views/pages/admin-users.ejs`, `src/views/partials/topbar.ejs`, `db/seed/seed.js`
- Test: `tests/integration/media.test.js`

**Interfaces:**
- Consumes: `query`, `crypto.createHash`, `auditService.record`.
- Produces:
  - `mediaRepo`: `upsertMediaAsset({ slug, filename, mimeType, sizeBytes, checksum, bytes })`, `findMediaById(id)`, `findMediaBySlug(slug)`.
  - `mediaService`: `saveMedia({ slug, originalName, mimeType, buffer, actor })`, `getMediaById(id)`, `getMediaBySlug(slug)`.

- [ ] **Step 1: Написать падающий интеграционный тест медиаресурсов**

`tests/integration/media.test.js`:
1. после `seed()` запрос `GET /media/slug/og-cover` → 200, `Content-Type: image/png`, присутствует `ETag`, `Cache-Control` и непустой бинарный буфер;
2. повторный запрос `GET /media/slug/og-cover` с заголовком `If-None-Match: <etag>` → 304 с пустым телом;
3. `POST /app/profile/avatar` под `analyst` с валидным 1×1 PNG-буфером → 302, `GET /media/:id` отдаёт те же байты, в `audit_log` запись `media.upload`;
4. `POST /app/profile/avatar` с SVG-буфером `<svg onload="alert(1)">` или текстовым файлом с подделанным `Content-Type: image/png` → 400 `ValidationError`;
5. `POST /app/admin/media/og-cover` под `analyst` → 403; под `admin` → 302, обновляет обложку.

- [ ] **Step 2: Запустить тест и убедиться в падении**

Run: `npx vitest run tests/integration/media.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать `media.repo.js`, `media.service.js`, `media.controller.js`, сид PNG и формы в шаблонах**

Проверка сигнатуры в `media.service.js`:
- PNG: `buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))`
- JPEG: `buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff`
- WebP: `buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'`

- [ ] **Step 4: Прогнать тесты и закоммитить**

Run: `npx vitest run tests/integration/media.test.js`
Expected: PASS.
Commit: `feat: store media assets in postgres bytea and serve with etag caching`

---

### Task 8: E2E-проверка этапа через `agent-browser`, скриншоты и отчёт M2

**Сценарий сквозной проверки (критерий завершения M2 из дорожной карты):**
1. **Наполнение с нуля аналитиком без `psql`:** очистить таблицы данных (`channels`, `campaigns`, `daily_stats`, `customers`, `touchpoints`, `orders`, `goals`), оставив 3 пользователей. Войти в браузере как `analyst@metrika.by`:
   - создать канал «Telegram Посевы» (`code: tg_seeds`, целевой CAC `30,00`, целевой ROMI `130`);
   - создать кампанию «Посев Ноябрь» (`code: tg_seeds_nov`, бюджет `1 500,00`);
   - создать цель по CAC на текущий месяц;
   - на `/app/import` загрузить по очереди 4 CSV-файла (`daily_stats`, `customers`, `touchpoints`, `orders`) и увидеть отчёт `rows_failed = 0`;
   - нажать «Экспорт CSV» на странице каналов и убедиться, что файл скачивается;
   - на `/app/profile` загрузить PNG-аватар и увидеть его в верхней панели.
2. **Проверка ограничений `viewer`:** войти как `viewer@metrika.by`, убедиться, что кнопки создания канала/кампании/цели и пункт «Импорт» отсутствуют, экспорт CSV работает, а прямые переходы на `/app/import`, `/app/admin/users`, `/app/audit` отдают страницу 403.
3. **Администрирование и аудит:** войти как `admin@metrika.by`, на `/app/admin/users` создать пользователя, сменить ему роль, заблокировать его; открыть `/app/audit` и убедиться, что все действия аналитика, наблюдателя и администратора зафиксированы; проверить отдачу `/media/slug/og-cover`.
4. Проверить отсутствие ошибок в `agent-browser console` на каждом экране и вёрстку на мобильной ширине `390×844`.

**Files:**
- Create: `docs/screenshots/m2/README.md`, `docs/screenshots/m2/*.png` (`channels.png`, `campaigns.png`, `goals.png`, `import-report.png`, `admin-users.png`, `audit-log.png`, `mobile-channels.png`)
- Modify: `README.md` (обновить статус M2), `IMPROVEMENTS.md` (при обнаружении некритичных замечаний)

**Interfaces:** не меняет production-код.

- [ ] **Step 1: Прогнать весь тестовый набор Vitest**

Run: `npm test`
Expected: все юнит- и интеграционные тесты M1 + M2 зелёные, включая `single-stylesheet.test.js`.

- [ ] **Step 2: Выполнить интерактивный E2E-прогон в `agent-browser`**

Запустить сервер на чистой/сидированной БД, пройти сценарии 1–4 реальными кликами (`snapshot -i`, `fill`, `click`, `upload`), после каждого экрана проверять `agent-browser console`, снять скриншоты в `docs/screenshots/m2/`, вернуть демо-сид командой `npm run seed`.

- [ ] **Step 3: Оформить `docs/screenshots/m2/README.md`, обновить `README.md` и закоммитить**

Commit: `docs: add m2 e2e verification log and screenshots`

---

## Приёмка M2

- [ ] Все тесты M1 и M2 (`npm test`) зелёные; `single-stylesheet.test.js` проходит на всех новых `.ejs`-шаблонах.
- [ ] Аналитик способен завести канал, кампанию, цель и импортировать 4 типа CSV через UI на пустой БД.
- [ ] Канал с активными кампаниями нельзя архивировать; кампанию со статистикой/заказами нельзя удалить.
- [ ] При >10% ошибочных строк CSV-пакет откатывается целиком, но отчёт ошибок сохраняется в `import_batches`.
- [ ] Администратор управляет пользователями, сессии заблокированного пользователя отзываются, самоблокировка запрещена.
- [ ] Изображения хранятся в `media_assets` (`BYTEA`) и отдаются по `/media/:id` с `ETag` и `304 Not Modified`.
- [ ] Каждая мутация и экспорт отражены в `/app/audit` без утечки паролей и секретов.
- [ ] Скриншоты и лог браузерной проверки лежат в `docs/screenshots/m2/`.
