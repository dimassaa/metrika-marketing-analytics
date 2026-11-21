# Метрика

Веб-приложение для оценки эффективности маркетинговых каналов: CAC, когортный LTV и ROMI по каждому каналу,
атрибуция, сценарии бюджета. Курсовой проект БГУИР.

![Лендинг «Метрики»](docs/screenshots/m1/landing-desktop.png)

Демо-бренд — «Метрика», демо-компания — вымышленный интернет-магазин кофе «Зёрна» из Минска. Все суммы в
белорусских рублях (BYN), расчётные даты — Europe/Minsk. Интерфейс и подписи на русском, код и имена в БД —
на английском.

## Что уже работает (M1)

- Публичный лендинг с SEO: canonical, Open Graph, JSON-LD, `robots.txt`, `sitemap.xml`, один `<h1>`.
- Вход по email и паролю (argon2id), серверные сессии в PostgreSQL, CSRF, rate-limit, безопасный `next`.
- Три роли с разными правами: администратор, аналитик, наблюдатель. RBAC проверяется на сервере, а не только
  скрытием ссылок.
- Каркас приложения: сайдбар по правам, topbar с якорем данных, пустой дашборд с честным «нет данных»,
  read-only список пользователей, страницы 403/404/500.
- PostgreSQL-схема из 15 таблиц с FK/CHECK/UNIQUE и детерминированный сид: 8 каналов, 32 кампании, 4 000 клиентов,
  14 месяцев статистики.
- Один stylesheet `public/css/app.css`, локальные шрифты Inter / Inter Tight / знак BYN, без CDN.

Движка метрик, импорта, графиков и сценариев ещё нет: KPI показывают «—», а не выдуманные числа. Дальше по
дорожной карте — M2 (данные и администрирование), M3 (расчёт CAC/LTV/ROMI), M4 (React-аналитика),
M5 (решения), M6 (полировка и деплой). Полный план: [`docs/superpowers/plans/2026-11-21-metrika-roadmap.md`](docs/superpowers/plans/2026-11-21-metrika-roadmap.md).

## Стек

| Слой | Технологии |
|---|---|
| Runtime | Node.js 22+ (рекомендуется 24 LTS), ESM |
| Сервер | Express 5, EJS 3 + `express-ejs-layouts`, Zod, pino |
| БД | PostgreSQL 18, драйвер `pg`, SQL-миграции без ORM |
| Auth | `express-session` + `connect-pg-simple`, `@node-rs/argon2`, CSRF, `express-rate-limit` |
| Безопасность | helmet с явной CSP, параметризованный SQL, экранирование EJS |
| Тесты | Vitest + Supertest |
| Клиент | React 19 + Vite 7 + Recharts 3 — появятся в M4; в M1 только серверный рендер |

TypeScript не используется. Второго CSS-файла, CSS-фреймворков и CDN нет.

## Быстрый старт с чистого клона

Нужны Node.js, npm и запущенный PostgreSQL 18. Роль БД должна уметь создавать базы (или базы создаются вручную).

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
- Если ваш PostgreSQL использует **peer/trust-аутентификацию** (типично для Linux-пакета), пароль не нужен:
  укажите роль и сокет, например `postgres:///metrika_dev` для текущего пользователя ОС или
  `postgres:///postgres` для служебной роли. Имя роли должно существовать в PostgreSQL.
- Если используется **пароль**, оставьте формат `postgres://пользователь:пароль@localhost:5432/имя_базы`.
  Спецсимволы в пароле кодируются процентным экранированием.
- `ADMIN_DATABASE_URL` нужен только скрипту `db:setup`: это подключение к служебной базе `postgres` от роли,
  у которой есть право `CREATEDB`.

Также задайте `SESSION_SECRET` (не короче 32 символов):

```bash
openssl rand -hex 32
```

Для локальной разработки оставьте `APP_URL=http://localhost:3000` и `COOKIE_SECURE=false`.

Создайте базы, накатите схему и заполните демо-данными:

```bash
npm run db:setup     # создаёт metrika_dev и metrika_test, если их нет; повторный запуск безопасен
npm run migrate      # применяет SQL-миграции
npm run seed         # детерминированный демо-сид
npm run dev          # http://localhost:3000
```

`db:setup` создаёт только пустые базы. Схему даёт `migrate`, данные — `seed`. Пароль из сида не логируется.

Проверка: `http://localhost:3000/health` возвращает `{"status":"ok","db":"up"}`.

## Демо-аккаунты

| Email | Роль | Что доступно |
|---|---|---|
| `admin@metrika.by` | Администратор | всё, включая пользователей и аудит |
| `analyst@metrika.by` | Аналитик | каналы, кампании, импорт, цели, сценарии |
| `viewer@metrika.by` | Наблюдатель | просмотр и экспорт, без импорта и администрирования |

Пароль всех трёх аккаунтов: **`Metrika2026!`**

> Это демонстрационный стенд с вымышленными данными. Пароль опубликован намеренно и для production не годится:
> перед любым публичным запуском смените пароли, `SESSION_SECRET`, включите `COOKIE_SECURE=true` и HTTPS.

## Скрипты

| Команда | Что делает |
|---|---|
| `npm run dev` | сервер с `node --watch` на `PORT` (по умолчанию 3000) |
| `npm start` | сервер без наблюдения за файлами |
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
  routes/                    публичные, auth и /app-маршруты
  controllers/               HTTP: разбор входа, Zod, выбор шаблона
  services/                  бизнес-логика без Express
  repositories/              параметризованный SQL и маппинг строк
  middleware/                auth, CSRF, rate-limit, ошибки, request id
  lib/                       логгер, БД, сессии, CSRF, SEO, даты
  views/                     EJS: layouts, partials, pages, errors
db/
  migrations/                SQL-схема
  migrate.js, setup.js       раннер миграций и bootstrap баз
  seed/                      детерминированный генератор демо-данных
public/
  css/app.css                единственный stylesheet
  fonts/, img/               локальные шрифты и SVG
tests/
  unit/, integration/        Vitest + Supertest
docs/
  superpowers/specs/         архитектура, метрики, трассировка требований
  superpowers/plans/         дорожная карта и планы этапов
  screenshots/m1/            скриншоты и журнал браузерной проверки
```

## Документация

- [Архитектура и границы](docs/superpowers/specs/2026-11-21-marketing-analytics-design.md)
- [Формулы CAC, LTV, ROMI и краевые случаи](docs/superpowers/specs/2026-11-21-metrics-spec.md)
- [Трассировка требований задания](docs/superpowers/specs/2026-11-21-assignment-traceability.md)
- [Дорожная карта M1–M6](docs/superpowers/plans/2026-11-21-metrika-roadmap.md)
- [План этапа M1](docs/superpowers/plans/2026-11-21-metrika-m1-foundation.md)
- [Журнал E2E и скриншоты M1](docs/screenshots/m1/README.md)
- [Отложенные улучшения](IMPROVEMENTS.md)

## Windows 10

Короткая версия; полная инструкция с Docker и резервным копированием появится в M6.

1. Установите Node.js 24 LTS и PostgreSQL 18 (установщик с официального сайта).
2. Добавьте `bin` PostgreSQL в `PATH` или запускайте `createdb`/`psql` из каталога установки.
3. В PowerShell: `Copy-Item .env.example .env`, затем отредактируйте URL и `SESSION_SECRET`.
4. `npm ci`, `npm run db:setup`, `npm run migrate`, `npm run seed`, `npm run dev`.
5. Откройте `http://localhost:3000`.

Если `db:setup` не может подключиться, проверьте службу PostgreSQL и пароль роли в `ADMIN_DATABASE_URL`.

## Если что-то не запускается

| Симптом | Причина и действие |
|---|---|
| `database "metrika_dev" does not exist` | базы ещё нет: выполните `npm run db:setup` |
| `password authentication failed for user ...` | неверный URL, пароль или `pg_hba.conf`. Проверьте `psql "$DATABASE_URL"`; для peer-auth уберите пароль из URL |
| `db:setup failed: ... permission denied to create database` | у роли в `ADMIN_DATABASE_URL` нет `CREATEDB`. Дайте право или создайте базы вручную через `createdb` |
| `TEST_DATABASE_URL is not set` | скопируйте `.env.example` в `.env` и заполните тестовую базу |
| `EADDRINUSE: address already in use :::3000` | порт занят: `PORT=3001 npm run dev` и `APP_URL=http://localhost:3001` (PowerShell: `$env:PORT=3001`) |
| Миграции «уже применены», но таблиц нет | проверьте, что `DATABASE_URL` указывает на нужную базу; `migrate` идемпотентен |
| Тесты падают на подключении | PostgreSQL не запущен или `TEST_DATABASE_URL` смотрит не на тестовую базу |

## Данные и лицензия

Все компании, каналы, клиенты, заказы и суммы в демо — вымышленные и сгенерированы детерминированно для
демонстрации. Совпадения с реальными организациями случайны; использовать эти цифры для бизнес-решений нельзя.

Учебный проект БГУИР. Сторонние шрифты распространяются по своим лицензиям, тексты лицензий лежат в
`public/fonts/`.
