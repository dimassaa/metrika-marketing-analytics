# M2 «Данные и администрирование» — план реализации

> **Для агентов:** обязательный навык — `superpowers:subagent-driven-development` (рекомендуется) или
> `superpowers:executing-plans`. Выполнять задачи по порядку, отмечать шаги `- [x]`, коммитить в конце задачи.
>
> **Модель исполнителя и ревьюера:** `opencode-go/deepseek-v4.1-flash` (`AGENTS.md` §3). Другие модели не выбирать,
> даже если кажется, что они подходят лучше.

**Цель:** превратить каркас M1 в рабочую систему ввода и администрирования данных: CRUD каналов, кампаний,
целей и пользователей, потоковый CSV-импорт 4 типов с атомарной транзакцией и отчётом ошибок, CSV-экспорт
с учётом фильтров, хранение медиаресурсов (`BYTEA`) с отдачей по `/media/:id`, полный журнал аудита и E2E-проверка.

**Архитектура:** Express MVC (`routes → controllers → services → repositories → EJS`), серверный рендер форм и таблиц,
валидация Zod на сервере и HTML5 на клиенте, сессии и CSRF double-submit из M1, RBAC по матрице прав, транзакции
через `withTransaction(db, fn)`. React-острова на этом этапе не используются (появляются в M4); загрузки файлов
идут через маленький vanilla-скрипт `public/js/upload-form.js`, потому что multipart-запрос обязан нести заголовок
`X-CSRF-Token`.

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
  Драйвер `pg` отдаёт `BIGINT`/`NUMERIC` строками: в коде они читаются только через `centsFromDb` (`src/lib/money.js`),
  «слепой» `Number(value)` для денег запрещён.
- Даты: `timestamptz` UTC, календарные `date`; отображение Europe/Minsk; «сегодня» = data anchor
  (`MAX(daily_stats.stat_date)`), fallback — текущая дата Minsk.
- PostgreSQL 18, FK/CHECK/UNIQUE, никаких ORM. Удаление истории клиентов и заказов запрещено (`ON DELETE RESTRICT`).
- RBAC на сервере; CSRF на всех небезопасных методах. Обычные формы передают `_csrf` в теле, загрузки — только
  заголовком `X-CSRF-Token` (см. «Механика CSRF и загрузок»). Токен в query-строке **запрещён**: URL попадают
  в логи, историю браузера и `Referer`. Пароли argon2id (минимум 10 символов).
- Сессии: httpOnly, sameSite=lax, secure в production, TTL 8 часов, regenerate при входе.
- Порты: приложение 3000; БД `metrika_dev` и `metrika_test` на localhost.
- Никаких CDN; шрифты и изображения локальные.
- Коммит в конце каждой задачи от имени владельца репозитория (git config настроен).

### Механика CSRF и загрузок (одно решение для T5 и T7)

Порядок middleware в `src/app.js` фиксирован: `express.json`/`express.urlencoded` → сессия → `csrfProtection` →
маршруты. `multer` разбирает `multipart/form-data` уже внутри маршрута, то есть **после** `csrfProtection`; поле
`_csrf` из multipart на этой проверке невидимо, и любая multipart-форма получила бы 403. Поэтому механизма ровно два,
и каждый применяется только в своей зоне:

1. **Urlencoded-действия** — `POST /app/channels`, `/app/campaigns`, `/app/goals`, `/app/admin/users/*`,
   `/app/profile/password`. Обычная HTML-форма с `<input type="hidden" name="_csrf" value="<%= csrfToken %>">`;
   ответ — 302 + redirect либо страница с ошибкой.
2. **Загрузки файлов (multipart)** — `POST /api/v1/import`, `POST /api/v1/profile/avatar`,
   `POST /api/v1/admin/media/og-cover`. Клиент собирает `FormData`, добавляет заголовок `X-CSRF-Token` (значение
   из `data-csrf` на элементе формы, который рендерит EJS) и вызывает `fetch`. Сервер отвечает только JSON — и на
   успех, и на ошибку: путь `/api/*` уже обслуживается JSON-контрактом `errorHandler`.
   Скрипт — `public/js/upload-form.js` (один на все три формы, подключается `<script src="/js/upload-form.js" defer>`,
   CSP `script-src 'self'` это разрешает).
3. **Без-JS пути для загрузок нет.** Формы загрузки содержат `<noscript>` с текстом «Загрузка файла требует
   JavaScript». Скрытая multipart-форма без JS не отправляется — сознательный выбор: иначе нужен второй контракт
   ответов (HTML view-model) и обход порядка middleware.
4. **Обязательный тест на реальный multipart:**
   `request(app).post('/api/v1/import').set('X-CSRF-Token', token).field('kind', 'orders').attach('file', Buffer.from(csv), 'orders.csv')`
   → 200/400 по контракту, но не 403. Плюс по одному тесту отказа CSRF на каждое семейство POST (T1–T5).

### Фактические интерфейсы M1 (доступные к началу M2)

**Уже в репозитории (`src/` и `db/` после Task 1–2 M1):**
- `src/config/env.js`: `env` (`{ nodeEnv, port, databaseUrl, testDatabaseUrl, sessionSecret, appUrl, cookieSecure, logLevel }`), `parseEnv(source)`.
- `src/lib/db.js`: `pool`, `query(text, params)` (оба привязаны к `DATABASE_URL`), `withTransaction(fn)` (`fn(client)`),
  `pingDb()`, `closeDb()`. **В сервисах M2 `query`/`pool` из этого модуля не импортируются:** тестовое приложение
  собирается над `TEST_DATABASE_URL`, и запрос через глобальный пул писал бы в dev-БД. Репозитории получают `db`
  аргументом; в T5 `withTransaction` меняет сигнатуру на `withTransaction(db, fn)`.
- `src/lib/logger.js`: `logger` (pino, silent в `test`).
- `src/lib/errors.js`: `AppError`, `ValidationError` (400, код `VALIDATION_ERROR`), `UnauthorizedError` (401),
  `ForbiddenError` (403, код `FORBIDDEN`), `NotFoundError` (404).
- `src/middleware/requestId.js`: `requestId`.
- `src/middleware/errors.js`: `notFound`, `errorHandler`. JSON только для пути `/api/*`; страничные 4xx уходят
  как `text/plain` с русским сообщением, 5xx — HTML-страница. Поэтому **styled 403** (HTML «Недостаточно прав»)
  отдаёт только `requirePermission` для страницы, а **CSRF-отказ** — это `text/plain` «CSRF token mismatch».
  Именно так их и различают тесты.
- `db/migrate.js` + `db/migrations/001_init.sql`: 15 таблиц (`users`, `sessions`, `channels`, `campaigns`, `daily_stats`, `customers`, `touchpoints`, `orders`, `goals`, `alerts`, `scenarios`, `audit_log`, `import_batches`, `media_assets`, `schema_migrations`), триггеры `set_updated_at()`. Миграции применяются в порядке имён файлов.
- `tests/helpers/db.js`: `getTestPool()`, `resetTestDatabase()`, `closeTestPool()`. `vitest.config.js` держит
  `fileParallelism: false`: файлы тестов идут последовательно на одной тестовой БД.

**Интерфейсы M1 из Task 3–7 (потребляются в M2 без переименования):**
- `src/app.js`: `createApp({ db, sessionStore })`. Тесты вызывают `createApp({ db: getTestPool() })` без второго
  аргумента, то есть **сессии в тестах живут в реальной таблице `sessions`** (PgStore), отдельной ветки для
  `MemoryStore` нет и не появляется.
- `src/lib/dates.js`: `minskToday()`, `minskYesterday()`, `toDateOnly(date)`, `addDays(date, n)`, `startOfMonth(date)`, `formatDateRu(date)`, `isoWeekStart(date)`.
- `src/lib/seo.js`: `buildSeo({ title, description, path, imagePath, noindex })`.
- `src/lib/csrf.js` и `src/middleware/csrf.js`: `issueCsrfToken(req)`, `verifyCsrfToken(req, token)`, middleware проверки `_csrf` / `x-csrf-token`.
- `src/config/permissions.js`: `PERMISSIONS`, `can(role, permission)` (`channels:view`, `channels:manage`, `campaigns:view`, `campaigns:manage`, `goals:view`, `goals:manage`, `import:run`, `export`, `users:manage`, `audit:view`).
- `src/middleware/auth.js`: `requireAuth`, `requirePermission(permission)`, `safeRedirectTarget(value)`. `isApiRequest` внутри проверяет `req.path`, поэтому **в T5 он переводится на `req.originalUrl`**: внутри роутера, смонтированного на `/api/v1`, `req.path` уже обрезан и JSON-контракт иначе не сработает.
- `src/middleware/rateLimit.js`: `createLoginRateLimiter()` — **фабрика на приложение**, а не модульный singleton; в M2 рядом добавляется `createImportRateLimiter()`.
- `src/services/audit.service.js`: `createAuditService({ auditRepository })` → `record({ userId, action, entity, entityId, payload, ip })`.
- `src/repositories/audit.repo.js`: `createAuditRepository(db)` → `insert(entry)`. Методов чтения ещё нет.
- `src/repositories/users.repo.js`: `createUsersRepository(db)` → `findByEmail(email)`, `touchLastLogin(id)`, `listForAdmin()`.
  **`findById` в M1 отсутствует** — его добавляет T3 (нужен для смены собственного пароля), и он попадает в Produces T3.
- `src/repositories/reference.repo.js`: `createReferenceRepository(db)` → `getDataAnchor()`. `formatAnchorRu` здесь нет.
- `src/controllers/app.controller.js`: `createAppController({ referenceRepository })` → `dashboard`, `comingSoon({ title, activeNav })`;
  экспорты `buildShellLocals(req, { title, activeNav, dataAnchor })`, `formatAnchorRu(date)`, `roleLabel(role)`, `initialsOf(fullName)`.
- `src/controllers/admin.controller.js`: `createAdminController({ usersRepository, referenceRepository })` → `users`; таблица собирается из `listForAdmin()`.
- `src/routes/app.routes.js`: `createAppRouter({ requireAuth, usersRepository, referenceRepository })`; массив `PLACEHOLDER_SECTIONS` с заглушками
  `channels`, `campaigns`, `cohorts`, `attribution`, `scenarios`, `alerts`, `goals`, `profile` и явные заглушки `/import`, `/audit`.
- `src/routes/public.routes.js`: **сейчас это готовый `Router` (default export), а не фабрика**; T7 обязан превратить его в `createPublicRouter({ mediaController })`.
- `db/seed/seed.js`: `seed({ anchorDate })`; очищает 14 таблиц данных и создаёт 3 пользователей, 8 каналов, 32 кампании,
  4 глобальные цели за 12 месяцев до якоря. PNG-обложки `og-cover` в сиде **нет** — её добавляет T7.
- `tests/helpers/csrf.js`: `getCsrf(agent, path = '/login')`; `tests/helpers/app.js`: `makeApp()`, `loginAs(agent, email, password)`, `DEMO_PASSWORD`.
  Для авторизованных запросов берётся токен со страницы `/app/dashboard` (он есть в форме выхода), а не с `/login`,
  который для залогиненного пользователя отвечает 302 без формы. В T1 в `tests/helpers/csrf.js` добавляется
  `getAppCsrf(agent)` = `getCsrf(agent, '/app/dashboard')`.
- Layouts и partials: `src/views/layouts/app.ejs`, `src/views/layouts/public.ejs`, `src/views/partials/{head,sidebar,topbar}.ejs`, `src/views/errors/{403,404,500}.ejs`.
- CSS-классы из `public/css/app.css`: `.container`, `.card`, `.btn`, `.btn--primary`, `.btn--ghost`, `.btn--danger`, `.input`, `.select`,
  `.field`, `.field__error`, `.table`, `.table-wrap`, `.badge`, `.badge--healthy|watch|risk`, `.kpi`, `.skeleton`, `.empty-state`, `.alert`,
  `.byn`, `.u-hidden`, `.u-visually-hidden`, `.stack`, `.cluster`, `.grid`.

**Репозитории и сервисы — всегда фабрики:** `createChannelsRepository(db)`, `createCampaignsService({ ... })` и т. п.;
в тексте задач имена `channelsRepo` / `channelsService` означают экземпляры этих фабрик.

### Новая зависимость M2 и обоснование

- **`multer@^2.0.0`** — единственная новая runtime-зависимость. Нужна для разбора `multipart/form-data` в памяти (`multer.memoryStorage()`) с жёстким потоковым отсечением по `limits.fileSize` (2 МБ) в T5 (CSV-импорт) и T7 (загрузка `media_assets`). Чистый JS, не тянет TypeScript и CSS.
- **CSV-парсер (`csv-parse`) НЕ устанавливаем:** формат в метрик-спеке §8 жёстко фиксирован (UTF-8, опциональный BOM, разделитель `;`, 4 известные схемы без многострочных текстовых полей). Собственный парсер `src/lib/csv.js` на 45 строк с поддержкой BOM, кавычек `""` и подсчётом номеров строк проще, прозрачнее на защите и не несёт внешних зависимостей.

## Review Focus

1. **Частичная запись при импорте (import partial writes).** Если в CSV на 100 строк 11 строк битые (>10%) или внутри транзакции случается ошибка FK, в БД не должна остаться ни одна строка из этого файла, а в `import_batches` фиксируется отчёт с `committed = false`, счётчиками разобранного файла и списком ошибок. Проверяется в `tests/integration/import.test.js` (Task 5), включая откат по инъецированной ошибке триггера.
2. **Дубликаты ключей (duplicate keys).** Повторный код канала/кампании, дубль email без учёта регистра (`Admin@metrika.by`), пересекающийся период цели или повторный импорт тех же строк (`daily_stats` обновляет, `customers`/`touchpoints`/`orders` пропускают как дубли) не должны ронять сервер с 500 — только 400/409 или штатный `skipped` в отчёте. Проверяется в `channels.test.js` (T1), `campaigns.test.js` (T2), `users-admin.test.js` (T3), `goals.test.js` (T4), `import.test.js` (T5).
3. **Эскалация привилегий и самоблокировка (role escalation & self-lockout).** `viewer` не может вызвать никакой POST/PATCH/DELETE (403); `analyst` не может управлять пользователями, читать `/app/audit` или загружать глобальную OG-обложку (403); `admin` не может деактивировать самого себя или понизить собственную роль. Проверяется в `users-admin.test.js` (T3) и браузерным прогоном (T8).
4. **Превышение лимитов загрузки (oversized upload).** Файл > 2 МБ или CSV > 10 000 строк отклоняется с 413/400 до начала транзакции БД; файл с неверным MIME/сигнатурой (`image/svg+xml` со скриптом или `.exe` под видом `.png`) отклоняется в T7. Проверяется в `import.test.js` (T5) и `media.test.js` (T7).
5. **XSS через названия каналов, кампаний и имена файлов.** Попытка сохранить `<script>alert(1)</script>` в `channels.name`, `campaigns.name`, `users.full_name` или `import_batches.filename` рендерится в EJS строго через `<%= %>` как экранированный текст `&lt;script&gt;`, не исполняясь в браузере. Проверяется в `channels.test.js` (T1) и в браузерной консоли `agent-browser` (T8).

---

## Карта файлов M2

```
db/
  migrations/002_m2_data.sql      (уникальный ключ touchpoints, rows_duplicate, индекс целей)
src/
  app.js                          (сборка всех репозиториев/сервисов M2, монтирование /api/v1 и медиа)
  config/
    audit-actions.js              (единый словарь AUDIT_ACTIONS для сервисов, тестов и фильтра)
  lib/
    money.js                      (парсинг BYN -> cents, centsFromDb, арифметика)
    format.js                     (рендер-форматирование: formatCentsToByn, formatPercent, formatInteger)
    csv.js                        (парсинг и сериализация CSV с ';', BOM, CRLF, лимит строк)
    db.js                         (Modify: withTransaction(db, fn))
  middleware/
    upload.js                     (multer + маппинг LIMIT_FILE_SIZE/LIMIT_UNEXPECTED_FILE)
    auth.js                       (Modify: isApiRequest по req.originalUrl)
    errors.js                     (Modify: isApiRequest по req.originalUrl для JSON-контракта)
    rateLimit.js                  (Modify: createImportRateLimiter)
  validators/
    channels.schema.js
    campaigns.schema.js
    users.schema.js
    goals.schema.js
    import.schema.js
  repositories/
    channels.repo.js
    campaigns.repo.js
    users.repo.js                 (расширение M1: findById, create, updateRole, setActive, updatePasswordHash, deleteUserSessions)
    goals.repo.js
    import.repo.js                (создаётся с client внутри транзакции)
    export.repo.js
    media.repo.js
    audit.repo.js                 (расширение M1: list({ filters, limit, offset }), count(filters))
  services/
    channels.service.js
    campaigns.service.js
    users.service.js
    goals.service.js
    import.service.js
    export.service.js
    media.service.js
    audit.service.js              (расширение M1: listAuditEntries(filters))
  controllers/
    channels.controller.js
    campaigns.controller.js
    admin.controller.js           (расширение M1: CRUD пользователей + журнал аудита + OG-обложка)
    goals.controller.js
    import.controller.js
    export.controller.js
    media.controller.js
    app.controller.js             (Modify: профиль и общие locals, где нужно)
  routes/
    app.routes.js                 (Modify: реальные страницы вместо заглушек)
    api.routes.js                 (новый: POST /import, /profile/avatar, /admin/media/og-cover)
    public.routes.js              (Modify: фабрика createPublicRouter({ mediaController }), GET /media/*)
public/
  css/app.css                     (Modify: фильтры, пагинация, файловый input, row actions)
  js/upload-form.js               (fetch + FormData + X-CSRF-Token для трёх форм загрузки)
src/views/pages/
  channels.ejs
  channel-detail.ejs
  campaigns.ejs
  goals.ejs
  import.ejs
  import-batch.ejs
  audit.ejs
  admin-users.ejs                 (расширение M1: формы создания, смены роли, сброса пароля, блокировки, OG-обложка)
  profile.ejs                     (смена собственного пароля и загрузка аватара)
tests/
  helpers/csrf.js                 (Modify: getAppCsrf)
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
    rbac.test.js                  (Modify: убрать проверки заглушек, обновить роспись пользователей)
docs/screenshots/m2/
  README.md
  csv/{daily_stats,customers,touchpoints,orders}.csv
  *.png
```

---

### Task 1: Денежные/форматные хелперы и управление каналами (список, создание, редактирование, архивирование)

**Решение по архивированию канала:** канал **не удаляется физически** (в БД `campaigns.channel_id` и `customers.first_channel_id` имеют `ON DELETE RESTRICT`), а переводится в `is_active = false` (архив) и может быть реактивирован. **Нельзя архивировать канал, у которого есть кампании со статусом `'active'`** — сервис выбрасывает `ValidationError('Нельзя архивировать канал с активными кампаниями: сначала остановите или завершите их')`. Исторические данные архивного канала остаются в отчётах, но при создании новой кампании архивный канал выбрать нельзя.

**Маршруты:**
- `GET /app/channels` (`requireAuth`, `requirePermission('channels:view')`) — список каналов с фильтром `status=all|active|archived` и `kind=all|paid|owned|earned`.
- `GET /app/channels/:id` (`requireAuth`, `requirePermission('channels:view')`) — карточка канала: паспорт, целевые CAC/ROMI, форма редактирования для `channels:manage`. Таблица кампаний и быстрая форма добавляются в T2; графики метрик — в M4.
- `POST /app/channels` (`requireAuth`, `requirePermission('channels:manage')`) — создание канала.
- `POST /app/channels/:id` (`requireAuth`, `requirePermission('channels:manage')`) — редактирование названия, типа, целевого CAC (BYN) и целевого ROMI (%).
- `POST /app/channels/:id/archive` (`requireAuth`, `requirePermission('channels:manage')`) — архивирование/реактивация.

**Files:**
- Create: `src/lib/money.js`, `src/lib/format.js`, `src/config/audit-actions.js`, `src/validators/channels.schema.js`, `src/repositories/channels.repo.js`, `src/services/channels.service.js`, `src/controllers/channels.controller.js`, `src/views/pages/channels.ejs`, `src/views/pages/channel-detail.ejs`
- Modify: `src/routes/app.routes.js` (убрать `channels` из `PLACEHOLDER_SECTIONS` и подключить реальные маршруты), `src/app.js` (собрать `createChannelsRepository(db)` и `createChannelsService(...)`, передать в `createAppRouter`), `public/css/app.css`, `tests/helpers/csrf.js` (`getAppCsrf`)
- Test: `tests/unit/money-csv.test.js`, `tests/integration/channels.test.js`

**Interfaces:**
- Consumes: `db` (аргумент фабрики, не глобальный `query`), `ValidationError`, `NotFoundError`, `requireAuth`, `requirePermission`, `auditService.record`.
- Produces:
  - `src/lib/money.js`: `parseBynToCents(input)` → `bigint` (принимает `'1 234,56'`, `'1234.56'`, `'50'`, бросает `ValidationError` на отрицательных, пустых, `NaN`, > 2 знаков после запятой); `centsFromDb(value)` → `bigint | null` (принимает `string | number | bigint` от `pg`, `null`/`undefined` → `null`, строку с точкой/запятой/мусором и нецелое число отвергает `TypeError`).
  - `src/lib/format.js`: `formatCentsToByn(value)` → `'1 234,56'` (принимает `bigint`, строку `pg` и `null` → `'—'`), `formatPercent(value, { signed })` (`+12,4%`, `−8,1%` с типографским минусом `U+2212`, принимает строку `pg`, `null` → `'—'`), `formatInteger(value)` (`12 345`).
  - `src/config/audit-actions.js`: `AUDIT_ACTIONS` (frozen) со всеми действиями M1+M2 (`AUTH_LOGIN: 'auth.login'`, `CHANNEL_CREATE: 'channel.create'`, `CHANNEL_UPDATE`, `CHANNEL_ARCHIVE`, `CHANNEL_RESTORE`, `CAMPAIGN_CREATE/UPDATE/DELETE`, `USER_CREATE`, `USER_ROLE_CHANGE: 'user.role_change'`, `USER_DEACTIVATE`, `USER_ACTIVATE`, `USER_PASSWORD_RESET`, `USER_PASSWORD_CHANGE`, `GOAL_CREATE/UPDATE/DELETE`, `IMPORT_RUN: 'import.run'`, `EXPORT_CSV: 'export.csv'`, `MEDIA_UPLOAD: 'media.upload'`); список значений — единственный источник для фильтра `/app/audit`.
  - `channelsRepo` (`createChannelsRepository(db)`): `listChannels({ onlyActive, kind })`, `findChannelById(id)`, `findChannelByCode(code)`, `createChannel({ code, name, kind, targetCacCents, targetRomiPct })`, `updateChannel(id, { name, kind, targetCacCents, targetRomiPct })`, `setChannelActive(id, isActive)`, `countActiveCampaigns(channelId)`.
  - `channelsService`: `listChannelsForView(filters)`, `getChannelDetail(id)`, `createChannel(input, actor)`, `updateChannel(id, input, actor)`, `toggleChannelArchive(id, isActive, actor)`.

- [ ] **Step 1: Написать падающий юнит-тест денег и форматирования**

`tests/unit/money-csv.test.js`:
- `parseBynToCents('1 234,56') === 123456n`, `parseBynToCents('45.5') === 4550n`, `parseBynToCents('0') === 0n`;
- `parseBynToCents('-10')`, `parseBynToCents('12,345')`, `parseBynToCents('abc')` бросают `ValidationError`;
- `centsFromDb('123456') === 123456n`, `centsFromDb(42) === 42n`, `centsFromDb(42n) === 42n`, `centsFromDb(null) === null`;
- `centsFromDb('12.5')`, `centsFromDb(12.5)`, `centsFromDb('abc')` бросают `TypeError`;
- `formatCentsToByn(123456n) === '1 234,56'`, `formatCentsToByn('123456') === '1 234,56'`, `formatCentsToByn(0n) === '0,00'`, `formatCentsToByn(null) === '—'`;
- `formatPercent('-8.1', { signed: true }) === '−8,1%'` (символ `\u2212`), `formatPercent(null) === '—'`.

- [ ] **Step 2: Запустить юнит-тест и убедиться в падении**

Run: `npx vitest run tests/unit/money-csv.test.js`
Expected: FAIL — `Cannot find module '../../src/lib/money.js'`.

- [ ] **Step 3: Реализовать `src/lib/money.js`, `src/lib/format.js` и `src/config/audit-actions.js`, добиться зелёного юнит-теста**

Никакого `parseFloat` при переводе в копейки: разбирать строку регулярным выражением `/^(\d+)(?:[.,](\d{1,2}))?$/` после удаления пробелов, неразрывных пробелов и суффикса `BYN`, собирать `BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'))`. `centsFromDb` — единственный мост из `pg`-строки в `bigint`; `format.js` использует его внутри и потому одинаково принимает и `bigint`, и строку. Модуль констант отдельным тестом не покрывается (тривиальные значения), это отмечается в отчёте задачи.

- [ ] **Step 4: Написать падающий интеграционный тест каналов**

`tests/integration/channels.test.js` (`beforeAll`: `resetTestDatabase(); await seed()`; `beforeEach`: новая `makeApp()` и `DELETE FROM sessions`; токен — `getAppCsrf(agent)`):
1. `GET /app/channels` под `viewer` → 200, содержит 8 демо-каналов и суммы в формате `45,00` + `<span class="byn">BYN</span>`, форма создания скрыта, текста «следующем этапе» нет;
2. `POST /app/channels` под `viewer` с валидным `_csrf` → 403 **styled** (`content-type: text/html`, «Недостаточно прав»);
3. `POST /app/channels` без `_csrf` под `analyst` → 403 `text/plain` с текстом `CSRF token mismatch` (это и есть CSRF-отказ семейства каналов);
4. `POST /app/channels` под `analyst` с `{ code: 'viber_ads', name: 'Viber Ads', kind: 'paid', targetCacByn: '38,50', targetRomiPct: '115' }` → 302 на `/app/channels`, в БД `target_cac_cents = 3850`, в `audit_log` запись `action = AUDIT_ACTIONS.CHANNEL_CREATE`;
5. `POST /app/channels` с дублирующимся `code: 'instagram'` или невалидным `code: 'Bad-Code!'` → 400, страница списка с текстом ошибки;
6. `POST /app/channels/:id/archive` для канала `instagram` (у которого есть активные кампании) → 400 с сообщением про активные кампании, `is_active` остаётся `true`;
7. `POST /app/channels/:id/archive` для созданного в тесте 4 канала `viber_ads` (кампаний нет) → 302, `is_active = false`, запись `channel.archive`; повторный POST → `is_active = true` и `channel.restore`;
8. XSS-проверка: создание канала с `name: '<script>alert(1)</script>'` сохраняет строку и на `GET /app/channels` отдаёт `&lt;script&gt;alert(1)&lt;/script&gt;`.

- [ ] **Step 5: Запустить интеграционный тест и убедиться в падении**

Run: `npx vitest run tests/integration/channels.test.js`
Expected: FAIL.

- [ ] **Step 6: Реализовать схему, репозиторий, сервис, контроллер и шаблоны `channels.ejs` / `channel-detail.ejs`**

В `channels.repo.js` список каналов возвращать одним SQL-запросом с `COUNT(cp.id)` всего и активных кампаний (`LEFT JOIN campaigns cp ON cp.channel_id = c.id GROUP BY c.id`), чтобы избежать N+1. При конфликте `UNIQUE(code)` (код PG `23505`) сервис бросает `ValidationError('Канал с таким кодом уже существует')`. В `src/app.js` добавить сборку репозитория и сервиса и расширить зависимости `createAppRouter`; в `app.routes.js` удалить `{ slug: 'channels' }` из `PLACEHOLDER_SECTIONS` **в том же изменении**, что добавляет реальные маршруты (иначе заглушка перехватит `/app/channels`). В `public/css/app.css` добавить общие для всех списков M2 классы: `.toolbar` (строка фильтров), `.filter-bar` (группа полей), `.row-actions` (иконки/кнопки в строке таблицы), `.pager`, `.inline-form`; только на токенах и hairline-границах, без inline-стилей.

- [ ] **Step 7: Прогнать тесты, проверить экран в браузере и закоммитить**

Run: `npx vitest run tests/unit/money-csv.test.js tests/integration/channels.test.js`
Expected: PASS.

Browser: `npm run dev`; войти как `analyst@metrika.by`, открыть `/app/channels`, создать канал через форму, проверить, что сумма выводится как `38,50` со знаком BYN, попытка архивировать `instagram` показывает русское сообщение; `agent-browser console` пуст; ширина 390 — горизонтального скролла нет.

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
- Modify: `src/routes/app.routes.js` (убрать `campaigns` из `PLACEHOLDER_SECTIONS`), `src/app.js` (сборка `createCampaignsRepository` / `createCampaignsService` и зависимости `createAppRouter`), `src/views/pages/channel-detail.ejs` (таблица кампаний канала и быстрая форма добавления — именно здесь, а не в T1), `public/css/app.css` (только если новым элементам не хватило `.toolbar`/`.inline-form` из T1)
- Test: `tests/integration/campaigns.test.js`

**Interfaces:**
- Consumes: `db`, `parseBynToCents`, `formatCentsToByn`, `channelsRepo.findChannelById`, `auditService.record`.
- Produces:
  - `campaignsRepo` (`createCampaignsRepository(db)`): `listCampaigns({ channelId, status, search })` (с `SUM(ds.spend_cents)` и `COUNT(ds.id)`), `findCampaignById(id)`, `findCampaignByCode(code)` (возвращает и `channelId`), `listCampaignsByChannel(channelId)`, `createCampaign({ channelId, code, name, status, startedOn, endedOn, budgetCents })`, `updateCampaign(id, fields)`, `getCampaignUsageCounts(id)` → `{ statsCount, ordersCount, touchpointsCount, customersCount }`, `deleteCampaignById(id)`.
  - `campaignsService`: `listCampaignsForView(filters)`, `createCampaign(input, actor)`, `updateCampaign(id, input, actor)`, `deleteCampaign(id, actor)`.

- [ ] **Step 1: Написать падающий интеграционный тест кампаний**

`tests/integration/campaigns.test.js` (та же схема `beforeAll` seed + `beforeEach` fresh app, что в T1):
1. `GET /app/campaigns?status=active` → 200, возвращает только активные кампании; фильтр `channelId` оставляет только кампании выбранного канала; текста «следующем этапе» нет;
2. `POST /app/campaigns` под `analyst` с валидными данными и `budgetByn: '5 000,00'` → 302, в БД `budget_cents = 500000`, запись `audit_log` `campaign.create`;
3. `POST /app/campaigns` с `endedOn < startedOn` или привязкой к архивному каналу → 400 `ValidationError`;
4. `POST /app/campaigns/:id/delete` для сидированной кампании (есть `daily_stats` и `orders`) → 400, кампания остаётся в БД;
5. `POST /app/campaigns/:id/delete` для только что созданной пустой кампании → 302, кампания удалена, в `audit_log` запись `campaign.delete`;
6. `POST /app/campaigns` под `viewer` с валидным `_csrf` → 403 styled; без `_csrf` под `analyst` → 403 `text/plain` (CSRF-отказ семейства кампаний);
7. `GET /app/channels/:id` показывает таблицу кампаний этого канала и быструю форму (кампании другого канала не попадают).

- [ ] **Step 2: Запустить тест и убедиться в падении**

Run: `npx vitest run tests/integration/campaigns.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать валидатор, репозиторий, сервис, контроллер и `campaigns.ejs`**

Проверка дат в Zod: `.refine(d => !d.endedOn || d.endedOn >= d.startedOn, 'Дата окончания не может быть раньше даты старта')`. Бюджет вводится в BYN, хранится в `budget_cents`. Из `app.routes.js` убрать `campaigns` из `PLACEHOLDER_SECTIONS` в том же изменении.

- [ ] **Step 4: Прогнать тесты, проверить экран в браузере и закоммитить**

Run: `npx vitest run tests/integration/campaigns.test.js`
Expected: PASS.

Browser: войти как `analyst`, открыть `/app/campaigns`, применить фильтры `status` и `channelId`, создать кампанию с бюджетом `1 500,00`, попробовать удалить сидированную кампанию — сообщение про статистику, консоль пуста, мобильная ширина проверена.

Commit: `feat: add campaigns crud with filters and data integrity delete guard`

---

### Task 3: Администрирование пользователей, профиль и журнал аудита (BO-14, BO-15)

**Правила:**
- Только роль `admin` (`users:manage`) управляет пользователями и видит `/app/audit` (`audit:view`).
- Создание пользователя: `email`, `fullName`, `role` (`admin|analyst|viewer`), временный пароль (≥ 10 символов, хешируется `@node-rs/argon2`).
- Сброс пароля администратором устанавливает новый временный пароль (≥ 10 символов) и инвалидирует активные сессии этого пользователя в таблице `sessions` (`DELETE FROM sessions WHERE (sess->'user'->>'id')::bigint = $1`).
- Деактивация (`is_active = false`) также немедленно удаляет сессии пользователя из `sessions`.
- **Смена роли тоже отзывает сессии.** Иначе понижённый администратор продолжает ходить с ролью `admin` в `sess->'user'->'role'` до истечения TTL. После `updateUserRole` сервис вызывает `deleteUserSessions(targetId)`; старая cookie становится недействительной, следующий запрос уходит на `/login`, а после повторного входа роль читается заново из БД и `/app/admin/users` отдаёт styled 403.
- **Запрет самоблокировки и самопонижения:** если `targetUserId === actor.id`, нельзя сделать `is_active = false` и нельзя сменить собственную роль с `admin` на другую (`ValidationError('Нельзя заблокировать собственную учётную запись или снять с себя роль администратора')`).
- Любой авторизованный пользователь на `/app/profile` может сменить собственный пароль (введя текущий и новый ≥ 10 символов).
- Отдельной ветки для `MemoryStore` нет: тесты используют настоящий PgStore, отзыв доказывается удалением строк из `sessions`. Повторная проверка пользователя в `requireAuth` на каждом запросе не добавляется — это лишний индексированный запрос на каждый рендер; решение фиксируется в `IMPROVEMENTS.md`.

**Маршруты:**
- `GET /app/admin/users` (`requirePermission('users:manage')`) — таблица пользователей, форма создания, действия смены роли, блокировки и сброса пароля.
- `POST /app/admin/users` (`requirePermission('users:manage')`) — создание пользователя.
- `POST /app/admin/users/:id/role` (`requirePermission('users:manage')`) — смена роли.
- `POST /app/admin/users/:id/toggle-active` (`requirePermission('users:manage')`) — блокировка/разблокировка.
- `POST /app/admin/users/:id/reset-password` (`requirePermission('users:manage')`) — сброс пароля.
- `GET /app/audit` (`requirePermission('audit:view')`) — журнал аудита с фильтрами `entity`, `userId`, `action` и пагинацией по 50 записей; список действий в фильтре берётся из `AUDIT_ACTIONS`.
- `GET /app/profile`, `POST /app/profile/password` (`requireAuth`) — профиль и смена своего пароля.

**Files:**
- Create: `src/validators/users.schema.js`, `src/services/users.service.js`, `src/views/pages/audit.ejs`, `src/views/pages/profile.ejs`
- Modify: `src/repositories/users.repo.js`, `src/repositories/audit.repo.js`, `src/services/audit.service.js`, `src/controllers/admin.controller.js`, `src/controllers/auth.controller.js` (перевести литералы `auth.login`/`auth.logout` на `AUDIT_ACTIONS`), `src/views/pages/admin-users.ejs`, `src/routes/app.routes.js` (убрать `profile` из `PLACEHOLDER_SECTIONS` и явную заглушку `/audit`), `src/app.js` (собрать `createUsersService`/`createAuditService`, передать в `createAppRouter` и `createAdminController`), `tests/integration/rbac.test.js`, `IMPROVEMENTS.md`
- Test: `tests/integration/users-admin.test.js`

**Interfaces:**
- Consumes: `db`, `@node-rs/argon2` (`hash`, `verify`), `auditService.record`, `AUDIT_ACTIONS`. Транзакция не нужна: смена роли и удаление сессий идемпотентны по отдельности, а `deleteUserSessions` вызывается после успешного `UPDATE`.
- Produces:
  - `usersRepo`: `findById(id)` (**новый**, возвращает `mapUser` вместе с `passwordHash`), `listForAdmin()` (**существующий M1, переиспользуется, второй метод `listUsers` не создаётся**), `createUser({ email, passwordHash, fullName, role })`, `updateUserRole(id, role)`, `setUserActive(id, isActive)`, `updateUserPasswordHash(id, passwordHash)`, `deleteUserSessions(userId)`.
  - `usersService`: `listUsersForView()`, `createUser(input, actor)`, `changeUserRole(targetId, role, actor)`, `toggleUserActive(targetId, isActive, actor)`, `resetUserPassword(targetId, newPassword, actor)`, `changeOwnPassword(userId, { currentPassword, newPassword }, ip)`.
  - `auditRepo` (единственный контракт чтения, без второго варианта имён): `list({ filters, limit, offset })`, `count(filters)`; JOIN с `users` для `user_email`, без раскрытия секретов в `payload`.
  - `auditService.listAuditEntries(filters)` → `{ entries, total, page, pageSize, filters }` для шаблона.

- [ ] **Step 1: Написать падающий интеграционный тест управления пользователями и аудита**

`tests/integration/users-admin.test.js` (токены — `getAppCsrf`; каждый POST — с валидным `_csrf`, если тест не проверяет отказ):
1. `POST /app/admin/users` под `admin` создаёт `junior@metrika.by` с ролью `analyst` и паролем `TempPass2026!`; новый пользователь успешно входит через `POST /login`; `/app/admin/users` больше не содержит «следующем этапе»;
2. дубль email в другом регистре `JUNIOR@metrika.by` или пароль короче 10 символов → 400 `ValidationError`;
3. `POST /app/admin/users` под `viewer` → 403 styled; без `_csrf` под `admin` → 403 `text/plain` (CSRF-отказ семейства пользователей);
4. админ повышает `junior` до `admin`; `junior` входит отдельным агентом и получает 200 на `/app/admin/users`; затем админ понижает `junior` до `viewer` → **сессия junior удалена**, его прежняя cookie на `GET /app/admin/users` получает 302 `/login`; после повторного входа под `viewer` тот же URL отдаёт styled 403 (`text/html`, «Недостаточно прав»);
5. `POST /app/admin/users/:adminId/toggle-active` (попытка админа деактивировать самого себя) → 400, админ остаётся активным;
6. `POST /app/admin/users/:adminId/role` (попытка админа сменить себе роль на `viewer`) → 400;
7. деактивация `junior` удаляет его сессию: уже залогиненный агент `junior` на следующем `GET /app/dashboard` получает 302 `/login`;
8. сброс пароля `junior` админом позволяет войти только с новым паролем; в `audit_log` никогда не попадает открытый пароль или хеш (`JSON.stringify(row.payload)` не содержит `TempPass`);
9. `GET /app/audit?entity=user` под `admin` → 200, отображает `user.create`, `user.role_change`, `user.deactivate`, `user.password_reset`; под `analyst` → 403; `/app/profile` под `viewer` → 200 и не содержит «следующем этапе».

- [ ] **Step 2: Запустить тест и убедиться в падении**

Run: `npx vitest run tests/integration/users-admin.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать схемы, методы репозитория, `users.service.js`, контроллеры и шаблоны `admin-users.ejs`, `audit.ejs`, `profile.ejs`**

`changeUserRole` и `resetUserPassword`/`toggleUserActive` вызывают `deleteUserSessions(targetId)` в том же обработчике. `requireAuth` из M1 **не меняется**: источник истины — таблица `sessions`, и любое изменение привилегий её очищает. Никаких `MemoryStore`-веток в коде и тестах. В `app.routes.js` удалить заглушки `profile` и `/audit`, в `rbac.test.js` обновить проверку списка пользователей (три строки данных в `<tbody>` сохраняются) и убрать ожидания заглушек. В `IMPROVEMENTS.md` записать: «повторная валидация `users.is_active`/`role` на каждом запросе не реализована; при необходимости добавить один индексированный `SELECT` в `requireAuth`».

- [ ] **Step 4: Прогнать тесты, проверить экран в браузере и закоммитить**

Run: `npx vitest run tests/integration/users-admin.test.js tests/integration/rbac.test.js`
Expected: PASS.

Browser: под `admin` создать пользователя, сменить роль, заблокировать; под созданным пользователем убедиться, что доступ пропал; открыть `/app/audit`, применить фильтр по действию; консоль пуста.

Commit: `feat: add user administration, session revocation and audit log viewer`

---

### Task 4: Цели и плановые показатели (CRUD, правила пересечения периодов, валидация — BO-10)

**Правила:**
- Согласно таблице прав (`assignment-traceability.md` §2: «Каналы, кампании, цели: admin +, analyst +, viewer −») просмотр `/app/goals` доступен всем (`goals:view`), создание/редактирование/удаление — ролям `admin` и `analyst` (`goals:manage`).
- Поля цели (`goals`): `metric` (`'cac' | 'romi' | 'ltv_cac' | 'payback' | 'new_customers'`), `channel_id` (`NULL` = глобальная blended-цель по всей компании, иначе FK на `channels.id`), `target_value`, `period_start`, `period_end` (`period_end >= period_start`).
- **Единица `goals.target_value` — документированное исключение из правила «деньги в копейках».** Колонка остаётся `NUMERIC(14,2)`, потому что хранит разные единицы: для `cac` — BYN (`50.00`), для `romi` — проценты, для `ltv_cac` — коэффициент, для `payback` — месяцы, для `new_customers` — целое. Отдельная колонка `target_value_cents` покрывала бы только одну метрику из пяти и потребовала бы второго поля для остальных, поэтому миграция не делается. Компенсация: ввод `cac` проходит через `parseBynToCents` и обратно в NUMERIC, сравнение с фактом в M3 идёт через `parseBynToCents` от строки из БД (никакого float), а исключение фиксируется в `IMPROVEMENTS.md` со ссылкой на этот пункт.
- **Правило запрета пересечения периодов (overlap rule):** для одной и той же пары `(metric, COALESCE(channel_id, 0))` не может существовать двух целей, чьи интервалы `[period_start, period_end]` пересекаются (`existing.period_start <= new.period_end AND existing.period_end >= new.period_start`). Перед `INSERT`/`UPDATE` сервис проверяет пересечение и при наличии конфликта бросает `ValidationError('Для этой метрики и канала уже задана цель на пересекающийся период')`; запрос использует `channel_id IS NOT DISTINCT FROM $2` и индекс из `002_m2_data.sql`.

**Маршруты:**
- `GET /app/goals` (`requirePermission('goals:view')`) — список целей с фильтром по каналу и метрике (факт/план/отклонение появится в M5 после движка метрик M3; в M2 отображаются плановые значения, период и статус «активна на отчётную дату» по `dataAnchor`).
- `POST /app/goals` (`requirePermission('goals:manage')`) — создание цели.
- `POST /app/goals/:id` (`requirePermission('goals:manage')`) — обновление `target_value` и дат периода.
- `POST /app/goals/:id/delete` (`requirePermission('goals:manage')`) — удаление цели.

**Files:**
- Create: `src/validators/goals.schema.js`, `src/repositories/goals.repo.js`, `src/services/goals.service.js`, `src/controllers/goals.controller.js`, `src/views/pages/goals.ejs`
- Modify: `src/routes/app.routes.js` (убрать `goals` из `PLACEHOLDER_SECTIONS`), `src/app.js` (собрать `createGoalsRepository`/`createGoalsService` и передать в `createAppRouter`), `IMPROVEMENTS.md`
- Test: `tests/integration/goals.test.js`

**Interfaces:**
- Consumes: `db`, `getDataAnchor`, `parseBynToCents` (только для метрики `cac`), `auditService.record`, `AUDIT_ACTIONS`.
- Produces:
  - `goalsRepo` (`createGoalsRepository(db)`): `listGoals({ channelId, metric })`, `findGoalById(id)`, `findOverlappingGoal({ metric, channelId, periodStart, periodEnd, excludeId })`, `createGoal({ metric, channelId, targetValue, periodStart, periodEnd, createdBy })`, `updateGoal(id, { targetValue, periodStart, periodEnd })`, `deleteGoal(id)`.
  - `goalsService`: `listGoalsForView(filters)`, `createGoal(input, actor)`, `updateGoal(id, input, actor)`, `deleteGoal(id, actor)`.

- [ ] **Step 1: Написать падающий интеграционный тест целей**

`tests/integration/goals.test.js`:
1. `GET /app/goals` под `viewer` → 200, отображает сидированные глобальные цели, текста «следующем этапе» нет;
2. `POST /app/goals` под `analyst` создаёт цель для канала `instagram` (`metric: 'cac'`, `targetValue: '42,50'`, `periodStart: '2026-12-01'`, `periodEnd: '2026-12-31'`) → 302, запись `audit_log` `goal.create`, в БД `target_value = 42.50`;
3. `POST /app/goals` для того же канала и метрики с пересекающимся периодом `'2026-12-15' .. '2027-01-15'` → 400 с текстом о пересечении периодов;
4. `POST /app/goals` для того же канала и метрики на непересекающийся период `'2027-01-01' .. '2027-01-31'` → 302;
5. `POST /app/goals` с `periodEnd < periodStart` или отрицательным `targetValue` → 400; `new_customers` с `'2,5'` → 400 (нужно целое); под `viewer` с валидным `_csrf` → 403 styled, без `_csrf` → 403 `text/plain` (CSRF-отказ семейства целей);
6. `POST /app/goals/:id/delete` под `viewer` → 403; под `analyst` → 302, цель удалена.

- [ ] **Step 2: Запустить тест и убедиться в падении**

Run: `npx vitest run tests/integration/goals.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать валидатор, репозиторий, сервис, контроллер и `goals.ejs`**

В `goals.schema.js` принимать числа как с запятой, так и с точкой (`'42,50'` → `42.5`), для `new_customers` требовать целое число (`Number.isInteger`). Из `app.routes.js` убрать `goals` из `PLACEHOLDER_SECTIONS`.

- [ ] **Step 4: Прогнать тесты, проверить экран в браузере и закоммитить**

Run: `npx vitest run tests/integration/goals.test.js`
Expected: PASS.

Browser: под `analyst` создать цель, получить сообщение о пересечении при повторной попытке, удалить цель; консоль пуста.

Commit: `feat: add goals crud with period overlap validation`

---

### Task 5: Инфраструктура импорта CSV (4 типа, dry-run, атомарная транзакция, шаблоны, отчёт ошибок — BO-11)

**Спецификация CSV (строго по `2026-11-21-metrics-spec.md` §8):**
- Кодировка UTF-8 (опциональный BOM `\uFEFF` в начале файла срезается), разделитель `;`, десятичный разделитель сумм — запятая или точка (`1 234,56` или `1234.56`). Строки режутся по `\n` и `\r\n`: символ `\r` удаляется, чтобы файл, сохранённый Excel на Windows, не давал `\r` в последней колонке. Поле в кавычках может содержать `;` и `""`; многострочных полей нет.
- Лимиты: размер файла **≤ 2 МБ** (`2 * 1024 * 1024` байт), число строк данных (без заголовка) **≤ 10 000**, имя файла санитизируется (`basename`, удаление управляющих символов, обрезка до 120 символов).
- Rate-limit на импорт: `createImportRateLimiter()` — не более 20 запросов за 15 минут **на пользователя** (`keyGenerator` по `req.session.user.id`, fallback `req.ip`). Лимитер создаётся внутри `createApiRouter`, то есть на каждое приложение своё хранилище; модульного singleton нет, тестам не нужен ручной сброс. Ответ лимитера — JSON 429 с русским текстом «Слишком много импортов. Попробуйте снова через 15 минут.»
- Обязательные колонки и ключи дедупликации по типам (`kind`):

| `kind` | Обязательные колонки (заголовок `;`) | Дедупликация и правила связности |
|---|---|---|
| `daily_stats` | `campaign_code;stat_date;impressions;clicks;leads;spend` | Ключ `(campaign_id, stat_date)` — **обновление** (`ON CONFLICT (campaign_id, stat_date) DO UPDATE`). `campaign_code` обязан существовать в `campaigns`, иначе ошибка строки. `spend` в BYN → `spend_cents`. |
| `customers` | `external_id;first_channel_code;first_campaign_code;first_order_at` | Ключ `external_id` — **пропуск** (`ON CONFLICT (external_id) DO NOTHING`, помечается как `duplicate`). `first_channel_code` обязателен и должен существовать; `first_campaign_code` может быть пустым, но если задан — должен существовать и принадлежать этому каналу. `acquired_at` = `COALESCE(first_order_at, now())`. |
| `touchpoints` | `customer_external_id;channel_code;campaign_code;occurred_at;kind` | Ключ `(customer_id, occurred_at, channel_id)` — **пропуск** дубля (`ON CONFLICT (customer_id, occurred_at, channel_id) DO NOTHING`, требует уникального индекса из `002_m2_data.sql`). `customer_external_id` и `channel_code` обязаны существовать; `kind` ∈ `click\|impression\|visit`. Если у клиента `first_order_at IS NULL` и касание раньше `acquired_at`, сервис сдвигает `acquired_at` (`LEAST`). Ветки «если `first_channel_id` ещё не задан» нет: колонка `NOT NULL`, импортированный клиент всегда имеет `first_channel_code`. |
| `orders` | `external_id;customer_external_id;campaign_code;occurred_at;revenue;margin` | Ключ `external_id` — **пропуск** дубля. `customer_external_id` обязан существовать (заказ без клиента — ошибка строки). `revenue` и `margin` в BYN → `revenue_cents`, `margin_cents`; `margin >= 0` и `margin <= revenue`, иначе ошибка строки. Если у клиента `first_order_at IS NULL` или `occurred_at < first_order_at`, обновляется `first_order_at`. |

- Временные метки (`occurred_at`, `first_order_at`) принимаются только в ISO-8601 с явным смещением (`2026-11-05T10:00:00+03:00` или `Z`); «локальное время без зоны» — ошибка строки, а не догадка сервера.
- Лишние колонки в заголовке не блокируют импорт, но возвращаются в `warnings: string[]`. Отсутствие любой обязательной колонки отклоняет весь файл сразу (400).
- **Контракт ответа `POST /api/v1/import`** (JSON всегда, потому что маршрут под `/api/*`):
  ```json
  {
    "kind": "orders",
    "dryRun": false,
    "committed": true,
    "batchId": 12,
    "rowsTotal": 10,
    "rowsOk": 9,
    "rowsDuplicate": 0,
    "rowsFailed": 1,
    "warnings": [],
    "errors": [{ "row": 3, "field": "customer_external_id", "message": "Клиент не найден" }],
    "wouldCommit": null
  }
  ```
  Правила: `row` — 1-based номер строки файла (первая строка данных = 2); `batchId: null` только при `dryRun: true`; боевой импорт, в том числе отклонённый по порогу, возвращает `batchId` сохранённого пакета (`committed: false`), чтобы отчёт был доступен по ссылке; `dryRun: true` → `committed: false`, `wouldCommit: <boolean>`; боевой импорт → `wouldCommit: null`; `rowsOk + rowsDuplicate + rowsFailed === rowsTotal`. Отказ уровня файла (нет обязательной колонки, пустой файл, > 10 000 строк, нечитаемый CSV, неизвестный `kind`) — 400 `ValidationError` в JSON-контракте; превышение размера — 413; нет прав — 403 JSON; нет CSRF — 403 JSON. HTML-view-model для импорта не существует (см. «Механика CSRF и загрузок»).
- **Правило 10% и атомарность (целочисленная арифметика, без деления):** сначала файл парсится и валидируется по типам полей (без БД), затем внутри одной транзакции резолвятся коды каналов/кампаний/клиентов. `rowsFailed` считается только по ошибкам строк (дубли не ошибки).
  - Если вызван режим `dryRun = true`: в БД ничего не пишется, возвращается отчёт с `wouldCommit: rowsFailed * 10 <= rowsTotal`.
  - Если `dryRun = false`:
    - при `rowsTotal === 0` → 400 `ValidationError('Файл не содержит строк данных')` в обоих режимах;
    - при `rowsFailed * 10 > rowsTotal` (ошибок больше 10%) — **ни одна валидная строка не применяется**, но в `import_batches` в той же транзакции сохраняется запись с `rows_total`, `rows_ok` (число валидных строк), `rows_duplicate`, `rows_failed`, `committed = false`, `errors` JSONB и запись `audit_log` `import.run` с `{ committed: false }` (постоянная ссылка на отчёт); `batchId` пакета возвращается в ответе;
    - при `rowsFailed * 10 <= rowsTotal` — все валидные строки применяются, в той же транзакции создаются `import_batches` и `audit_log` `import.run` с `{ committed: true }`.

**Маршруты:**
- `GET /app/import` (`requirePermission('import:run')`) — страница загрузки CSV (выбор `kind`, чекбокс «Только проверить без сохранения (dry-run)», ссылки на 4 шаблона, таблица последних 20 `import_batches`).
- `GET /app/import/templates/:kind.csv` (`requirePermission('import:run')`) — скачивание эталонного CSV-шаблона с BOM, заголовком и 2 примерами строк для каждого из 4 типов.
- `POST /api/v1/import` (`requireAuth`, `requirePermission('import:run')`, `importLimiter`, `uploadCsv` = multer single `'file'` + маппинг ошибок) — dry-run или боевой импорт; ответ JSON по контракту выше.
- `GET /app/import/batches/:id` (`requirePermission('import:run')`) — детальный отчёт по пакету импорта с таблицей ошибок по строкам.

**Files:**
- Modify: `package.json` (`npm i multer@^2.0.0`), `src/middleware/rateLimit.js` (`createImportRateLimiter`), `src/middleware/auth.js` и `src/middleware/errors.js` (`isApiRequest` по `req.originalUrl`), `src/lib/db.js` (`withTransaction(db, fn)`), `src/app.js` (JSDoc `db` требует `connect`, монтаж `/api/v1`), `src/routes/app.routes.js` (убрать явную заглушку `/import`), `public/css/app.css` (`.file-input`, `.upload-status`, `.noscript-note`), `tests/integration/rbac.test.js` (заменить ожидание заглушки импорта)
- Create: `db/migrations/002_m2_data.sql`, `src/lib/csv.js`, `src/middleware/upload.js`, `src/validators/import.schema.js`, `src/repositories/import.repo.js`, `src/services/import.service.js`, `src/controllers/import.controller.js`, `src/routes/api.routes.js`, `src/views/pages/import.ejs`, `src/views/pages/import-batch.ejs`, `public/js/upload-form.js`
- Test: `tests/unit/import-validators.test.js`, `tests/integration/import.test.js`

**Миграция `db/migrations/002_m2_data.sql` (содержимое фиксировано):**
```sql
-- Точные дубли касаний (тот же клиент, момент и канал) удаляются до создания ключа: они и есть те строки,
-- которые импорт обязан считать дублями. Остальные данные не трогаются.
DELETE FROM touchpoints t
USING touchpoints d
WHERE t.id > d.id
  AND t.customer_id = d.customer_id
  AND t.occurred_at = d.occurred_at
  AND t.channel_id = d.channel_id;

CREATE UNIQUE INDEX touchpoints_dedup_idx ON touchpoints (customer_id, occurred_at, channel_id);

ALTER TABLE import_batches
  ADD COLUMN rows_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (rows_duplicate >= 0);

CREATE INDEX goals_metric_channel_idx ON goals (metric, channel_id, period_start);
```
Существующий стенд после миграции не требует reseed, но `npm test` и `npm run seed` прогоняются заново (см. T8).

**Interfaces:**
- Consumes: `db` (пул), `withTransaction(db, fn)`, `parseBynToCents`, `auditService.record`, `AUDIT_ACTIONS`, `createChannelsRepository`, `createCampaignsRepository`.
- Produces:
  - `src/lib/db.js`: `withTransaction(db, fn)` — `fn(client)` в `BEGIN/COMMIT/ROLLBACK` на пуле, переданном приложением (тестовый пул не смешивается с dev-пулом).
  - `src/lib/csv.js`: `parseCsv(bufferOrString, { delimiter = ';', maxRows = 10000 })` → `{ headers: string[], rows: Array<{ rowNumber: number, values: Record<string, string> }> }` (срезает BOM, нормализует `\r\n`, понимает кавычки); `stringifyCsv(headers, rows, { withBom = true })` → `string`.
  - `src/middleware/upload.js`: `createCsvUploader()` → `[multer.single('file'), mapMulterErrors]`; `createImageUploader()` (T7) использует тот же маппинг. `LIMIT_FILE_SIZE` → `AppError('Файл превышает допустимый размер 2 МБ', { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' })`, `LIMIT_UNEXPECTED_FILE` → `ValidationError('Неожиданное поле файла: ожидается «file»')`, остальные `MulterError` → 400 `ValidationError`.
  - `importRepo` (**создаётся с `client` внутри транзакции**: `createImportRepository(client)`): `insertBatch({ kind, filename, createdBy, rowsTotal, rowsOk, rowsDuplicate, rowsFailed, errors })`, `listRecentBatches(limit)`, `findBatchById(id)`, `insertDailyStatsRow(row)`, `insertCustomerRow(row)`, `insertTouchpointRow(row)`, `insertOrderRow(row)`, `moveCustomerAcquiredAt(customerId, occurredAt)`, `setCustomerFirstOrderAt(customerId, occurredAt)`.
  - `importService.runImport({ kind, filename, buffer, dryRun, actor, ip })` → объект контракта выше. Внутри транзакции создаёт `createImportRepository(client)` и `createAuditService({ auditRepository: createAuditRepository(client) })` — **пуловые репозитории внутрь транзакции не передаются**, иначе `import_batches`/`audit_log` записались бы вне её.
  - `importService.getTemplateCsv(kind)` → `{ filename, content }`.

SQL дедупликации (параметризованный, фиксирован в репозитории):
```sql
INSERT INTO daily_stats (campaign_id, stat_date, impressions, clicks, leads, spend_cents)
VALUES ($1,$2,$3,$4,$5,$6)
ON CONFLICT (campaign_id, stat_date) DO UPDATE
SET impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
    leads = EXCLUDED.leads, spend_cents = EXCLUDED.spend_cents
RETURNING id;

INSERT INTO customers (external_id, first_channel_id, first_campaign_id, acquired_at, first_order_at)
VALUES ($1,$2,$3,$4,$5) ON CONFLICT (external_id) DO NOTHING RETURNING id;

INSERT INTO touchpoints (customer_id, channel_id, campaign_id, occurred_at, kind)
VALUES ($1,$2,$3,$4,$5) ON CONFLICT (customer_id, occurred_at, channel_id) DO NOTHING RETURNING id;

INSERT INTO orders (external_id, customer_id, campaign_id, occurred_at, revenue_cents, margin_cents)
VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (external_id) DO NOTHING RETURNING id;
```
`rowCount === 0` трактуется как `duplicate`; для `daily_stats` `rowCount` всегда 1.

- [ ] **Step 1: Установить `multer` и написать падающие юнит-тесты CSV-парсера и валидаторов строк**

```bash
npm i multer@^2.0.0
```
В `tests/unit/import-validators.test.js` проверить:
1. `parseCsv` корректно срезает UTF-8 BOM `\uFEFF`, разбирает `;`, кавычки и возвращает `rowNumber: 2` для первой строки данных;
2. `parseCsv` принимает CRLF: файл `'a;b\r\n1;2\r\n'` даёт `values.b === '2'` без `\r`; поле в кавычках `"Минск; центр"` остаётся одним значением с `;` внутри;
3. `parseCsv` бросает `ValidationError('Превышен лимит 10 000 строк')` на 10 001 строке;
4. валидатор строки `orders` отклоняет `margin > revenue`, отрицательную сумму и `occurred_at` без смещения;
5. валидатор `daily_stats` принимает `spend: '1 200,50'` и возвращает `spendCents: 120050n`;
6. неизвестные лишние колонки возвращаются в `warnings`, а отсутствие обязательной колонки `spend` бросает `ValidationError`.

- [ ] **Step 2: Запустить юнит-тест и убедиться в падении**

Run: `npx vitest run tests/unit/import-validators.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать `src/lib/csv.js`, `src/middleware/upload.js` и `src/validators/import.schema.js`, добиться зелёного юнит-теста**

Run: `npx vitest run tests/unit/import-validators.test.js`
Expected: PASS.

- [ ] **Step 4: Написать падающий интеграционный тест импорта всех 4 типов и граничных условий**

`tests/integration/import.test.js` — **схема БД без скрытых зависимостей от порядка**: `beforeAll`: `resetTestDatabase()`, `await seed()` один раз; `beforeEach`: `DELETE FROM import_batches; DELETE FROM audit_log;` и каждая строка теста пишет собственные идентификаторы с префиксом имени теста (`m2_dry_`, `m2_batch_`, `m2_dup_`), поэтому проверки не зависят от строк, созданных другими тестами; `test 2` сравнивает `COUNT(*)` до и после вызова. Каждый тест, которому нужны клиенты, импортирует их сам в этом же тесте. Никаких прогонов через `zerna_customer_0001` из сида и никаких ссылок на строки, созданные другим тестом.

Запросы — настоящий multipart: `.attach('file', Buffer.from(csv), 'x.csv')` + `.set('X-CSRF-Token', token)`; токен `getAppCsrf(agent)`.

1. `GET /app/import/templates/daily_stats.csv` → 200, `text/csv`, начинается с `\uFEFFcampaign_code;stat_date;impressions;clicks;leads;spend`;
2. `POST /api/v1/import` (`kind=daily_stats`, `dryRun=true`) с 3 валидными строками → 200 JSON, `rowsOk: 3`, `batchId: null`, `committed: false`, `wouldCommit: true`; `COUNT(*)` в `daily_stats`, `import_batches` и `audit_log` не изменился;
3. боевой импорт `daily_stats`: первым вызовом вставляется 1 строка теста, вторым — файл с той же парой `(campaign_id, stat_date)` и 2 новыми датами → второй вызов даёт `committed: true`, `rowsOk: 3`, `batchId` число, обновлён `spend_cents` существующей даты, вставлены 2 новые, созданы `import_batches` (с `rows_duplicate = 0`) и `audit_log` `import.run`;
4. боевой импорт `customers`: файл из 3 строк, где две — уникальные новые `m2_batch_c1/c2`, третья повторяет `m2_batch_c1` (`ON CONFLICT` внутри того же INSERT) → `rowsOk: 2`, `rowsDuplicate: 1`, `rowsFailed: 0`;
5. боевой импорт `touchpoints` и `orders` для клиентов, импортированных в этом же тесте → записи вставлены; повторная отправка того же файла даёт `rowsDuplicate` больше нуля и не создаёт дублей в БД (для `touchpoints` работает уникальный ключ из `002_m2_data.sql`);
6. **атомарность (порог 10%):** файл `orders` из **5 строк**, из них 1 строка с `margin > revenue` (= 20% > 10%), остальные 4 валидны → `committed: false`, `batchId` — число, `rowsOk: 4`, `rowsFailed: 1`, валидные заказы **не появились** в `orders`, в `import_batches` записано `rows_ok = 4, rows_duplicate = 0, rows_failed = 1, committed = false`, `errors[0].row === 3`; отчёт `/app/import/batches/:id` показывает «Импорт отклонён»;
7. граница 10%: тест сначала импортирует 9 собственных клиентов `m2_edge_*`, затем файл из 10 строк `orders` — 9 валидны и 1 с несуществующим `customer_external_id` (10% ≤ 10%) → `committed: true`, `rowsOk: 9`, `rowsFailed: 1`, 9 заказов в БД;
8. **откат по инъецированной ошибке:** тест создаёт функцию `raise_on_audit()` (бросает исключение) и триггер
   `CREATE TRIGGER inject_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION raise_on_audit()`, запускает валидный импорт → 500 JSON, затем удаляет триггер и функцию и проверяет: строк этого импорта в `orders` нет, новой строки в `import_batches` нет, новых строк `audit_log` нет (всё откатилось одной транзакцией);
9. пустой файл (только заголовок) → 400 `ValidationError('Файл не содержит строк данных')` и при `dryRun=true`, и при `dryRun=false`;
10. загрузка буфера 2.1 МБ → 413 JSON «Файл превышает допустимый размер 2 МБ»;
11. `POST /api/v1/import` без `X-CSRF-Token` → 403 JSON `FORBIDDEN` (CSRF-отказ семейства загрузок); с заголовком и валидным файлом → не 403 (доказывает, что механизм работает);
12. `POST /api/v1/import` под `viewer` с валидным токеном → 403 JSON `FORBIDDEN` (styled HTML на API быть не должно).

- [ ] **Step 5: Запустить интеграционный тест и убедиться в падении**

Run: `npx vitest run tests/integration/import.test.js`
Expected: FAIL.

- [ ] **Step 6: Реализовать миграцию, `import.repo.js`, `import.service.js`, `import.controller.js`, `api.routes.js` и шаблоны**

Порядок внутри `runImport`: (1) парсинг и валидация полей без БД; (2) `withTransaction(db, ...)`: резолв кодов и расчёт финального `rowsFailed`; (3) решение по `rowsFailed * 10 <= rowsTotal`; (4) вставка строк + `import_batches` + `audit_log` либо только `import_batches` + `audit_log` с `committed = false` и счётчиками разобранного файла; (5) возврат контракта. `importLimiter` создаётся внутри `createApiRouter` (`createImportRateLimiter()`), там же навешивается на `POST /import`; в `app.js` добавить `app.use('/api/v1', createApiRouter({ ... }))` **после** `csrfProtection`. В `app.routes.js` удалить явную заглушку `/import`. В `middleware/auth.js` и `middleware/errors.js` перевести `isApiRequest` на `req.originalUrl` (иначе `requirePermission` и `errorHandler` внутри `/api/v1` отрисуют HTML вместо JSON). В `public/css/app.css` добавить `.file-input` (видимый input, стилизованный под hairline-кнопку), `.upload-status` (белая карточка с `--shadow-card`) и `.noscript-note`. Имя файла санитизировать функцией `sanitizeFilename(raw)`.

- [ ] **Step 7: Прогнать тесты, проверить экран в браузере и закоммитить**

Run: `npx vitest run tests/unit/import-validators.test.js tests/integration/import.test.js tests/integration/rbac.test.js`
Expected: PASS.

Browser: под `analyst` открыть `/app/import`, выбрать файл через настоящий input, отправить dry-run и боевой импорт, увидеть отчёт с числами и ссылкой на пакет, открыть `/app/import/batches/:id`; консоль пуста; 390 — таблица скроллится внутри `.table-wrap`.

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
- Каждый вызов экспорта пишет в `audit_log`: `action: AUDIT_ACTIONS.EXPORT_CSV`, `entity: dataset`, `payload: { filters, rowsCount }`.

**Маршруты:**
- `GET /app/export/:dataset.csv` (`requireAuth`, `requirePermission('export')`) — скачивание CSV с query-фильтрами текущего экрана. На страницах `channels.ejs` и `campaigns.ejs` добавить ghost-кнопку «Экспорт CSV», передающую текущие query-параметры. Это safe-метод, CSRF не нужен.

**Files:**
- Create: `src/repositories/export.repo.js`, `src/services/export.service.js`, `src/controllers/export.controller.js`
- Modify: `src/lib/csv.js` (защита от formula injection), `src/routes/app.routes.js`, `src/app.js` (собрать `createExportRepository`/`createExportService`), `src/views/pages/channels.ejs`, `src/views/pages/campaigns.ejs`
- Test: `tests/integration/export.test.js`

**Interfaces:**
- Consumes: `db`, `stringifyCsv`, `centsFromDb`, `getDataAnchor`, `auditService.record`, `AUDIT_ACTIONS`.
- Produces: `exportService.exportDataset({ dataset, filters, actor })` → `{ filename, csvContent, rowsCount }`.

- [ ] **Step 1: Написать падающий интеграционный тест экспорта**

`tests/integration/export.test.js`:
1. `GET /app/export/channels.csv?kind=paid` под `viewer` → 200, `content-type` содержит `text/csv`, `content-disposition` содержит `attachment; filename="metrika-channels-`, тело начинается с `\uFEFFcode;name;kind;`, в выдаче только `paid`-каналы (6 из 8);
2. `GET /app/export/campaigns.csv?status=finished` → содержит только завершённые кампании;
3. `GET /app/export/daily_stats.csv?from=<anchor−9>&to=<anchor>` (границы берутся от `getDataAnchor()`, а не от литеральных дат 2026 года, иначе тест выродится на другом стенде) → 200, выдача непустая, все `stat_date` лежат внутри диапазона, суммы с запятой и без пробелов тысяч;
4. в `audit_log` создана запись `action = AUDIT_ACTIONS.EXPORT_CSV` с `user_id` наблюдателя и `rowsCount`;
5. `GET /app/export/unknown.csv` → 400 `ValidationError`;
6. названия каналов с ведущим `=` не выполняются как формула (ячейка начинается с `'=`).

- [ ] **Step 2: Запустить тест и убедиться в падении**

Run: `npx vitest run tests/integration/export.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать `export.repo.js`, `export.service.js`, `export.controller.js` и кнопки в шаблонах**

Репозиторий отдаёт строки под каждый `dataset` с теми же фильтрами, что и соответствующий экран (SQL-условия повторяют T1/T2, суммы — через `centsFromDb`). Сервис собирает CSV через `stringifyCsv` с `withBom: true`, форматирует деньги как `1234,56` без разделителей тысяч и экранирует formula injection; контроллер выставляет `Content-Type`, `Content-Disposition` и пишет аудит `EXPORT_CSV`. Кнопка «Экспорт CSV» — ghost-пилюля со ссылкой, повторяющей текущий `location.search`.

- [ ] **Step 4: Прогнать тесты, проверить экран в браузере и закоммитить**

Run: `npx vitest run tests/integration/export.test.js`
Expected: PASS.

Browser: под `viewer` открыть `/app/channels?kind=paid`, нажать «Экспорт CSV», скачать файл (`agent-browser download`), убедиться, что в файле только paid-каналы и BOM на месте; консоль пуста.

Commit: `feat: add filtered csv export with utf-8 bom and audit logging`

---

### Task 7: Ресурсные медиаданные в БД (`media_assets`, BYTEA, `/media/:id` с ETag и кэшем)

**Требование бланка и спеки (`design.md` §2, §7, §8; `AGENTS.md` §8):**
- Изображения хранятся в таблице `media_assets` (`id`, `slug`, `filename`, `mime_type`, `size_bytes`, `checksum`, `bytes BYTEA`) и отдаются по публичному маршруту `GET /media/:id`, а также `GET /media/slug/:slug` (для `og-cover`).
- **Валидация `:id`:** только положительное целое (`/^[1-9]\d*$/`); `0`, отрицательные, `abc`, `1.5` → 404 `NotFoundError`. Последовательные публичные id — осознанное ограничение демо: перебор не раскрывает приватных данных (все картинки публичны по постановке), и это фиксируется в отчёте задачи и `IMPROVEMENTS.md`.
- **MIME whitelist и проверка магических байтов (magic bytes):** разрешены только `image/png` (`89 50 4E 47`), `image/jpeg` (`FF D8 FF`), `image/webp` (`RIFF....WEBP`). Загрузка `image/svg+xml`, `text/html` или файла, у которого заголовок буфера не совпадает с заявленным MIME, отклоняется с `ValidationError('Допустимы только изображения PNG, JPEG или WebP')` (исключает stored XSS через SVG).
- Лимит размера изображения — **1 МБ** (`1024 * 1024` байт); превышение — 413 через `createImageUploader()` (тот же маппинг, что в T5).
- `checksum` — SHA-256 от `bytes` в hex. Заголовок `ETag: "<checksum>"`, `Cache-Control: public, max-age=86400, immutable`, `X-Content-Type-Options: nosniff`. Если клиент прислал `If-None-Match: "<checksum>"`, сервер отвечает `304 Not Modified` без тела.
- Сценарии загрузки в UI:
  1. Загрузка/обновление OG-обложки сайта (`slug = 'og-cover'`, только `admin`). В M2 обложка **только сохраняется и отдаётся** по `/media/slug/og-cover`; подключение её к метатегам лендинга (`buildSeo({ imagePath })`) переносится в M6 вместе с медиа-осведомлённым публичным контроллером — сейчас `homePage` синхронный и статичный, а `seo.js` по умолчанию отдаёт `/img/og-cover.svg`. Решение и причина — в `IMPROVEMENTS.md`.
  2. Загрузка аватара пользователя (`slug = 'avatar-user-' + user.id`, любой авторизованный пользователь на `/app/profile`). Аватар отображается на странице профиля; картинка в `topbar.ejs` остаётся инициалами до M4 — иначе каждый рендер оболочки тянул бы лишний запрос к `media_assets`, а React-оболочка M4 всё равно заменит topbar.
- В `db/seed/seed.js` **добавить** детерминированную минимальную валидную PNG-обложку `slug = 'og-cover'` (в M1 её нет): константа-буфер 1×1 PNG, `INSERT … ON CONFLICT (slug) DO UPDATE` в блоке после очистки таблиц, чтобы `/media/slug/og-cover` работал сразу после `npm run seed`.

**Маршруты:**
- `GET /media/:id` и `GET /media/slug/:slug` (публичные, без `requireAuth`, чтобы соцсети и браузер читали `og:image`).
- `POST /api/v1/profile/avatar` (`requireAuth`, `createImageUploader()` single `'avatar'`) — загрузка своего аватара, ответ JSON `{ mediaId, slug, url }`.
- `POST /api/v1/admin/media/og-cover` (`requireAuth`, `requirePermission('users:manage')`, `createImageUploader()` single `'file'`) — обновление OG-обложки, ответ JSON.

**Files:**
- Create: `src/repositories/media.repo.js`, `src/services/media.service.js`, `src/controllers/media.controller.js`
- Modify: `src/routes/public.routes.js` (**превратить в фабрику `createPublicRouter({ mediaController })`**), `src/routes/api.routes.js` (два POST), `src/app.js` (собрать `mediaRepository`/`mediaService`/`mediaController`, передать в `createPublicRouter`, смонтировать публичный роутер), `src/controllers/admin.controller.js` (профиль отдаёт `avatarUrl` через `mediaRepo.findMediaBySlug`), `src/middleware/upload.js` (`createImageUploader`), `src/views/pages/profile.ejs`, `src/views/pages/admin-users.ejs`, `db/seed/seed.js` (PNG `og-cover`), `IMPROVEMENTS.md`
- Test: `tests/integration/media.test.js`

**Interfaces:**
- Consumes: `db`, `crypto.createHash`, `auditService.record`, `AUDIT_ACTIONS`.
- Produces:
  - `mediaRepo` (`createMediaRepository(db)`): `upsertMediaAsset({ slug, filename, mimeType, sizeBytes, checksum, bytes })`, `findMediaById(id)`, `findMediaBySlug(slug)`.
  - `mediaService`: `saveMedia({ slug, originalName, mimeType, buffer, actor })`, `getMediaById(id)`, `getMediaBySlug(slug)`.
  - `createPublicRouter({ mediaController })` — единственная точка монтирования `/media/*`; default-export роутера из M1 удаляется.

- [ ] **Step 1: Написать падающий интеграционный тест медиаресурсов**

`tests/integration/media.test.js`:
1. после `seed()` запрос `GET /media/slug/og-cover` → 200, `Content-Type: image/png`, присутствует `ETag`, `Cache-Control` и непустой бинарный буфер;
2. повторный запрос с `If-None-Match: <etag>` → 304 с пустым телом;
3. `GET /media/0`, `/media/-1`, `/media/abc`, `/media/1.5` → 404; `GET /media/999999` → 404;
4. `POST /api/v1/profile/avatar` под `analyst` с валидным 1×1 PNG-буфером и `X-CSRF-Token` → 200 JSON, `GET /media/:id` отдаёт те же байты, в `audit_log` запись `media.upload`;
5. тот же POST без `X-CSRF-Token` → 403 JSON (CSRF-отказ семейства медиа);
6. `POST /api/v1/profile/avatar` с SVG-буфером `<svg onload="alert(1)">` или текстовым файлом с подделанным `Content-Type: image/png` → 400;
7. буфер 1.1 МБ → 413 JSON;
8. `POST /api/v1/admin/media/og-cover` под `analyst` → 403 JSON; под `admin` → 200, обложка обновлена.

- [ ] **Step 2: Запустить тест и убедиться в падении**

Run: `npx vitest run tests/integration/media.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать `media.repo.js`, `media.service.js`, `media.controller.js`, формы в шаблонах и фабрику публичного роутера**

Проверка сигнатуры в `media.service.js`:
- PNG: `buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))`
- JPEG: `buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff`
- WebP: `buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'`

`media.controller` отдаёт бинарник через `res.set({ ETag, 'Cache-Control', 'X-Content-Type-Options': 'nosniff' })` и `res.send(bytes)`. Формы загрузки — `<form data-upload="/api/v1/profile/avatar" data-csrf="<%= csrfToken %>">` + `<noscript>`, отправка через `public/js/upload-form.js`; после успеха скрипт перезагружает страницу (`data-reload`), и аватар/обложка видны.

- [ ] **Step 4: Прогнать тесты, проверить экран в браузере и закоммитить**

Run: `npx vitest run tests/integration/media.test.js`
Expected: PASS.

Browser: под `analyst` открыть `/app/profile`, загрузить PNG через настоящий input, увидеть его на странице; под `admin` загрузить новую OG-обложку и открыть `/media/slug/og-cover`; `agent-browser console` пуст; 390 — формы не ломают вёрстку.

Commit: `feat: store media assets in postgres bytea and serve with etag caching`

---

### Task 8: E2E-проверка этапа через `agent-browser`, скриншоты и отчёт M2

**Сценарий сквозной проверки (критерий завершения M2 из дорожной карты):**
1. **Наполнение с нуля аналитиком без `psql`:** очистить таблицы данных, **оставив трёх пользователей**. Удалять каналы до клиентов нельзя (`customers.first_channel_id` → `RESTRICT`), поэтому используется один `TRUNCATE … CASCADE`:
   ```sql
   TRUNCATE touchpoints, orders, customers, daily_stats, goals, campaigns, channels
   RESTART IDENTITY CASCADE;
   ```
   `users`, `sessions`, `audit_log`, `import_batches` остаются. Войти в браузере как `analyst@metrika.by`:
   - создать канал «Telegram Посевы» (`code: tg_seeds`, целевой CAC `30,00`, целевой ROMI `130`);
   - создать кампанию «Посев Ноябрь» (`code: tg_seeds_nov`, бюджет `1 500,00`);
   - создать цель по CAC **для этого канала** (`channel: tg_seeds`) на календарный месяц якоря (`2026-11-01 .. 2026-11-30`): глобальные цели сида покрывают 12 месяцев и с целью на канал не пересекаются, а глобальная цель «на текущий месяц» упала бы в ошибку пересечения;
   - на `/app/import` загрузить по очереди 4 CSV-файла (`daily_stats`, `customers`, `touchpoints`, `orders`) из `docs/screenshots/m2/csv/` и увидеть отчёт `rows_failed = 0`;
   - нажать «Экспорт CSV» на странице каналов и скачать файл;
   - на `/app/profile` загрузить PNG-аватар и увидеть его на странице профиля.
2. **Проверка ограничений `viewer`:** войти как `viewer@metrika.by`, убедиться, что кнопки создания канала/кампании/цели и пункт «Импорт» отсутствуют, экспорт CSV работает, а прямые переходы на `/app/import`, `/app/admin/users`, `/app/audit` отдают styled 403.
3. **Администрирование и аудит:** войти как `admin@metrika.by`, на `/app/admin/users` создать пользователя, сменить ему роль, заблокировать его; открыть `/app/audit` и убедиться, что все действия аналитика, наблюдателя и администратора зафиксированы; проверить отдачу `/media/slug/og-cover`.
4. Проверить отсутствие ошибок в `agent-browser console` на каждом экране и вёрстку на мобильной ширине `390×844`.

**Files:**
- Create: `docs/screenshots/m2/README.md`, `docs/screenshots/m2/csv/{daily_stats,customers,touchpoints,orders}.csv`, `docs/screenshots/m2/*.png` (`channels.png`, `campaigns.png`, `goals.png`, `import-report.png`, `admin-users.png`, `audit-log.png`, `profile-avatar.png`, `mobile-channels.png`)
- Modify: `README.md` (обновить статус M2), `IMPROVEMENTS.md`

**Interfaces:** не меняет production-код.

- [ ] **Step 1: Подготовить фикстуры и прогнать весь тестовый набор**

Создать четыре CSV-фикстуры под `docs/screenshots/m2/csv/` с кодами, которые сценарий создаёт вручную (`tg_seeds`, `tg_seeds_nov`) и клиентами с префиксом `m2_e2e_`, и закоммитить их вместе с отчётом T8 (они нужны для воспроизведения прогона). Проверить поддержку загрузки файла установленным CLI:
```bash
agent-browser skills get core --full | grep -n "upload"
agent-browser upload --help
```
Ожидается строка `upload <sel> <files...>`. Если команды нет или синтаксис другой — зафиксировать это как блокер в отчёте и не заменять её `eval`-хаком.

Run: `npm run db:setup && npm run migrate && npm test`
Expected: миграция `002_m2_data.sql` применена, все юнит- и интеграционные тесты M1 + M2 зелёные, включая `single-stylesheet.test.js`.

- [ ] **Step 2: Выполнить интерактивный E2E-прогон в `agent-browser`**

Запустить сервер на сидированной БД, выполнить `TRUNCATE … CASCADE` из сценария 1, пройти сценарии 1–4 реальными кликами (`snapshot -i`, `fill`, `click`, `select`, `upload`), после каждого экрана проверять `agent-browser console`, снять скриншоты в `docs/screenshots/m2/`, вернуть демо-сид командой `npm run seed` (он очищает `media_assets` и `sessions`, поэтому прогон заканчивается чистым состоянием).

- [ ] **Step 3: Оформить `docs/screenshots/m2/README.md`, обновить `README.md` и закоммитить**

README M2 — по образцу `docs/screenshots/m1/README.md`: дата прогона, якорь, команды воспроизведения, таблица шагов с результатами, проверки консоли, список скриншотов и фикстур. В `IMPROVEMENTS.md` внести принятые ограничения M2: последовательные публичные id медиа, аватар только на профиле (topbar — M4), OG-обложка не подключена к лендингу (M6), `goals.target_value` в NUMERIC для смешанных единиц, отсутствие повторной валидации пользователя на каждом запросе.

Commit: `docs: add m2 e2e verification log and screenshots`

---

## Приёмка M2

- [ ] Все тесты M1 и M2 (`npm test`) зелёные; `single-stylesheet.test.js` проходит на всех новых `.ejs`-шаблонах.
- [ ] Аналитик способен завести канал, кампанию, цель и импортировать 4 типа CSV через UI на пустой БД.
- [ ] Загрузки работают только через `fetch` + `X-CSRF-Token`; multipart с реальным файлом проходит, запрос без заголовка получает 403; токен нигде не передаётся в query-строке.
- [ ] Канал с активными кампаниями нельзя архивировать; кампанию со статистикой/заказами нельзя удалить.
- [ ] При >10% ошибочных строк CSV-пакет откатывается целиком (`rowsFailed * 10 > rowsTotal`), но отчёт ошибок сохраняется в `import_batches`; при инъецированной ошибке откатываются и данные, и пакет, и аудит.
- [ ] Администратор управляет пользователями; смена роли, деактивация и сброс пароля отзывают сессии, самоблокировка запрещена.
- [ ] Изображения хранятся в `media_assets` (`BYTEA`) и отдаются по `/media/:id` с `ETag` и `304 Not Modified`; нечисловой `:id` даёт 404.
- [ ] Каждая мутация и экспорт отражены в `/app/audit` через `AUDIT_ACTIONS`, без утечки паролей и секретов.
- [ ] Ни одна страница M2 не отдаёт заглушку «Раздел появится на следующем этапе»; соответствующие записи `PLACEHOLDER_SECTIONS` и явные заглушки удалены.
- [ ] Скриншоты, CSV-фикстуры и лог браузерной проверки лежат в `docs/screenshots/m2/`.

---

## Правки после ревью

1. **Multipart CSRF.** Добавлен раздел «Механика CSRF и загрузок»: загрузки идут только на `/api/v1/*` через `fetch` + `FormData` + `X-CSRF-Token`, urlencoded-формы сохраняют `_csrf` в теле; query-строка для токена запрещена. Добавлен тест с реальным `.attach(...)` и заголовком, по одному CSRF-отказу на семейство POST (T1–T5).
2. **`src/app.js`.** Во всех задачах, создающих репозиторий/сервис, добавлен `Modify: src/app.js` с точным списком сборки и расширением зависимостей `createAppRouter`; `public.routes.js` в T7 превращается в `createPublicRouter({ mediaController })`, добавлен `src/routes/api.routes.js`.
3. **Заглушки.** Каждая задача удаляет свою запись из `PLACEHOLDER_SECTIONS` (или явную заглушку `/import`, `/audit`) в том же изменении, а её тест проверяет отсутствие текста «следующем этапе»; задачи отдельно правят `tests/integration/rbac.test.js`.
4. **Отзыв сессий при смене роли.** `changeUserRole` вызывает `deleteUserSessions`; тест T3: старый cookie понижённого пользователя → 302 `/login`, после повторного входа → styled 403 на `/app/admin/users`. Зафиксировано, почему одна и та же cookie не может дать 403 после удаления строки сессии.
5. **MemoryStore.** Ветка «в тестах с MemoryStore» удалена; тесты используют PgStore, отзыв доказывается удалением строк. Повторная валидация отклонена с обоснованием и записью в `IMPROVEMENTS.md`. `users.repo.findById` перенесён из «существующих» в Produces T3.
6. **Транзакционные репозитории.** `createImportRepository(client)` и `createAuditRepository(client)` создаются внутри `withTransaction`, пуловые репозитории внутрь не передаются; добавлен тест отката через триггер на `audit_log` с проверкой нуля строк в данных, `import_batches` и `audit_log`. Заодно `withTransaction` получает `db`-параметр, чтобы тесты не писали в dev-БД.
7. **Миграция 002.** Добавлен `db/migrations/002_m2_data.sql` (уникальный индекс `touchpoints (customer_id, occurred_at, channel_id)` с предварительным удалением точных дублей, `import_batches.rows_duplicate`, индекс для проверки пересечения целей), файл внесён в карту, SQL `ON CONFLICT` зафиксирован.
8. **Контракт импорта.** Задан JSON-контракт (`rowsOk`, `rowsFailed`, `rowsDuplicate`, `committed`, `batchId: null` на dry-run, `errors[].row`), HTML-view-model не поддерживается, `<noscript>` объясняет причину; тесты проверяют ключи и коды ответов.
9. **Источник CSRF-токена.** В `tests/helpers/csrf.js` добавлен `getAppCsrf(agent)` (форма выхода на `/app/dashboard`); тесты различают styled HTML 403 (`requirePermission`) и `text/plain` 403 (`CSRF token mismatch`).
10. **Список интерфейсов.** Все репозитории описаны как фабрики `createXRepository(db)`; `formatAnchorRu` перенесён в `app.controller.js`; выбран один API аудита `list({ filters, limit, offset })` + `count(filters)` + `auditService.listAuditEntries(filters)`; `createLoginRateLimiter()` исправлен на фактическое имя.
11. **Ошибки multer.** Добавлен `src/middleware/upload.js` с маппингом `LIMIT_FILE_SIZE` → 413 и `LIMIT_UNEXPECTED_FILE` → 400 с русскими текстами; тесты 413 в T5 и T7.
12. **Мёртвая ветка.** Из правил `touchpoints` удалено «если `first_channel_id` ещё не задан»: колонка `NOT NULL` и импорт всегда задаёт канал.
13. **BIGINT/NUMERIC.** В `money.js` добавлен `centsFromDb` (строка/число/bigint → `bigint`, нецелые отвергаются) и юнит-тест; слепой `Number()` запрещён в Global Constraints.
14. **`goals.target_value`.** Оставлен `NUMERIC(14,2)` как задокументированное исключение для смешанных единиц (BYN, %, коэффициент, месяцы, штуки), с объяснением в T4 и записью в `IMPROVEMENTS.md`; сравнение с фактом — через `parseBynToCents`, без float.
15. **E2E.** Упоминание `tests/e2e/m2.e2e.js` убрано из Review Focus; M2 E2E — это CLI `agent-browser` + `docs/screenshots/m2/README.md` + PNG, как в M1.
16. **Шаги E2E.** Удаление через `TRUNCATE … CASCADE` с сохранением `users`/`sessions`/аудита; цель создаётся для канала `tg_seeds`, а не глобальная, чтобы не пересечься с сидированными целями.
17. **CSS.** T1 добавляет `.toolbar`, `.filter-bar`, `.row-actions`, `.pager`, `.inline-form`; T5 — `.file-input`, `.upload-status`, `.noscript-note`; inline-стили запрещены.
18. **OG-обложка.** Подключение к `seo.js`/лендингу отложено до M6 (публичный контроллер синхронный и статичный), M2 только сохраняет и отдаёт `/media/slug/og-cover`; то же решение применено к аватару в topbar (M4), оба пункта — в `IMPROVEMENTS.md`.
19. **Имена аудит-действий.** Добавлен `src/config/audit-actions.js` (`AUDIT_ACTIONS`), используется сервисами, тестами, фильтром `/app/audit`; `auth.controller` переведён на константы.
20. **Карточка канала.** Таблица кампаний и быстрая форма перенесены из T1 в T2 (T1 отдаёт только паспорт и счётчики); тест T2 проверяет карточку.
21. **Лимитер импорта.** `createImportRateLimiter()` создаётся на приложение внутри `createApiRouter`, ключ — `req.session.user.id` с fallback на `req.ip`, модульного singleton нет.
22. **Порог 10%.** Деление заменено на `rowsFailed * 10 <= rowsTotal`; пустой файл — 400 в обоих режимах и явно описан в контракте.
23. **CSV/CRLF.** Парсер удаляет `\r`, юнит-тесты покрывают CRLF и поле в кавычках с `;` внутри.
24. **Подготовка БД в тестах импорта.** Зафиксирована схема: `beforeAll` seed один раз, `beforeEach` чистит `import_batches`/`audit_log`, каждый тест пишет уникальные идентификаторы; скрытой зависимости от порядка нет.
25. **Supertest multipart и арифметика.** Указан `.attach('file', Buffer.from(csv), 'x.csv')`; тест порога исправлен: 5 строк, 1 битая (20% > 10%), 4 валидные не применяются, `rows_ok = 4`, `rows_failed = 1`, `committed = false`, `batchId` возвращается, `errors[0].row === 3`.
26. **Форматтеры.** Разделены: `money.js` — парсинг/арифметика/`centsFromDb`, `format.js` — рендер-форматирование; оба принимают строки `pg`.
27. **`listForAdmin`.** Переиспользован существующий метод M1, `listUsers` не создаётся; `admin.controller` продолжает работать.
28. **Модель.** В шапку добавлена строка с пином `opencode-go/deepseek-v4.1-flash`.
29. **`agent-browser upload`.** В T8 добавлена проверка команды через `agent-browser skills get core --full` и `--help` до прогона; четыре CSV-фикстуры коммитятся в `docs/screenshots/m2/csv/`.
30. **`/media/:id`.** Валидация положительного целого → 404; последовательные публичные id зафиксированы как ограничение демо в отчёте T7 и `IMPROVEMENTS.md`.
31. **JSON-контракт внутри роутера (следствие п. 8).** `isApiRequest` в `middleware/auth.js` и `middleware/errors.js` переведён на `req.originalUrl`: внутри роутера на `/api/v1` `req.path` обрезан, и `requirePermission`/`requireAuth`/`errorHandler` иначе отдавали бы HTML вместо JSON. Тесты RBAC на API проверяют JSON 403/401.
32. **Глобальный пул в сервисах (следствие п. 6).** Строки «Consumes: `query`» заменены на инъекцию `db`; `withTransaction` получает пул приложения, поэтому интеграционные тесты M2 не могут писать в dev-БД.
