# Метрика

Веб-приложение для оценки эффективности маркетинговых каналов: CAC, когортный LTV и ROMI по каждому каналу,
атрибуция, алерты и сценарии бюджета. Курсовой проект БГУИР.

![Лендинг «Метрики»](docs/screenshots/m1/landing-desktop.png)

Демо-бренд — «Метрика», демо-компания — вымышленный интернет-магазин кофе «Зёрна» из Минска. Все суммы — в
BYN, расчётные даты — Europe/Minsk. Интерфейс и подписи на русском, код и имена в БД — на английском.

## Что уже работает (M1–M5)

- Публичный лендинг с SEO: canonical, Open Graph, JSON-LD, `robots.txt`, `sitemap.xml`, один `<h1>`.
- Вход по email и паролю (argon2id), серверные сессии в PostgreSQL, CSRF, rate-limit, безопасный `next`.
- Три роли с разными правами: администратор, аналитик, наблюдатель. RBAC проверяется на сервере, а не только
  скрытием ссылок.
- Каркас приложения: сайдбар по правам, topbar с якорем данных, дашборд с честным «нет данных», страницы 403/404/500.
- **M2:** управление каналами (архив защищён от активных кампаний), кампаниями (фильтры, защита от удаления с
  данными) и целями (плановые значения, запрет пересечения периодов).
- **M2:** администрирование пользователей — создание, смена роли, блокировка, одноразовый сброс пароля; смена роли,
  блокировка и сброс отзывают активные сессии. Журнал аудита с фильтрами по разделу, автору и действию.
- **M2:** импорт CSV четырёх типов (`daily_stats`, `customers`, `touchpoints`, `orders`) с dry-run, лимитами,
  отчётом по строкам и атомарным откатом при ошибках больше 10%. Экспорт тех же данных в CSV с BOM, фильтрами
  текущего экрана, защитой от formula injection и записью в аудит. Кнопки «Экспорт CSV» есть на экранах каналов и
  кампаний; статистика и заказы доступны прямыми ссылками `/app/export/daily_stats.csv` и
  `/app/export/orders.csv`, отдельные экраны для них не планируются.
- **M2:** изображения (аватар и OG-обложка) хранятся в PostgreSQL `BYTEA` и отдаются по `/media/:id` и
  `/media/slug/:slug` с `ETag`, `304 Not Modified` и content-addressed `?v=`-ссылкой.
- **M3:** движок метрик — CAC по first-touch, когортный LTV, ROMI, payback и LTV:CAC, рейтинг каналов, прогресс
  целей и сравнение трёх моделей атрибуции (last-touch, first-touch, linear). Деньги — целые копейки, `null` —
  честное «нет данных»; формулы и краевые случаи зафиксированы в
  [метрик-спеке](docs/superpowers/specs/2026-11-21-metrics-spec.md).
- **M4:** пять экранов аналитики: дашборд (KPI, вердикт недели, CAC и ROMI по неделям, расход/выручка, расход по
  каналам, scatter CAC×LTV), каналы (рейтинг с весами, сортировка, спарклайны, ROMI-bar), паспорт канала (метрики,
  воронка, удержание, кампании, цели), когорты (heatmap и кривая накопленного LTV), атрибуция (три модели, ROMI
  модели, дельта-таблица).
- **M4:** каждая страница — серверный EJS-каркас и ровно один React-остров. KPI, графики и таблицы рисуются из
  `data-props`; ту же экранную модель отдаёт `GET /api/v1/*`, поэтому страница и JSON не могут разойтись. Период,
  сортировка, веса, модель и горизонт — обычные GET-параметры, URL остаётся единственным состоянием.
- **M4:** Vite 7 собирает острова в `public/assets` с манифестом; в M5 их семь (пять аналитических экранов,
  алерты и сценарии). `/assets` кэшируется надолго, HTML —
  `no-store`; в production сервер не стартует без манифеста. У каждого графика есть вывод-заголовок, период,
  единица, пустое состояние и таблица-дубль для скринридера.
- **M4:** фильтр каналов на дашборде (BO-13), состояния loading/empty/error/partial на каждом экране, проверенный
  клавиатурный обход и отсутствие горизонтального переполнения на 390 px.
- **M5:** алерты по каналам. Правила сравнивают четыре полные недели с четырьмя предыдущими; окна считаются от
  data anchor, `period_start` — понедельник. Список фильтруется по статусу, важности и каналу, пагинируется по 50.
  Строка уникальна по `(канал, правило, period_start)`, поэтому повторный пересчёт не плодит дубли: снятый вручную
  алерт остаётся `dismissed`, а `resolved` снова открывается, если правило сработало. «Скрыть» принимает причину
  (до 200 символов) и пишет `alert.dismiss` в аудит. Аналитик получает один автоматический пересчёт в час **на
  сессию**, а не на пользователя: два устройства одной учётной записи могут пересчитать дважды. Кнопка
  «Пересчитать» работает всегда и не зависит от этого ограничения. Наблюдателю доступно только чтение.
- **M5:** сценарии бюджета. Недельный бюджет распределяется между платными каналами по кривым насыщения (KKT и
  бисекция), рядом показаны «сейчас» и «план» с CAC и ROMI. Прогноз подписан как недельный и годовой ×52. Слайдер и
  пресеты «Как сейчас / +20 % / ×2» меняют бюджет через обычный GET; верхняя граница — **3×** текущего недельного
  расхода, при **>2×** появляется предупреждение об экстраполяции. Каналы без валидной кривой (`linear`/`no_data`)
  остаются в таблице, но не участвуют в распределении; линейная кривая помечена «линейная кривая — без оптимума».
  Сохранение замораживает `params` и `result` в JSONB, страница снимка читает только сохранённый результат и не
  пересчитывает его задним числом; ссылка «Повторить» открывает builder с теми же параметрами.
- PostgreSQL-схема из 15+ таблиц с FK/CHECK/UNIQUE, миграции `001`–`006`; детерминированный сид: 8 каналов,
  32 кампании, 4 000 клиентов, 14 месяцев статистики.
- Один stylesheet `public/css/app.css`, локальные шрифты Inter / Inter Tight / знак BYN, без CDN.

Границы этапа: M5 завершает прикладные экраны — алерты и сценарии бюджета заменили последние заглушки. M6
доводит проект до сдачи: Docker multi-stage и compose, резервное копирование и восстановление, руководство
пользователя и развёртывания, финальный a11y/SEO-аудит и проверка на чистой машине. Полный план:
[`docs/superpowers/plans/2026-11-21-metrika-roadmap.md`](docs/superpowers/plans/2026-11-21-metrika-roadmap.md).

## Стек

| Слой | Технологии |
|---|---|
| Runtime | Node.js 22.12+ (рекомендуется 24 LTS), ESM |
| Сервер | Express 5, EJS 3 + `express-ejs-layouts`, Zod, pino |
| БД | PostgreSQL 18, драйвер `pg`, SQL-миграции без ORM |
| Auth | `express-session` + `connect-pg-simple`, `@node-rs/argon2`, CSRF, `express-rate-limit` |
| Безопасность | helmet с явной CSP, параметризованный SQL, экранирование EJS |
| Тесты | Vitest + Supertest |
| Клиент | React 19 + Vite 7 + Recharts 3 — по одному острову на экран; данные приходят из `data-props`, отдельных запросов нет |

TypeScript не используется. Второго CSS-файла, CSS-фреймворков и CDN нет.

## Быстрый старт с чистого клона

Нужны Node.js 22.12+ (рекомендуется 24 LTS — нижняя граница задана требованиями Vite 7), npm и запущенный
PostgreSQL 18. Роль БД должна уметь создавать базы (или базы создаются вручную).

```bash
git clone <URL-репозитория> metrika
cd metrika
npm ci
cp .env.example .env
```

Откройте `.env` и проверьте три строки подключения:

```dotenv
DATABASE_URL=postgres://postgres:postgres@localhost:5432/metrika_dev
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/metrika_test
ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
```

- Значения по умолчанию рассчитаны на локальный PostgreSQL или Docker с ролью `postgres` и паролем `postgres`.
- Если используется **пароль**, оставьте формат `postgres://пользователь:пароль@localhost:5432/имя_базы`.
  Спецсимволы в пароле кодируются процентным экранированием.
- `ADMIN_DATABASE_URL` нужен только скрипту `db:setup`: это подключение к служебной базе `postgres` от роли,
  у которой есть право `CREATEDB` (если базы уже созданы вручную, право не требуется).

### Если PostgreSQL использует peer-аутентификацию

Вариантов подключения три.

**a. Отдельная роль с паролем по TCP (рекомендуется).** Этот путь не зависит от peer-аутентификации, но требует,
чтобы `pg_hba.conf` разрешал пароль для TCP-подключений (`scram-sha-256`, `md5` или `trust`). Создайте роль и базы:

```bash
# если текущая роль ОС не суперпользователь, все три команды запускаются от служебной роли:
# sudo -u postgres createuser --pwprompt metrika
# sudo -u postgres createdb --owner=metrika metrika_dev
# sudo -u postgres createdb --owner=metrika metrika_test
createuser --pwprompt metrika
createdb --owner=metrika metrika_dev
createdb --owner=metrika metrika_test
```

Затем пропишите эту роль в `.env`:

```dotenv
DATABASE_URL=postgres://metrika:<пароль>@localhost:5432/metrika_dev
TEST_DATABASE_URL=postgres://metrika:<пароль>@localhost:5432/metrika_test
ADMIN_DATABASE_URL=postgres://metrika:<пароль>@localhost:5432/postgres
```

Если вы создали обе базы вручную, `npm run db:setup` только подтвердит их наличие. Если оставили эту работу
скрипту, роль из `ADMIN_DATABASE_URL` должна иметь `CREATEDB`.

**b. Unix-сокет.** Если TCP закрыт или сервер настроен на peer-аутентификацию, можно подключиться через сокет.
Путь к сокету задаётся параметром `host` в URL или переменной `PGHOST`. В примере ниже роль `metrika`; при
peer-аутентификации она должна совпадать с именем пользователя ОС, от которого запущено приложение:

```dotenv
DATABASE_URL=postgres://metrika@/metrika_dev?host=/var/run/postgresql
```

```bash
export PGHOST=/var/run/postgresql   # host в URL можно не указывать: postgres:///metrika_dev
```

`PGHOST`/`PGUSER`/`PGPASSWORD` заполняют **только незаданные** поля подключения; явно указанное в URL поле имеет
приоритет. Поэтому `postgres:///metrika_dev` сам по себе оставляет host незаданным и означает TCP `localhost`, а с
экспортированным `PGHOST` — Unix-сокет.

При peer-аутентификации PostgreSQL игнорирует пароль и требует, чтобы роль совпадала с пользователем ОС. Запускайте
приложение и psql от этого пользователя; `PGUSER`/`PGPASSWORD` здесь не помогут:

```bash
psql -d metrika_dev
```

Административные команды (`createuser`, `createdb`) выполняются от роли с правом `CREATEDB`. Если текущая роль ОС
не суперпользователь, используйте вариант с `sudo -u postgres` из пункта «a».

**c. Docker или роль `postgres` по умолчанию.** Если стенд запущен в Docker или локально с ролью `postgres` и
паролем `postgres`, оставьте URL из `.env.example` без изменений — это самый простой путь.

Также задайте `SESSION_SECRET` (не короче 32 символов). Кроссплатформенный вариант, работает и в Windows:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`openssl rand -hex 32` даёт тот же результат, если он установлен.

Для локальной разработки оставьте `APP_URL=http://localhost:3000` и `COOKIE_SECURE=false`.

`TRUST_PROXY` по умолчанию `false`: прямое подключение не может подделать `X-Forwarded-For` и подменить IP в журнале
аудита или ключ лимитера входа. Если приложение стоит за reverse-proxy, укажите число доверенных хопов (`1` для одного
прокси), список подсетей (`loopback, 10.0.0.0/8`) или `true` — только когда приложение недоступно напрямую.

Создайте базы, накатите схему и заполните демо-данными:

```bash
npm run db:setup     # создаёт metrika_dev и metrika_test, если их нет; повторный запуск безопасен
npm run migrate      # применяет SQL-миграции 001–006
npm run seed         # детерминированный демо-сид
npm run dev          # собирает острова и запускает сервер: http://localhost:3000
```

Для запуска без наблюдения за файлами нужна отдельная сборка: `npm run build`, затем `npm start`. `npm start`
сборку не запускает: в production без `public/assets/.vite/manifest.json` приложение останавливается с подсказкой
`npm run build`, а в development открывает страницы без графиков и пишет одно предупреждение в лог.

React-острова собираются Vite в `public/assets` (хешированные ES-модули, манифест в `public/assets/.vite`).
`npm run dev` делает сборку один раз и перезапускает только сервер; `npm run build` собирает острова для
`npm start`, `npm run build:watch` пересобирает их при изменении файлов в отдельном терминале. Dev-сервера и HMR
нет: страницы всегда рендерит Express, поэтому CSP и поведение совпадают с production. `public/assets` — артефакт
сборки и в git не попадает, `package-lock.json` коммитится.

Docker-этап (multi-stage сборка, копирование `public/assets`, резервное копирование) отложен на M6; M5
документирует только локальный путь с PostgreSQL.

Бюджет сборки проверяется тестом `tests/integration/build-output.test.js`: вход каждой страницы — не больше
210 KB gzip, вся страница (entry + общие чанки) — не больше 250 KB gzip. В M5 страница алертов занимает
195,7 KiB gzip, сценариев — 217,4 KiB. Остров не импортирует CSS, не делает `fetch` и не содержит inline-стилей;
графики идут через Recharts, а их данные дублируются таблицей внутри `<details>`. Один общий чанк React + Recharts
кэшируется между страницами, поэтому вес `npm run build` меньше суммы входов.

`db:setup` создаёт только пустые базы. Схему дают миграции `001`–`006`, данные — `seed`. Пароль из сида не
логируется. Повторный `npm run seed` очищает `sessions` и `media_assets` (кроме детерминированной OG-обложки),
поэтому всех, кто уже вошёл на стенд, разлогинит, а загруженные аватары исчезнут: запускайте сид до входа или
предупредите пользователей.

Проверка: `http://localhost:3000/health` возвращает `{"status":"ok","db":"up","version":"0.1.0"}`.

## Демо-аккаунты

| Email | Роль | Права роли |
|---|---|---|
| `admin@metrika.by` | Администратор | все права, включая управление пользователями и просмотр аудита |
| `analyst@metrika.by` | Аналитик | просмотр + управление каналами, кампаниями, целями, сценариями, алертами и импорт |
| `viewer@metrika.by` | Наблюдатель | просмотр всех разделов + право экспорта |

Пароль всех трёх аккаунтов: **`Metrika2026!`**

**Что уже работает в M5:** все экраны приложения заменяют заглушки. Дашборд, каналы, паспорт канала, когорты и
атрибуция считают CAC, ROMI, LTV и удержание по данным выбранного периода; алерты и сценарии бюджета описаны
выше. Аналитик управляет каналами, кампаниями, целями, сценариями, алертами, импортом и экспортом;
администратор — пользователями и аудитом; наблюдатель видит аналитику, алерты и сохранённые сценарии, но не
меняет данные и не запускает пересчёт.

> Это демонстрационный стенд с вымышленными данными. Пароль опубликован намеренно и для production не годится:
> перед любым публичным запуском смените пароли, `SESSION_SECRET`, включите `COOKIE_SECURE=true` и HTTPS.

## Маршруты

| Метод и путь | Доступ | Назначение |
|---|---|---|
| `GET /`, `GET /login`, `POST /login`, `POST /logout` | все | лендинг и вход; `/logout` защищён CSRF |
| `GET /health`, `/robots.txt`, `/sitemap.xml` | все | служебные ответы |
| `GET /media/:id`, `GET /media/slug/:slug` | все | изображения из БД с `ETag` и `304` |
| `GET /app/dashboard` | вход | KPI, вердикт, недельные графики и фильтр каналов |
| `GET /app/channels`, `/app/channels/:id` | `channels:view` | рейтинг каналов и паспорт канала |
| `GET /app/cohorts` | `cohorts:view` | heatmap удержания и кривая накопленного LTV |
| `GET /app/attribution` | `attribution:view` | сравнение трёх моделей атрибуции |
| `GET /app/alerts` | `alerts:view` | сводка, график CAC проблемного канала и таблица алертов с фильтрами и пагинацией |
| `POST /app/alerts/recalculate`, `POST /app/alerts/:id/dismiss` | `alerts:manage` + CSRF | пересчёт правил и снятие алерта с причиной; `dismiss` пишет `alert.dismiss` в аудит |
| `GET /app/scenarios`, `/app/scenarios/:id` | `scenarios:view` | builder недельного бюджета и сохранённый снимок |
| `POST /app/scenarios` | `scenarios:manage` + CSRF | пересчитывает и сохраняет `params`/`result`, пишет `scenario.create` |
| `GET /api/v1/dashboard`, `/channels`, `/channels/:id`, `/cohorts`, `/attribution`, `/ranking`, `/alerts`, `/scenarios`, `/scenarios/:id` | вход + право раздела | те же экранные модели в JSON, `Cache-Control: no-store`; только `GET`, без CSRF |
| `POST /api/v1/alerts/recalculate`, `/api/v1/alerts/:id/dismiss`, `/api/v1/scenarios` | `alerts:manage` / `scenarios:manage` + CSRF | JSON-варианты мутаций; `GET` никогда не пересчитывает алерты |
| `POST /app/channels`, `POST /app/channels/:id`, `POST /app/channels/:id/archive` | `channels:manage` | CRUD и архив |
| `GET /app/campaigns` | `campaigns:view` | список с фильтрами |
| `POST /app/campaigns`, `POST /app/campaigns/:id`, `POST /app/campaigns/:id/delete` | `campaigns:manage` | CRUD кампаний |
| `GET /app/goals` | `goals:view` | цели и плановые показатели |
| `POST /app/goals`, `POST /app/goals/:id`, `POST /app/goals/:id/delete` | `goals:manage` | CRUD целей |
| `GET /app/import`, `/app/import/batches/:id`, `/app/import/templates/:kind.csv` | `import:run` | импорт и отчёты |
| `POST /api/v1/import` | `import:run` + CSRF | multipart CSV, dry-run и боевой импорт |
| `GET /app/export/:dataset.csv` | `export` | CSV каналов, кампаний, статистики, заказов |
| `GET /app/audit` | `audit:view` | журнал действий с фильтрами |
| `GET /app/admin/users`, `POST /app/admin/users/*` | `users:manage` | пользователи, роли, блокировка, сброс |
| `POST /api/v1/profile/avatar`, `POST /api/v1/admin/media/og-cover` | вход / `users:manage` + CSRF | загрузка изображений |
| `GET /app/profile`, `POST /app/profile/password` | вход | профиль и смена своего пароля |

Страницы `/app/*` закрыты от индексации; API отвечает JSON и на ошибки доступа, страницы — styled 403.

## Скрипты

| Команда | Что делает |
|---|---|
| `npm run dev` | собирает острова (`build`) и запускает сервер с `node --watch` на `PORT` (по умолчанию 3000) |
| `npm start` | сервер без наблюдения; требует готового `public/assets` (в production без манифеста не стартует) |
| `npm run build` | production-сборка семи входов Vite в `public/assets` |
| `npm run build:watch` | пересобирает острова при изменении `client/**` в отдельном терминале |
| `npm run db:setup` | идемпотентно создаёт базы из `DATABASE_URL` и `TEST_DATABASE_URL` |
| `npm run migrate` | применяет миграции из `db/migrations` |
| `npm run seed` | пересоздаёт детерминированный демо-набор |
| `npm test` | Vitest: юнит- и интеграционные тесты на `TEST_DATABASE_URL` |
| `npm run test:watch` | Vitest в режиме наблюдения |

Тесты работают только с базой из `TEST_DATABASE_URL` и требуют имя, оканчивающееся на `_test`; рабочую базу они
не трогают. Интеграционные файлы выполняются последовательно, потому что пересоздают схему.

## Структура

```
src/
  server.js, app.js          запуск и сборка Express
  config/                    env, матрица прав
  routes/                    публичные, auth, /app и /api/v1-маршруты
  controllers/               HTTP: разбор входа, Zod, выбор шаблона
  validators/                Zod-схемы форм, импорта, экспорта и метрик
  services/                  бизнес-логика без Express; services/metrics/ — движок M3 и экранные модели
  repositories/              параметризованный SQL и маппинг строк
  middleware/                auth, CSRF, rate-limit, upload, ошибки, request id
  lib/                       логгер, БД, сессии, CSRF, SEO, даты, деньги, CSV, манифест сборки
  views/                     EJS: layouts, partials, pages, errors
client/
  entries/                   семь входов Vite: dashboard, channels, channel, cohorts, attribution, alerts, scenarios
  components/                острова, KPI, графики Recharts, состояния, таблицы-дубли
  lib/                       монтирование, тема графиков, форматирование, focus-guard
db/
  migrations/                001–006: схема, данные M2, MIME, индексы метрик, алерты и сценарии
  migrate.js, setup.js       раннер миграций и bootstrap баз
  seed/                      детерминированный генератор демо-данных
public/
  css/app.css                единственный stylesheet
  assets/                    артефакт `npm run build`, в git не входит
  js/                        острова загрузки файлов без фреймворка
  fonts/, img/               локальные шрифты и SVG
tests/
  unit/, integration/        Vitest + Supertest
docs/
  superpowers/specs/         архитектура, метрики, трассировка требований
  superpowers/plans/         дорожная карта и планы этапов
  screenshots/m1/            скриншоты и журнал браузерной проверки M1
  screenshots/m2/            снимки, CSV-фикстуры и журнал M2
  screenshots/m4/            снимки пяти аналитических экранов и журнал M4
  screenshots/m5/            алерты, сценарии, границы бюджета и журнал E2E M5
```

## Документация

- [Архитектура и границы](docs/superpowers/specs/2026-11-21-marketing-analytics-design.md)
- [Формулы CAC, LTV, ROMI и краевые случаи](docs/superpowers/specs/2026-11-21-metrics-spec.md)
- [Трассировка требований задания](docs/superpowers/specs/2026-11-21-assignment-traceability.md)
- [Дорожная карта M1–M6](docs/superpowers/plans/2026-11-21-metrika-roadmap.md)
- [План этапа M1](docs/superpowers/plans/2026-11-21-metrika-m1-foundation.md)
- [План этапа M2](docs/superpowers/plans/2026-11-21-metrika-m2-data.md)
- [План этапа M3](docs/superpowers/plans/2026-11-22-metrika-m3-metrics.md)
- [План этапа M4](docs/superpowers/plans/2026-11-23-metrika-m4-analytics-ui.md)
- [План этапа M5](docs/superpowers/plans/2026-11-24-metrika-m5-decisions.md)
- [Журнал E2E и скриншоты M1](docs/screenshots/m1/README.md)
- [Журнал E2E и скриншоты M2](docs/screenshots/m2/README.md)
- [Журнал E2E и скриншоты M4](docs/screenshots/m4/README.md)
- [Журнал E2E и скриншоты M5](docs/screenshots/m5/README.md)
- [Отложенные улучшения](IMPROVEMENTS.md)

## Windows 10

Короткая версия; полная инструкция с Docker и резервным копированием появится в M6.

1. Установите Node.js 24 LTS и PostgreSQL 18 (установщик с официального сайта).
2. Добавьте `bin` PostgreSQL в `PATH` или запускайте `createdb`/`psql` из каталога установки.
3. В PowerShell: `Copy-Item .env.example .env`, затем отредактируйте URL и `SESSION_SECRET`.
4. `npm ci`, `npm run db:setup`, `npm run migrate`, `npm run seed`, `npm run dev` (собирает острова и запускает
   сервер). Для запуска без наблюдения: `npm run build` и затем `npm start`.
5. Откройте `http://localhost:3000`.

Если `db:setup` не может подключиться, проверьте службу PostgreSQL и пароль роли в `ADMIN_DATABASE_URL`.

## Если что-то не запускается

| Симптом | Причина и действие |
|---|---|
| `database "metrika_dev" does not exist` | базы ещё нет: выполните `npm run db:setup` |
| `password authentication failed for user ...` | неверный URL, пароль или `pg_hba.conf`. Проверьте `psql "$DATABASE_URL"`. При peer-аутентификации пароль игнорируется, а роль должна совпадать с пользователем ОС: подключайтесь к сокету (`?host=/var/run/postgresql` или `PGHOST`) от нужного пользователя либо создайте роль с паролем и разрешите password auth по TCP (см. «Если PostgreSQL использует peer-аутентификацию») |
| `db:setup failed: ... permission denied to create database` | у роли в `ADMIN_DATABASE_URL` нет `CREATEDB`. Дайте право или создайте базы вручную через `createdb` |
| `TEST_DATABASE_URL is not set` | скопируйте `.env.example` в `.env` и заполните тестовую базу |
| `Asset manifest not found at …public/assets/.vite/manifest.json` | `npm start` без сборки: выполните `npm run build` или запускайте `npm run dev` |
| `EADDRINUSE: address already in use :::3000` | порт занят: `PORT=3001 npm run dev` и `APP_URL=http://localhost:3001` (PowerShell: `$env:PORT=3001`) |
| Миграции «уже применены», но таблиц нет | проверьте, что `DATABASE_URL` указывает на нужную базу; `migrate` идемпотентен |
| Тесты падают на подключении | PostgreSQL не запущен или `TEST_DATABASE_URL` смотрит не на тестовую базу |

## Данные и лицензия

Все компании, каналы, клиенты, заказы и суммы в демо — вымышленные и сгенерированы детерминированно для
демонстрации. Совпадения с реальными организациями случайны; использовать эти цифры для бизнес-решений нельзя.

Учебный проект БГУИР. Сторонние шрифты распространяются по своим лицензиям, тексты лицензий лежат в
`public/fonts/`.
