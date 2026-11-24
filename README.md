# Метрика

Веб-приложение для оценки эффективности маркетинговых каналов: CAC, когортный LTV и ROMI по каждому каналу,
атрибуция, алерты и сценарии бюджета. Курсовой проект БГУИР.

![Лендинг «Метрики»](docs/screenshots/m6/guide/landing.png)

Демо-бренд — «Метрика», демо-компания — вымышленный интернет-магазин кофе «Зёрна» из Минска. Все суммы — в
BYN, расчётные даты — Europe/Minsk. Интерфейс и подписи на русском, код и имена в БД — на английском.

- Руководство пользователя: [docs/user-guide.md](docs/user-guide.md).
- Установка, Docker, Windows 10, TLS и резервные копии: [docs/deployment.md](docs/deployment.md).

## Что уже работает (M1–M6)

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
- **M6:** Docker-стенд с multi-stage образом, non-root пользователем, read-only rootfs, healthcheck по `r.ok` и
  Compose без правки `.env`. База не публикуется наружу, приложение слушает только `127.0.0.1`.
- **M6:** шифрованные резервные копии `pg_dump -Fc` + AES-256-GCM, retention только для `metrika-*.dump.enc`,
  восстановление в scratch-базу с проверкой «row-count + key checksum», отдельный ключ в файле `0600`.
- **M6:** security-заголовки и CSP, лимиты входа и импорта, маршрутный аудит RBAC/CSRF, `X-Robots-Tag` и
  `no-store` на приватных страницах, `noindex` для `/app` и `/api`.
- **M6:** доступность WCAG 2.2 AA: контраст, кольцо фокуса `#2f8bd0`, порядок Tab, таблицы-дубли графиков,
  отсутствие горизонтального переполнения на 390×844. Единственное документированное исключение — highlight-span
  заголовка (2,29:1), зафиксировано в `IMPROVEMENTS.md` как брендовое решение. PNG Open Graph 1200×630, SEO-проверки
  и `docs/security-audit.md` / `docs/performance.md`.
- **M6:** E2E-матрица трёх ролей в Chromium, проверка 403/404/500, импорта, медиа, алертов и сценариев; скриншоты
  и журнал — в `docs/screenshots/m6/README.md`.
- PostgreSQL-схема из 15+ таблиц с FK/CHECK/UNIQUE, миграции `001`–`006`; детерминированный сид: 8 каналов,
  32 кампании, 4 000 клиентов, 14 месяцев статистики.
- Один stylesheet `public/css/app.css`, локальные шрифты Inter / Inter Tight / знак BYN, без CDN.

Границы M6: новых аналитических функций нет. M6 — эксплуатационный контур, исправления подтверждённых дефектов
с регрессионными тестами и документация. Windows 10, Docker Desktop, Firefox и публичный HTTPS-стенд остаются
прогоном владельца: агент их не выполнял и не выдаёт за проверенные. Полный план:
[`docs/superpowers/plans/2026-11-21-metrika-roadmap.md`](docs/superpowers/plans/2026-11-21-metrika-roadmap.md).

## Стек

| Слой | Технологии |
|---|---|
| Runtime | Node.js 24 LTS (`engines.node` — `>=24`), ESM |
| Сервер | Express 5, EJS 3 + `express-ejs-layouts`, Zod, pino |
| БД | PostgreSQL 18, драйвер `pg`, SQL-миграции без ORM |
| Auth | `express-session` + `connect-pg-simple`, `@node-rs/argon2`, CSRF, `express-rate-limit` |
| Безопасность | helmet с явной CSP, параметризованный SQL, экранирование EJS, шифрованные бэкапы |
| Тесты | Vitest + Supertest, E2E в Chromium через agent-browser |
| Клиент | React 19 + Vite 7 + Recharts 3 — по одному острову на экран; данные приходят из `data-props`, отдельных запросов нет |
| Эксплуатация | Docker/Compose, healthcheck, `pg_dump`/`pg_restore`, Caddy/nginx |

TypeScript не используется. Второго CSS-файла, CSS-фреймворков и CDN нет.

## Быстрый старт: Docker

Основной путь для демонстрации и проверки. Нужны Docker Engine 27+ и Compose v2 (плагин `docker compose`).
Файл `.env` не нужен: все значения имеют дефолты, база и секрет сессии создаются внутри контейнеров.

```bash
git clone <URL-репозитория> metrika
cd metrika
docker compose up --build -d
docker compose ps
curl -fsS http://127.0.0.1:3000/health
```

Приложение слушает только `127.0.0.1:3000`, PostgreSQL наружу не публикуется. `docker compose up` применяет
миграции и сеет демо-данные только на пустой БД; повторный запуск данные не перезаписывает.

Демо-вход: `admin@metrika.by` / `Metrika2026!`. Остановка и сброс:

```bash
docker compose down       # контейнеры удалены, named volumes с БД и секретом сохранены
docker compose down -v    # полный сброс: БД, секрет сессии, бэкапы и ключ бэкапа в app_data
```

`down -v` удаляет и ключ из `app_data`: без копии на хосте старые бэкапы не расшифровать. Перед сбросом:
`docker compose cp app:/app/data/backup.key ./backup.key.offline` и `chmod 600 ./backup.key.offline`
([ротация и архив](docs/deployment.md#76-ротация-и-архив-ключа)).

Если команда `docker compose` не найдена, установите плагин по
[руководству по развёртыванию](docs/deployment.md#21-предусловие-плагин-compose). Windows/Docker Desktop и
резервные копии описаны там же.

## Быстрый старт: native

Нужны Node.js 24 LTS (`engines.node` — `>=24`), npm и запущенный PostgreSQL 18. Роль БД должна уметь создавать
базы (или базы создаются вручную).

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

Docker-сборка (multi-stage, non-root, read-only rootfs, копирование `public/assets`) и Compose-стенд описаны в
[руководстве по развёртыванию](docs/deployment.md). Образ не содержит тестов, документации и `.env`.

Бюджет сборки проверяется тестом `tests/integration/build-output.test.js`: вход каждой страницы — не больше
210 KB gzip, вся страница (entry + общие чанки) — не больше 250 KB gzip. В M6 страницы занимают 200–223 KB gzip;
самая тяжёлая часть — общий React + Recharts чанк. Остров не импортирует CSS, не делает `fetch` и не содержит
inline-стилей; графики идут через Recharts, а их данные дублируются таблицей внутри `<details>`. Один общий чанк
React + Recharts кэшируется между страницами, поэтому вес `npm run build` меньше суммы входов.

`db:setup` создаёт только пустые базы. Схему дают миграции `001`–`006`, данные — `seed`. Пароль из сида не
логируется. `npm run seed` — **разрушительная операция**: он выполняет
`TRUNCATE … RESTART IDENTITY CASCADE` для всех демо-таблиц, кроме `schema_migrations`, и заново вставляет
детерминированный набор. Очищаются:

`users`, `sessions`, `channels`, `campaigns`, `daily_stats`, `customers`, `touchpoints`, `orders`, `goals`,
`alerts`, `scenarios`, `audit_log`, `import_batches`, `media_assets`.

Практические последствия: всех уже вошедших разлогинит (сессии удалены), пропадут загруженные аватары и
пользовательские медиа, история аудита, скрытые алерты, сохранённые сценарии, импорты, цели и все данные. OG-обложка
восстанавливается из committed `public/img/og-cover.png`. **Никогда не запускайте `npm run seed` на живом стенде**;
он нужен только для чистой демонстрационной базы.

Проверка: `http://localhost:3000/health` возвращает `{"status":"ok","db":"up","version":"1.0.0"}`. При недоступной
БД тот же маршрут отвечает `503` с `{"status":"error","db":"down","version":"1.0.0"}`; Compose-контейнер становится
`unhealthy`.

## Демо-аккаунты

| Email | Роль | Права роли |
|---|---|---|
| `admin@metrika.by` | Администратор | все права, включая управление пользователями и просмотр аудита |
| `analyst@metrika.by` | Аналитик | просмотр + управление каналами, кампаниями, целями, сценариями, алертами и импорт |
| `viewer@metrika.by` | Наблюдатель | просмотр всех разделов + право экспорта |

Пароль всех трёх аккаунтов: **`Metrika2026!`**

Все экраны приложения работают на демо-данных: дашборд, каналы, паспорт канала, кампании, когорты, атрибуция,
алерты, сценарии и цели. Аналитик управляет каналами, кампаниями, целями, сценариями, алертами, импортом и
экспортом; администратор дополнительно управляет пользователями, OG-обложкой и смотрит аудит; наблюдатель видит
аналитику, алерты, сохранённые сценарии и экспорт, но не меняет данные и не запускает пересчёт. Подробно —
[руководство пользователя](docs/user-guide.md).

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
| `npm run seed` | **очищает все демо-таблицы** и пересоздаёт детерминированный набор; только для чистой БД |
| `npm run backup` | `pg_dump -Fc` + AES-256-GCM в `metrika-*.dump.enc`; retention и ключ — `docs/deployment.md` |
| `npm run restore -- --file …` | расшифровка и `pg_restore` в scratch-базу; `--verify` сравнивает row-count + key checksum |
| `npm test` | Vitest: юнит- и интеграционные тесты на `TEST_DATABASE_URL` |
| `npm run check:fresh` | чистый клон от коммита: `npm ci`, `.env` из шаблона, временная БД, migrate/seed/build/start, `/`, `/login`, `/health` и вход admin; каталог и БД удаляются |
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
scripts/
  backup.js, restore.js      шифрованные копии, retention, восстановление и --verify
  seed-demo.js               сид только при пустых users/channels/daily_stats
  lib/backup-format.js       формат AES-256-GCM и работа с ключом
  explain-queries.js         EXPLAIN для отчёта о производительности
docker/
  entrypoint.sh              секрет сессии, миграции, автосид, exec сервера
public/
  css/app.css                единственный stylesheet
  assets/                    артефакт `npm run build`, в git не входит
  js/                        острова загрузки файлов без фреймворка
  fonts/, img/               локальные шрифты и PNG-обложка
tests/
  unit/, integration/        Vitest + Supertest, включая docs-links
docs/
  deployment.md              Docker, native, Windows 10, TLS, бэкапы, диагностика
  user-guide.md              роли и все экраны с актуальными снимками
  security-audit.md          маршруты, RBAC, CSRF, заголовки и остаточные риски
  performance.md             EXPLAIN, бюджеты запросов и размеры бандлов
  superpowers/specs/         архитектура, метрики, трассировка требований
  superpowers/plans/         дорожная карта и планы этапов
  screenshots/m1, m2, m4, m5/  журналы браузерной проверки этапов
  screenshots/m6/            E2E, a11y, ошибки и снимки для руководства
```

## Документация

- [Руководство пользователя](docs/user-guide.md)
- [Развёртывание: Docker, native Linux, Windows 10, TLS, бэкапы](docs/deployment.md)
- [Аудит безопасности](docs/security-audit.md)
- [Производительность и размеры бандлов](docs/performance.md)
- [Архитектура и границы](docs/superpowers/specs/2026-11-21-marketing-analytics-design.md)
- [Формулы CAC, LTV, ROMI и краевые случаи](docs/superpowers/specs/2026-11-21-metrics-spec.md)
- [Трассировка требований задания](docs/superpowers/specs/2026-11-21-assignment-traceability.md)
- [Дорожная карта M1–M6](docs/superpowers/plans/2026-11-21-metrika-roadmap.md)
- [План этапа M1](docs/superpowers/plans/2026-11-21-metrika-m1-foundation.md)
- [План этапа M2](docs/superpowers/plans/2026-11-21-metrika-m2-data.md)
- [План этапа M3](docs/superpowers/plans/2026-11-22-metrika-m3-metrics.md)
- [План этапа M4](docs/superpowers/plans/2026-11-23-metrika-m4-analytics-ui.md)
- [План этапа M5](docs/superpowers/plans/2026-11-24-metrika-m5-decisions.md)
- [План этапа M6](docs/superpowers/plans/2026-11-25-metrika-m6-delivery.md)
- [Журнал E2E и скриншоты M1](docs/screenshots/m1/README.md)
- [Журнал E2E и скриншоты M2](docs/screenshots/m2/README.md)
- [Журнал E2E и скриншоты M4](docs/screenshots/m4/README.md)
- [Журнал E2E и скриншоты M5](docs/screenshots/m5/README.md)
- [Журнал M6: Docker, бэкапы, a11y, E2E и снимки для руководства](docs/screenshots/m6/README.md)
- [Отложенные улучшения](IMPROVEMENTS.md)

## Windows 10

Полная пошаговая инструкция — [docs/deployment.md §5](docs/deployment.md#5-windows-10). Короткая версия:

1. Установите Node.js 24 LTS и PostgreSQL 18 (официальные установщики); новый PowerShell должен видеть
   `node -v` и `psql --version`.
2. Добавьте `C:\Program Files\PostgreSQL\18\bin` в `PATH` или задайте `PG_DUMP`/`PG_RESTORE` абсолютными путями.
3. `Copy-Item .env.example .env`, заполните URL, `SESSION_SECRET` и пути бэкапов; пароль БД с `@ : / ?`
   percent-encode.
4. `npm ci`, `npm run db:setup`, `npm run migrate`, `npm run seed`, `npm run build`, `npm start`.
5. Проверьте `http://localhost:3000/health` и вход. Docker Desktop — альтернатива в §5.5, Планировщик заданий —
   в §5.7.

> Windows-путь в этом репозитории **не проверялся**: у агента нет Windows-машины. Инструкция готова, но результат
> подтверждает владелец и дописывает в журнал M6.

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
| `docker compose` не найден | установите плагин Compose v2; без него Docker-путь не считается проверенным |
| `/health` = `503` | PostgreSQL недоступен; контейнер `unhealthy`, проверьте `docker compose logs db` |
| Бэкап: неверный ключ или права файла | ключ ровно 32 байта, файл `0600`; Windows ACL проверяется через `icacls` |

Полная таблица диагностики, включая ошибки Windows, бэкапов и restore, — в
[docs/deployment.md §9](docs/deployment.md#9-диагностика).

## Данные и лицензия

Все компании, каналы, клиенты, заказы и суммы в демо — вымышленные и сгенерированы детерминированно для
демонстрации. Совпадения с реальными организациями случайны; использовать эти цифры для бизнес-решений нельзя.
Демо-пароль опубликован намеренно и не годится для production.

Учебный проект БГУИР. Сторонние шрифты распространяются по своим лицензиям, тексты лицензий лежат в
`public/fonts/`. Лицензия на код пока не выбрана: в корне лежит `LICENSE`-плейсхолдер, права не предоставлены, пока
владелец не заменит его на MIT или проприетарный текст. Замена не ломает `tests/unit/publication.test.js`; порядок —
[§4 публикационного пакета](docs/publication.md#4-статус-лицензии).
