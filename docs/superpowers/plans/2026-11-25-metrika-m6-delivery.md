# M6 «Полировка и сдача» — план реализации

> **Для агентов:** обязательный навык — `superpowers:subagent-driven-development` (рекомендуется) или
> `superpowers:executing-plans`. Задачи выполнять по порядку, шаги отмечать `- [x]`, коммит — в конце задачи.
>
> **Модель исполнителя и ревьюера:** `opencode-go/deepseek-v4.1-flash` (`AGENTS.md` §3). Другие модели не выбирать,
> даже если кажется, что они подходят лучше.

**Цель:** довести готовый продукт M1–M5 до состояния, которое можно поднять с чистого клона, показать на защите и
передать в репозиторий: воспроизводимый Docker-стенд, шифрованные резервные копии с проверенным восстановлением,
закрытые дыры production-конфигурации, вычитанная доступность и SEO, измеренная производительность, руководства
пользователя и развёртывания, E2E-матрица тремя ролями. Новых аналитических возможностей M6 не добавляет: формулы,
экраны и API остаются такими, какими их закрыли M3–M5. Любая правка M6 — либо ops-контур, либо исправление
подтверждённого дефекта с регрессионным тестом; «заодно улучшить» запрещено.

**Явно вне этапа:** пояснительная записка, диаграммы IDEF0/UML и материалы защиты — работа владельца, агенты их не
пишут и не правят. Пуш в GitHub, создание удалённого репозитория и тег версии — только по отдельной команде
владельца; M6 заканчивается готовностью репозитория и предложением тега, а не публикацией.

**Архитектура:** прикладной контур не меняется. M6 добавляет эксплуатационный слой вокруг существующего
`routes → controllers → services → repositories → PostgreSQL` и React-островов:

```
Браузер ──HTTP──▶ Caddy/nginx (TLS, production) ──HTTP──▶ app-контейнер (Node 24, non-root, read-only rootfs)
                                                              │
                                                              ├──▶ PostgreSQL 18 (named volume)
                                                              ├──▶ /app/data  (session secret, backup key, tmp)
                                                              └──▶ /backup    (шифрованные дампы)

scripts/backup.js ──pg_dump -Fc──▶ AES-256-GCM ──▶ metrika-*.dump.enc
scripts/restore.js ──decrypt──▶ временный файл 0600 ──pg_restore──▶ scratch-БД ──verify──▶ drop
```

Единственные изменения product-кода: узкий loopback-флаг для демо-куки, явные security-заголовки, slow-query лог,
метаданные route-guard'ов для аудита, разметка доступности, OG-PNG по умолчанию, метатеги `noindex` для `/app` и
`/api`. Ни одного нового npm-пакета: Docker, бэкапы, проверки и генерация OG-картинки используют Node built-ins,
`pg_dump`, `pg_restore` и уже установленный Chromium через `agent-browser`.

**Стек:** Node 24 LTS, ESM, Express 5, EJS 3, PostgreSQL 18, Zod 4, React 19 + Recharts 3, Vite 7,
Vitest 3 + Supertest, agent-browser. `engines.node` поднимается до `>=24`, README называет Node 24; фактическая
версия Node попадает в журнал доказательств. Для контейнера: Docker Engine 27+ / Compose v2, `node:24-bookworm-slim`,
`postgres:18-alpine`, `postgresql-client-18` из PGDG (клиент обязан совпадать с мажором сервера, иначе `pg_dump`
отказывается работать). Windows-путь: Node 24 MSI/`winget`, PostgreSQL 18 installer, PowerShell, Планировщик
заданий; Docker Desktop — альтернатива.

**Спеки:** `docs/superpowers/specs/2026-11-21-marketing-analytics-design.md` §10 (безопасность, бэкапы, TLS),
§11 (логи, N+1, EXPLAIN, кэш), §12 (тесты), §13 (развёртывание, Windows, демо-доступ), §14–§15 (этапы и границы);
`docs/superpowers/specs/2026-11-21-assignment-traceability.md` §3 (инфраструктура, Windows, браузеры, руководства),
§4 (шифрование, резервирование), §7 (чек-лист приёмки); `docs/superpowers/specs/2026-11-21-metrics-spec.md` §0.1
(data anchor); `AGENTS.md` §2, §8–§12, §14; `docs/superpowers/plans/2026-11-21-metrika-roadmap.md` (M6).

## Global Constraints

1. Только JavaScript, ESM, импорты с `.js`. Ни одного `.ts`/`.tsx`, `tsx`, `ts-node`. Скрипты M6 — обычные `.js` на
   Node built-ins; shell — только `docker/entrypoint.sh` и короткие команды в документации.
2. Один stylesheet — `public/css/app.css`. Новых CSS-файлов, CSS-фреймворков, CSS-in-JS и inline `<style>` нет.
   React не импортирует CSS и не получает inline-стилей.
3. Слои не размываются: контроллер ≤ 40 строк, формулы только в сервисах, SQL только в репозиториях, шаблоны только
   форматируют готовые поля. M6 не переносит бизнес-логику в middleware, скрипты или Docker.
4. Деньги — целые копейки, `BIGINT`; валюта — BYN через `<span class="byn">BYN</span>`; `$`, `₽`, `руб.` запрещены.
   «Сегодня» — `referenceRepository.getDataAnchor()`, системные часы для расчётов не используются.
5. Секреты — только `.env` / переменные окружения / файл с правами 0600. В git, образ, логи, `docker inspect`-примеры
   и скриншоты не попадают реальные пароли, ключи и session secret. `.env.example` содержит только плейсхолдеры.
   Ключ бэкапа в контейнере — файл `BACKUP_KEY_FILE=/app/data/backup.key` (0600, named volume `app_data`) или
   смонтированный secret; переменная `BACKUP_KEY` в Compose-окружении не используется — она утекает в историю
   `docker inspect` и shell history.
6. Контейнер: multi-stage, runtime без devDependencies, `USER node` (non-root), `read_only: true`,
   `tmpfs: /tmp:mode=1777,size=256m`, `cap_drop: [ALL]`, `no-new-privileges`, `init: true`. Никаких `privileged`,
   `network_mode: host`, docker-socket. `NODE_ENV=production` задаётся только в финальной стадии и в Compose;
   build-стадия (`npm ci --include=dev`) обязана видеть devDependencies, иначе Vite не соберётся.
7. `docker compose up --build` с чистого клона поднимает app + PostgreSQL 18 без правки файлов: порт app — только
   `127.0.0.1`, БД наружу не публикуется, миграции применяются entrypoint'ом идемпотентно, демо-сид выполняется
   только когда одновременно пусты `users`, `channels` и `daily_stats` — иначе импортированные данные будут стёрты.
8. Volume для PostgreSQL 18 монтируется в `/var/lib/postgresql` (данные образа лежат в `/var/lib/postgresql/18/docker`),
   не в старый `/var/lib/postgresql/data`. Это осознанная проверка на грабли PG18, а не вкусовщина.
9. Production-guard нельзя обойти молча. Плейсхолдер `SESSION_SECRET`, `COOKIE_SECURE=false` и небезопасная кука
   отклоняются; единственное исключение — явный `DEMO_INSECURE_COOKIES=true` **и** loopback-хост в `APP_URL`
   (`localhost`, `127.0.0.1`, `[::1]`). Любой другой хост с этим флагом падает на старте. Весь guard и его тестовая
   матрица (все комбинации, `localhost.evil.com`, `127.0.0.1.evil.com`, `[::1].evil.com`, булевы значения
   `true/false` и отказ `0/1`) принадлежат Task 1; Task 3 этот код и матрицу не переписывает.
10. Бэкапы: `pg_dump -Fc` (`--format=custom`) → AES-256-GCM (32-байтный ключ, случайный 12-байтный IV на файл).
    Формат: `MAGIC` + `uint32BE headerLength` + JSON-заголовок `{v, alg, iv}` + ciphertext + 16-байтный тег **в
    трейлере**. Заголовок передаётся как AAD, поэтому его подмена ломает расшифровку; ciphertext не буферизуется
    целиком — только потоки фиксированного размера. Контейнер формата версионирован; повреждённый/подменённый файл
    отвергается, а не «восстанавливается частично». Расшифрованный дамп существует только как временный файл 0600 и
    удаляется в `finally`.
11. Retention удаляет только файлы, совпавшие с шаблоном `metrika-*.dump.enc` в каталоге бэкапов; чужие файлы не
    трогаются. Имя scratch-БД (`--database`) валидируется `/^[a-z][a-z0-9_]*$/` и экранируется `escapeIdentifier`,
    иначе — отказ до подключения. Восстановление в БД, совпадающую с `DATABASE_URL`, требует явного `--force`;
    проверка идёт в scratch-БД с суффиксом `_restore_check`.
12. Каждый небезопасный маршрут (`POST`/`PUT`/`PATCH`/`DELETE`) имеет CSRF и серверный guard; каждый guard несёт
    машиночитаемую метку, чтобы тест аудита падал при добавлении маршрута без защиты. Скрытие кнопки не считается.
13. Доступность: WCAG 2.2 AA для текста и управления, клавиатурный обход без ловушек, видимый `focus-visible`,
    таблицы-дубли графиков, `prefers-reduced-motion`, отсутствие переполнения страницы на 390×844. Focus-ring на
    canvas/Recharts проверяется отдельно: cyan на белом может не дать 3:1 — тогда кольцо темнее, решение и замер
    фиксируются. Единственное задокументированное исключение — брендовый highlight-span `#3398e1` на `#c1e1f7`
    (2,29:1), зафиксированный владельцем 24.11.2026; он не используется для основного текста.
14. SEO: уникальные `title` ≤ 60 и `description` ≤ 160, canonical, OG/Twitter, `og:image` — PNG 1200×630, JSON-LD,
    `sitemap.xml`, `robots.txt`; `/app` и `/api` — `noindex`. Только локальные шрифты, картинки и скрипты, без CDN.
15. Бюджеты не повышаются: entry ≤ 210 KB gzip, страница ≤ 250 KB gzip, query ceilings из
    `tests/integration/page-queries.test.js` остаются прежними. Индекс добавляется только после `EXPLAIN` с
    измеренным seq scan на растущей таблице; «на всякий случай» — запрещено.
16. Тесты — только `TEST_DATABASE_URL`; Docker-проверки — только на отдельном стенде/volume. Новый баг — сначала
    падающий регрессионный тест. UI проверяется кликами в реальном браузере; скриншот без клика доказательством не
    считается. Скриншоты — только `docs/screenshots/m6/`. Chromium (agent-browser) — единственный браузер, доступный
    агенту; Firefox, Windows и Docker Desktop прогоняет владелец. Агент пишет «не проверено здесь — <причина>» и не
    выдаёт чужой прогон за свой.
17. В отслеживаемых файлах и документации нет домашних путей, имён пользователей, паролей конкретной машины и
    локальных имён БД. README, `docs/deployment.md`, `docs/user-guide.md` воспроизводятся на чужой машине.
18. Коммит — в конце каждой задачи, формат `type: brief description`. Пуши, теги и релизы — только после явного
    одобрения владельца. PZ, диаграммы и защита — вне зоны агентов.
19. Docker-путь считается проверенным только по реальному выводу `docker compose`; при отсутствии плагина Compose
    действует путь из раздела «Предусловия окружения». Ручной `docker run` fallback не заменяет compose-доказательство
    и не открывает тег.

## Предусловия окружения (до Task 1)

1. **Плагин Compose.** На локальной машине `docker compose` может отсутствовать (Docker Engine без Compose v2). Это
   блокер T1/T8, а не мелочь: без реального `docker compose config/up` Docker-путь не доказан.
   - Проверка: `docker compose version`, `docker info`. Результат — в журнал M6.
   - Установка user-level без sudo: скачать pinned-релиз Compose v2 с GitHub Releases (артефакт под архитектуру,
     например `docker-compose-linux-x86_64`) в `~/.docker/cli-plugins/docker-compose`, `chmod +x`, проверить
     `docker compose version`. Версия пишется в журнал; «latest» вслепую не тянуть.
   - Если установка невозможна (нет сети, политика, архитектура без артефакта): fallback — `docker network create` и
     ручной `docker run` postgres 18 + app-образ с теми же env, volume и флагами `read_only`/`tmpfs`/`cap_drop`.
     Fallback подтверждает только образ, не Compose: T1/T8 остаются открытыми, Docker-путь помечается
     «не проверен — Compose недоступен», тег `v1.0.0` блокируется до реального compose-вывода.
2. **Окружение владельца.** Firefox, Windows 10 и Docker Desktop агенту недоступны. Агент оставляет запись
   «не проверено здесь — <причина>» и не заявляет результат; эти пункты закрывает владелец своим прогоном и подписью
   в журнале. Тег условен до этой подписи.
3. **Node 24.** `engines.node` — `>=24`, README называет 24. Фактические `node -v`/`npm -v` попадают в журнал и в
   отчёт каждой Docker/E2E-задачи. Зелёные тесты на Node 22 не считаются выполнением M6.

## Решения, требующие подтверждения владельца до старта

| № | Вопрос | Предлагаемое решение | Отвергнутая альтернатива |
|---|---|---|---|
| 1 | Как `docker compose up` работает без правки `.env`, если production-guard требует `COOKIE_SECURE=true`? | Узкий флаг `DEMO_INSECURE_COOKIES=true`, который принимается **только** при loopback `APP_URL`; compose ставит его и биндит порт на `127.0.0.1`. Публичный стенд обязан использовать HTTPS и `COOKIE_SECURE=true`. | `NODE_ENV=development` в compose: демо перестаёт проверять production-путь и маскирует guard-баги; отклонено. |
| 2 | Откуда session secret в контейнере? | Entrypoint генерирует 32 случайных байта в `/app/data/session-secret` (0600) при первом старте и экспортирует `SESSION_SECRET`; named volume `app_data` переживает рестарт. Владелец может задать `SESSION_SECRET` явно. | Статичный дефолт в compose: известный ключ сессии у всех клонов; отклонено. |
| 3 | Когда в compose появляются демо-данные? | `AUTO_SEED_DEMO=true` в compose: entrypoint после миграций запускает `scripts/seed-demo.js`, который сеет только при одновременной пустоте `users`, `channels`, `daily_stats`. Повторный `up` и стенд с импортированными данными не перезаписывает. | Автосид при каждом старте: `seed` чистит сессии и медиа; отклонено. Проверка только `users`: импортированные каналы/статистика без пользователей будут стёрты; отклонено. |
| 4 | Где живёт ключ бэкапа? | `BACKUP_KEY_FILE=/app/data/backup.key` (0600) в named volume `app_data` или смонтированный secret; для native — путь из `.env`. В репозитории и `.env.example` только плейсхолдер. Без ключа скрипт отказывается создавать бэкап. | `BACKUP_KEY` в Compose-окружении: ключ виден в `docker inspect`, истории shell и логах CI; отклонено. Ключ рядом с дампом или в БД: шифрование теряет смысл; отклонено. |
| 5 | Лицензия репозитория? | T8 добавляет `LICENSE`-плейсхолдер «права не предоставлены до решения владельца» и блокирует тег, пока владелец не выберет MIT/проприетарную. План лицензию не выбирает сам. | Молча добавить MIT: юридическое решение без владельца; отклонено. |
| 6 | Объём кросс-браузерной проверки? | Chromium (agent-browser) — полная матрица силами агента; Firefox, Windows 10 и Docker Desktop — прогон владельца с записью в журнал. Opera/Yandex — smoke владельца, если установлены. | Заявить «работает везде» без прогона или выдать ручной прогон владельца за проверку агента: противоречит трассировке §3; отклонено. |
| 7 | Что если плагин `docker compose` не установлен? | User-level установка бинаря в `~/.docker/cli-plugins/docker-compose` (см. «Предусловия окружения»); при провале — `docker run` fallback, честная пометка «compose не проверен» и блокировка тега. | Молча объявить Docker-задачу выполненной по `Dockerfile` и `docker compose config`-тексту без запуска; отклонено. |

## Файловая карта

| Действие | Путь | Ответственность |
|---|---|---|
| Create | `Dockerfile`, `.dockerignore`, `.gitattributes`, `docker/entrypoint.sh`, `docker-compose.yml` | multi-stage образ, non-root runtime, LF для shell/Dockerfile, БД и healthcheck |
| Create | `scripts/seed-demo.js` | сид только при пустых `users`, `channels`, `daily_stats` |
| Create | `scripts/lib/backup-format.js` | контейнер AES-256-GCM: MAGIC/header/AAD/ciphertext/tag, ключи, потоки |
| Create | `scripts/backup.js`, `scripts/restore.js` | дамп, шифрование, retention, восстановление и проверка |
| Create | `scripts/explain-queries.js`, `scripts/fresh-clone-check.js` | доказательства производительности и чистого клона |
| Create | `docs/deployment.md` (скелет в T1, наполнение T2/T3/T5, финал T7) | эксплуатация: Docker, native, Windows, TLS, бэкапы |
| Create | `docs/user-guide.md`, `docs/security-audit.md`, `docs/performance.md`, `docs/publication.md` | пользователь, аудит, замеры, публикация |
| Create | `docs/screenshots/m6/README.md`, `docs/screenshots/m6/**` | журнал доказательств, скриншоты E2E/Firefox/Windows |
| Create | `LICENSE` | плейсхолдер до решения владельца |
| Modify | `src/config/env.js`, `package.json` | guard целиком в T1, `engines.node >= 24` |
| Modify | `src/app.js`, `src/middleware/rateLimit.js`, `src/middleware/auth.js` | заголовки, `X-Robots-Tag`, per-IP лимитер, метки guard'ов |
| Create | `public/img/og-cover.png` | OG-картинка 1200×630 из SVG |
| Modify | `src/lib/seo.js`, `src/views/partials/head.ejs` | PNG по умолчанию, `og:image:alt` и размеры |
| Modify | `src/views/**`, `public/css/app.css` | доступность: scroll-контейнеры, подписи, контраст |
| Modify | `.env.example`, `README.md`, `IMPROVEMENTS.md`, `package.json` | финальные настройки, документация, triage, скрипты |
| Conditional | `db/migrations/007_m6_indexes.sql` | только если `EXPLAIN` докажет необходимость индекса |

`001`–`006` не редактируются. Если M6 действительно нужен индекс, он выходит отдельной миграцией `007`, идемпотентной
на пустой БД и проверенной `tests/integration/migrations.test.js`.

## Task 1: Docker-образ и compose-стенд

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `.gitattributes`, `docker/entrypoint.sh`, `docker-compose.yml`
- Create: `scripts/seed-demo.js`
- Create: `tests/integration/container-contract.test.js`, `tests/unit/seed-demo.test.js`
- Create: `docs/deployment.md` (скелет), `docs/screenshots/m6/README.md` (журнал доказательств)
- Modify: `src/config/env.js`, `.env.example`, `package.json` (`engines.node`), `tests/unit/config-env.test.js`

**Interfaces:**
- **Предусловие:** сначала проверяется `docker compose version`; при отсутствии плагина выполняется user-level
  установка из раздела «Предусловия окружения», иначе — только `docker run` fallback с пометкой «compose не
  проверен». Без реального вывода `docker compose config/up` задача не закрывается.
- Образ: stage `client-build` (Node 24, `npm ci --include=dev`, `COPY public ./public`, `npm run build`) держит исходный
  `public/` **и** собранный `public/assets`; stage `prod-deps` (`NODE_ENV=production npm ci --omit=dev`); runtime
  `node:24-bookworm-slim` с `postgresql-client-18` из PGDG. Runtime получает фронтенд одной строкой
  `COPY --from=client-build /app/public ./public` — иначе собранные ассеты и `og-cover.svg` теряются. `USER node`,
  рабочий каталог `/app`, каталоги `/app/data` и `/backup` принадлежат `node`. Runtime копирует только `src/`,
  `db/`, `scripts/`, `public/`, `package.json`, `package-lock.json` и prod `node_modules`.
- `.dockerignore`: `.env`, `.git`, `tests/`, `docs/`, `node_modules`, `public/assets` (билд-артефакт хоста не должен
  перекрывать сборку), `backups`, `coverage`, `.superpowers`. `.gitattributes`: `*.sh text eol=lf`,
  `Dockerfile text eol=lf` — иначе CRLF ломает entrypoint на Windows-клонах.
- `docker/entrypoint.sh` (`set -eu`): если `SESSION_SECRET` пуст — читает или генерирует
  `${SESSION_SECRET_FILE:-/app/data/session-secret}` с `0600`; создаёт `/app/data/tmp` с `0700` (крупный restore не
  влезает в tmpfs 256 MB); если `RUN_MIGRATIONS != false` — `node db/migrate.js` (без `npm`, без лишнего процесса в
  PID-цепочке); если `AUTO_SEED_DEMO=true` — `node scripts/seed-demo.js`; затем `exec "$@"`.
- `scripts/seed-demo.js` экспортирует `seedDemoIfEmpty({ pool, seedFn })` → `{ seeded, counts }`; CLI считает
  `users`, `channels`, `daily_stats` и вызывает `seed({ pool })` только если **все три** пусты. Ошибка БД/сида —
  ненулевой exit, контейнер не стартует «наполовину».
- Compose: `db` — `postgres:18-alpine`, `POSTGRES_USER=${POSTGRES_USER:-postgres}`,
  `POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-postgres}`, `POSTGRES_DB=${POSTGRES_DB:-metrika}`, volume
  `db_data:/var/lib/postgresql`, healthcheck `pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"`
  (`$$` — экранирование Compose, иначе подставится хост-переменная или пустая строка), без публикации порта.
  `app` — `build: .`, `depends_on: db: { condition: service_healthy }`, `127.0.0.1:${APP_PORT:-3000}:3000`,
  `NODE_ENV=production`,
  `DATABASE_URL=postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@db:5432/${POSTGRES_DB:-metrika}`,
  `APP_URL=http://localhost:${APP_PORT:-3000}`, `COOKIE_SECURE=false`, `DEMO_INSECURE_COOKIES=true`,
  `TRUST_PROXY=false`, `AUTO_SEED_DEMO=true`, `SESSION_SECRET_FILE=/app/data/session-secret`,
  `BACKUP_KEY_FILE=/app/data/backup.key`, `BACKUP_DIR=/backup`, `RESTORE_TMP_DIR=/app/data/tmp`; volumes
  `app_data:/app/data`, `backup_data:/backup`;
  `read_only: true`, `tmpfs: /tmp:mode=1777,size=256m`, `init: true`, `cap_drop: [ALL]`,
  `security_opt: [no-new-privileges:true]`. `BACKUP_KEY` в env не задаётся: ключ — файл в `app_data` (Task 2).
- Healthcheck: `node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() =>
  process.exit(1))"` — проверяется `r.ok`, поэтому 503 при недоступной БД делает контейнер `unhealthy`, а не
  «зелёным при живом процессе».
- `DEMO_INSECURE_COOKIES` и булевы флаги M6 (`COOKIE_SECURE`, `DEMO_INSECURE_COOKIES`, `AUTO_SEED_DEMO`,
  `RUN_MIGRATIONS`) в `env.js`: `z.enum(['true','false']).transform(v => v === 'true')` (default `false`), значения
  `0`/`1`/`yes` отклоняются с сообщением. `TRUST_PROXY` остаётся строковым/числовым, его формат не меняется. При
  `NODE_ENV=production` и `COOKIE_SECURE=false` guard требует флаг **и** loopback-хост `APP_URL`; loopback — точное
  сравнение hostname (`localhost`, `127.0.0.1`, `[::1]`), а не `includes`/`endsWith`, поэтому `localhost.evil.com` и
  `127.0.0.1.evil.com` падают. При `COOKIE_SECURE=true` флаг игнорируется. `env.cookieSecure` остаётся
  единственным потребителем в `session.js`. **Вся** матрица guard'а — здесь; Task 3 её не трогает.
- `docker compose config` обязан быть валидным без `.env`; `docker compose up --build` — healthy без правок.
- `docs/deployment.md` (скелет в этой задаче): требования, Docker-путь (с предусловием Compose), native Linux,
  таблица переменных; разделы Windows, TLS, бэкапы, troubleshooting создаются заглушками и наполняются в
  T2/T3/T5/T7.

**Steps:**
- [ ] **Step 1: Compose precondition.** `docker compose version`; при отсутствии — установка плагина (раздел
  «Предусловия окружения») и повторная проверка. Записать версию Compose, Docker Engine и `node -v` в
  `docs/screenshots/m6/README.md`. Если установка провалилась — перейти на `docker run` fallback и пометить T1/T8
  как «Docker-путь не проверен», не выдавая fallback за compose.
- [ ] **Step 2: Failing tests.** `container-contract.test.js` читает `Dockerfile`, `.dockerignore`, `docker-compose.yml`
  и проверяет: ≥ 3 стадий, runtime `USER` не `root`, `NODE_ENV=production` только в финальной стадии, ровно одна
  строка `COPY --from=client-build /app/public ./public`, копирование `public/assets` не из хоста, `public/assets`
  в `.dockerignore`, нет `COPY .env`; compose содержит `postgres:18`, healthcheck с `$$POSTGRES_USER`/`$$POSTGRES_DB`,
  `service_healthy`, `db_data:/var/lib/postgresql`, `127.0.0.1:` у app, `read_only`, `tmpfs` размером 256m,
  `DEMO_INSECURE_COOKIES`, `BACKUP_KEY_FILE`, отсутствие `BACKUP_KEY` в env, порт 5432 не публикуется, нет
  `privileged`. В `config-env.test.js` — полная матрица: production + `false` без флага → fail; флаг +
  `http://localhost:3000` → pass, `cookieSecure=false`; флаг + `http://192.168.1.10:3000` → fail; флаг +
  `http://localhost.evil.com`, `http://127.0.0.1.evil.com`, `http://[::1].evil.com` → fail; `https://...` + `true`
  → pass; `COOKIE_SECURE=false` без флага → fail; плейсхолдер `SESSION_SECRET` → fail; `DEMO_INSECURE_COOKIES=0`,
  `DEMO_INSECURE_COOKIES=1`, `COOKIE_SECURE=0`, `COOKIE_SECURE=1` → fail с русским сообщением, `false`/`true` → pass.
  `seed-demo.test.js` — пустые три таблицы вызывают `seedFn` один раз; непустые `channels`/`daily_stats` при пустых
  `users` — не вызывают; ошибка `seedFn` пробрасывается.
- [ ] **Step 3: Run and see fail.**
  `npx vitest run tests/integration/container-contract.test.js tests/unit/seed-demo.test.js tests/unit/config-env.test.js`.
- [ ] **Step 4: Implement config and seed helper.** Сначала `parseEnv` и `isLoopbackUrl` (чистые функции), затем
  `seed-demo.js` с инъекцией `seedFn`, затем CLI. Никаких `Number()` над id и никаких паролей в логах.
- [ ] **Step 5: Implement image and compose.** Dockerfile, entrypoint, `.dockerignore`, `.gitattributes`; затем
  `docker compose config` и `docker compose up --build -d`. Дождаться `healthy` у обоих сервисов. Проверить
  `docker compose exec app id -u` ≠ 0. Если Compose недоступен после попытки установки — выполнить ручной
  `docker run` fallback и оставить T1 в статусе «Docker-путь не проверен», а не закрывать.
- [ ] **Step 6: Smoke.** `curl -fsS http://127.0.0.1:3000/health`; вход `admin@metrika.by`;
  `docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from users"'` = 3;
  `touch /app/data/probe` внутри контейнера не падает; `docker compose restart` сохраняет сессию и данные;
  `docker compose down && docker compose up -d` сохраняет данные; `down -v` сбрасывает стенд. Health-контракт:
  `docker compose stop db` → `/health` отвечает 503, `docker inspect --format '{{.State.Health.Status}}'` даёт
  `unhealthy`; `docker compose start db` → снова `healthy`. Записать команды, вывод и версии в
  `docs/screenshots/m6/README.md` (раздел «Docker»); Firefox/Windows/Docker Desktop здесь не заявляются.
- [ ] **Step 7: Deployment skeleton.** Создать `docs/deployment.md` с проверенными командами Docker-пути и
  заглушками Windows/TLS/бэкапов; журнал M6 — с датой, SHA, версиями Node/PostgreSQL/Compose.
- [ ] **Step 8: Commit** — `build: add multi-stage Docker image and zero-edit compose stand`.

## Task 2: Резервное копирование и восстановление

**Files:**
- Create: `scripts/lib/backup-format.js`, `scripts/backup.js`, `scripts/restore.js`
- Create: `tests/unit/backup-format.test.js`, `tests/integration/backup-restore.test.js`
- Modify: `.env.example`, `package.json`, `docker-compose.yml`, `.gitignore`, `docs/deployment.md`,
  `docs/screenshots/m6/README.md`

**Interfaces:**
- Формат файла `v1`: `MAGIC` (`MTRKBK1\0`) + `uint32BE headerLength` + JSON header `{ v: 1, alg: 'aes-256-gcm', iv }`
  + ciphertext + **16-байтный тег GCM в трейлере**. Заголовок передаётся в `cipher.setAAD()` как исходные байты,
  поэтому подмена `v/alg/iv` ломает аутентификацию, а не меняет поведение расшифровки. `createdAt`, имя БД и версия
  `pg_dump` идут в лог и метаданные запуска, не в header; header не содержит ключ и не логируется. Для чтения размер
  ciphertext вычисляется как `fileSize - 8 - 4 - headerLength - 16`, без буферизации всего дампа в память.
- Ключ — ровно 32 байта: `BACKUP_KEY_FILE` (hex/base64, файл 0600; в Compose — `/app/data/backup.key` в `app_data`
  или смонтированный secret) или `BACKUP_KEY` для native-запуска. Плейсхолдер `replace-with-` отвергается. IV — 12
  случайных байт на файл.
- `encryptDump({ input, outputPath, key, meta })` и `decryptDump({ filePath, key, outputPath })` — потоки,
  атомарная запись через `*.tmp` + `rename`; при ошибке временный файл удаляется. `readHeader(filePath)` проверяет
  magic, версию, `headerLength` (конечное значение, не больше файла) и допустимые поля; битый/чужой файл —
  `BackupFormatError` с русским сообщением.
- `scripts/backup.js`: `npm run backup` (скрипт добавляется здесь, один раз); spawn `pg_dump` без shell (массив
  аргументов), `--format=custom --no-owner --no-acl`, stdout → шифрование →
  `${BACKUP_DIR:-./backups}/metrika-YYYY-MM-DDTHH-mm-ssZ.dump.enc`; retention `${BACKUP_RETENTION_DAYS:-7}` дней,
  удаляет только совпавшие файлы, минимум один оставляет; `--keep N` и `--out` для ручного запуска; коды выхода 0/1
  и понятные сообщения. `PG_DUMP`/`PG_RESTORE` переопределяют бинарь. Перед дампом сравниваются мажоры:
  `pg_dump` < server → отказ (данные новее формата), `pg_dump` > server → предупреждение и продолжение, версия
  печатается в лог.
- `scripts/restore.js`: `npm run restore -- --file <path> [--database metrika_restore_check] [--create] [--verify]
  [--force]`. `--database` валидируется `/^[a-z][a-z0-9_]*$/` и экранируется `escapeIdentifier`; несоответствие —
  отказ до подключения. Отказывается писать в БД из `DATABASE_URL` без `--force`; `--create` создаёт scratch через
  `ADMIN_DATABASE_URL` (default — как в `db/setup.js`:
  `postgres://postgres:postgres@localhost:5432/postgres`; роль обязана иметь `CREATEDB`); расшифровывает во временный
  файл `0600` в `${RESTORE_TMP_DIR:-os.tmpdir()}` и удаляет в `finally` (в Compose задан
  `RESTORE_TMP_DIR=/app/data/tmp`, потому что `/tmp` — tmpfs 256 MB и крупный дамп туда не влезет); `pg_restore --clean --if-exists
  --no-owner --no-acl`; `--verify` сравнивает не только `count(*)`, но и контрольную сумму ключевых колонок
  (например, `md5(string_agg(id::text, ',' ORDER BY id))`) по `users`, `channels`, `campaigns`, `customers`,
  `orders`, `daily_stats`, `audit_log`, печатает таблицу и завершается 1 при расхождении. В отчёте и
  `docs/deployment.md` проверка называется «row-count + key checksum»; если checksum не реализован — «row-count
  smoke» с явной пометкой, без слова «полная проверка».
- Windows: скрипт не использует shell-редиректы и текстовые режимы; `BACKUP_DIR`, `BACKUP_KEY_FILE`,
  `ADMIN_DATABASE_URL` читаются из `.env`. Задача Планировщика: principal — выделенная учётная запись или SYSTEM,
  режим «Выполнять независимо от того, вошёл ли пользователь в систему», `Program/script` — абсолютный
  `C:\Program Files\nodejs\node.exe`, аргументы — полный путь `...\scripts\backup.js`, рабочий каталог — корень
  репозитория. Ключ лежит в `C:\ProgramData\Metrika\backup.key` с ACL только для SYSTEM/администраторов (если
  задача идёт от пользователя — добавить этого пользователя только на чтение). После прогона проверяется «Последний
  результат» = `0x0`, файл появился и расшифровывается. Копирование бэкапа — только `Copy-Item`/`robocopy`, не
  PowerShell `>`/`Out-File` (они портят бинарный файл).
- Compose: `BACKUP_KEY_FILE=/app/data/backup.key`, `BACKUP_DIR=/backup`; `BACKUP_KEY` в env **не** задаётся. Ключ
  создаётся один раз внутри контейнера (32 случайных байта hex в `/app/data/backup.key`, `chmod 600`) или
  монтируется read-only из secret-хранилища. Бэкап — `docker compose exec app node scripts/backup.js`; забрать файл —
  `docker compose cp app:/backup/<file> .`.

**Steps:**
- [ ] **Step 1: Failing tests.** Unit: потоковый round-trip (без буферизации всего файла); header содержит ровно
  `v/alg/iv`; неверный ключ → ошибка; подмена байта ciphertext → GCM-ошибка; подмена `iv`/`v` в header → GCM-ошибка
  (AAD); обрезанный header → ошибка; обрезанный/изменённый трейлер-тег → ошибка; ключ длиной 16/31/33 байта
  отвергается; `headerLength` больше размера файла отвергается; retention выбирает только `metrika-*.dump.enc`,
  оставляет минимум один и не трогает `README.txt`; `--database 'bad;drop'` и `Bad-Name` отвергаются до подключения. Integration: если `pg_dump`/`pg_restore` доступны
  и задан `TEST_DATABASE_URL` (плюс admin URL из `ADMIN_DATABASE_URL` или дефолт `db/setup.js` с правом `CREATEDB`),
  дамп тестовой БД → шифрование → расшифровка → restore в `<test>_restore_check` → `--verify` зелёный → scratch
  удалён; при отсутствии бинарей или прав admin — пропуск с `console.warn`, называющим причину (не молчаливый skip).
- [ ] **Step 2: Run and see fail.** `npx vitest run tests/unit/backup-format.test.js tests/integration/backup-restore.test.js`.
- [ ] **Step 3: Implement format and scripts.** Сначала `backup-format.js` (чистые функции + потоки), затем CLI.
  `spawn` только с массивом аргументов, `shell: false`; stderr `pg_dump` не печатает пароль (URL редактируется).
- [ ] **Step 4: Verify on the real stand.** Создать `BACKUP_KEY_FILE` (32 байта hex, `chmod 600`; в контейнере —
  `/app/data/backup.key`) один раз и не коммитить. `npm run backup`, проверить `file`, размер, что `strings` не
  показывает SQL; `npm run restore -- --file ... --database metrika_restore_check --create --verify`; повторный
  `--verify` на повреждённой копии завершается 1. Записать в журнал M6.
- [ ] **Step 5: Deployment + Windows runbook.** Дополнить `docs/deployment.md`: создание ключа, ACL, команды
  Планировщика, проверка «Последний результат», ограничение tmpfs и `RESTORE_TMP_DIR`; в журнале — фактический
  прогон Windows (владелец) или явная пометка «не проверено здесь — Windows недоступен».
- [ ] **Step 6: Commit** — `feat: add AES-256-GCM backup and verified restore scripts`.

## Task 3: Security-заголовки, лимиты и аудит доступа

**Files:**
- Modify: `src/app.js`, `src/middleware/rateLimit.js`, `src/middleware/auth.js`, `src/middleware/csrf.js`
- Create: `tests/integration/security-headers.test.js`, `tests/integration/route-audit.test.js`,
  `docs/security-audit.md`
- Modify: `tests/integration/auth.test.js`, `tests/integration/rbac.test.js`, `docs/deployment.md`

**Interfaces:**
- Владение guard'ом: `env.js` и `tests/unit/config-env.test.js` уже закрыты Task 1 (полная матрица). Task 3 их не
  редактирует; если обнаружен пробел в guard'е — это возврат в T1 отдельным фиксом, а не тихая правка здесь.
- `app.js`: `helmet` 8.3 **не** предоставляет `permissionsPolicy`; заголовок ставится вручную
  `res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')`. Helmet отвечает за CSP,
  `X-Content-Type-Options`, `Referrer-Policy: no-referrer`. HSTS включается только при `env.cookieSecure`, иначе
  `hsts: false`. `X-Robots-Tag: noindex, nofollow` ставится на `/app` и `/api` (в дополнение к meta). CSP остаётся
  явным; `style-src-attr 'unsafe-inline'` документируется как вынужденный для Recharts, `script-src` без
  `unsafe-inline`.
- `rateLimit.js`: второй логин-лимитер `createLoginIpRateLimiter()` — 30 попыток/15 мин на адрес, тот же
  `rateLimitAddress`, `skipSuccessfulRequests: true`; применяется до пары `ip+email`. Пара остаётся 5/15 мин.
  Оба лимитера — per-app store, не модульные singleton'ы.
- `auth.js`: `requireAuth` и результат `requirePermission(permission)` получают несъёмные метки
  (`handler.auth = true`, `handler.permission = permission`) для интроспекции; поведение не меняется.
  `csrf.js`: `csrfProtection.csrf = true`.
- `route-audit.test.js`: собирает `createApp` с тестовым пулом и обходит `app.router.stack` (Express 5) рекурсивно
  по смонтированным роутерам. Для каждого route-слоя с небезопасным методом требует CSRF-метку в цепочке
  (своей или родительского mount) и guard; для `/app` и `/api` — auth/permission. Публичный allowlist только
  `/login` (CSRF есть) и `/logout`; всё остальное без метки — падение с печатью метода и пути. Если внутренний
  `router.stack` изменится при обновлении Express, тест падает явно, а не пропускает маршрут.
- `security-audit.md`: таблица «маршрут → метод → guard → CSRF → аудит-действие → тест»; отдельные разделы про
  сессии, куки, secret rotation, trust proxy, CSP, лимитеры, загрузки; найденные остаточные риски — с приоритетом.
- Slow-query: pino-хук логирует запросы > 200 ms с длительностью, именем операции и `user_id` (или `anon`), без SQL-
  параметров и тел запросов; если реализация выходит за разумный объём — запись в `IMPROVEMENTS.md` с причиной,
  а не тихое отсутствие.
- `docs/deployment.md`: раздел TLS/reverse-proxy (Caddy и nginx, HSTS, `COOKIE_SECURE=true`, `TRUST_PROXY=1`)
  наполняется здесь.

**Steps:**
- [ ] **Step 1: Failing tests.** `security-headers`: `/`, `/login`, `/app/*`, `/api/v1/*`, `/health` содержат
  `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` с точным значением
  `camera=(), microphone=(), geolocation=()`, `X-Robots-Tag` только у app/api, HSTS только при secure и отсутствует
  при `COOKIE_SECURE=false` (demo-режим не отдаёт HSTS); `route-audit`: находит ≥ 30 маршрутов и не находит ни
  одного мутирующего без CSRF/guard; `auth`: 6-я неудача той же пары → 429, 31-я неудача с разных email с одного IP
  → 429, успешный вход не расходует квоту.
- [ ] **Step 2: Run and see fail.**
  `npx vitest run tests/integration/security-headers.test.js tests/integration/route-audit.test.js tests/integration/auth.test.js`.
- [ ] **Step 3: Implement headers.** Никаких ослаблений CSP «чтобы работало»: если Recharts требует inline-атрибут
  стиля, это остаётся `style-src-attr`, а не `script-src 'unsafe-inline'`. `Permissions-Policy` — ручной
  `setHeader`, не выдуманная опция Helmet.
- [ ] **Step 4: Implement per-IP limiter and guard metadata.** Ключ IP — только литерал; forged `X-Forwarded-For`
  при `TRUST_PROXY=false` не должен менять ключ (проверить существующим тестом). Slow-query хук — в том же
  middleware-слое, без SQL-текста в логах.
- [ ] **Step 5: Manual audit.** Пройти `src/routes/app.routes.js`, `api.routes.js`, `auth.routes.js`,
  `public.routes.js`; сверить каждый мутирующий маршрут с `audit_log`; записать таблицу и расхождения в
  `docs/security-audit.md`. Проверить в браузере: viewer получает styled 403 на странице и JSON 403 на API;
  POST без `X-CSRF-Token` — 403; повторный логин после смены роли/блокировки — сессия отозвана (существующий тест).
- [ ] **Step 6: Deployment TLS section.** Дополнить `docs/deployment.md` разделами Caddy/nginx, HSTS и
  `COOKIE_SECURE=true`; публичный стенд без HTTPS описать как ошибку.
- [ ] **Step 7: Commit** — `fix: harden security headers, login limits and access audit`.

## Task 4: Доступность и мобильная ширина

**Files:**
- Modify: `public/css/app.css`, `src/views/layouts/app.ejs`, `src/views/layouts/public.ejs`,
  `src/views/partials/**`, `src/views/pages/**`, `client/components/**`
- Create: `tests/unit/contrast.test.js`, `tests/integration/a11y-markup.test.js`
- Modify: затронутые `tests/integration/*-screen.test.js`
- Create: `docs/screenshots/m6/a11y-*.png`

**Interfaces:**
- `contrast.test.js` читает токены из `public/css/app.css`, считает WCAG-контраст и проверяет пары: ink/soot на
  white и canvas ≥ 4,5; warm-gray на white/canvas ≥ 4,5; status `#2f7d5f`, `#a16207`, `#b91c1c` на white ≥ 4,5;
  ash-gray допускается только для disabled/placeholder и не для смыслового текста. Highlight-пара
  `#3398e1`/`#c1e1f7` — явное исключение с комментарием и ссылкой на решение владельца.
- `a11y-markup.test.js`: для каждой `/app`-страницы (dashboard, channels, passport, cohorts, attribution, alerts,
  scenarios, goals, import, audit, admin/users, profile) проверяет: ровно один `<h1>`, skip-link на `#main`,
  `aria-current="page"` у активного пункта, у каждой `<table>` есть `<caption>` или `aria-label`, каждый
  `.table-wrap` имеет `role="region"`, `tabindex="0"` и `aria-label`, каждая форма — `<label>`/`aria-label` у
  полей, у графиков `figure[aria-labelledby]` + таблица-дубль вне `role="img"`, у изображений `alt`.
- CSS: видимый `:focus-visible` (2 px `--color-cyan-edge`, offset 2 px) для ссылок, кнопок, полей, summary,
  scroll-контейнеров; `@media (prefers-reduced-motion: reduce)` отключает transitions/animation (уже есть —
  расширить на новые элементы); для focus-ring на canvas/Recharts проверить контраст кольца к белому и к линии
  графика: при < 3:1 взять более тёмное кольцо и записать фактическую пару в `docs/screenshots/m6/README.md`.
  Никаких `outline: none` без замены.
- Разметка: `table-wrap` без `tabindex` (admin-users, campaigns, goals, import, audit, channel-detail) получает
  тот же triple, что уже есть у алертов и сценариев; заголовки таблиц — `<caption class="visually-hidden">`;
  статусы — текст + точка, не только цвет; ошибки форм — `aria-invalid` + `aria-describedby`.
- 390×844: страница не расширяется (`scrollWidth === clientWidth`), таблицы скроллятся внутри карточки, tap-target
  ≥ 24×24 px, меню и topbar не перекрывают контент.

**Steps:**
- [ ] **Step 1: Failing tests.** `contrast.test.js` на текущих токенах (ожидаемо падает на ash-gray/placeholder и
  фиксирует highlight как исключение); `a11y-markup.test.js` падает на таблицах без `tabindex`/`caption` и на
  страницах без `aria-current`.
- [ ] **Step 2: Run and see fail.**
  `npx vitest run tests/unit/contrast.test.js tests/integration/a11y-markup.test.js`.
- [ ] **Step 3: Fix markup and CSS.** Только подтверждённые gaps: не переписывать дизайн, не менять сетку, не
  добавлять вторую тему. Любой визуальный сдвиг — проверить на 1280 и 390.
- [ ] **Step 4: Browser keyboard pass.** Для каждой роли: Tab от адресной строки до основного действия, Escape/Enter
  на меню, стрелки на слайдере сценария, открытие `<details>` таблицы-дубля, отсутствие фантомных Tab-стопов в
  Recharts (guard `client/lib/plot-focus.js` уже есть — проверить, что не сломан). Скриншоты focus-ring и 390 —
  `docs/screenshots/m6/a11y-*.png`; консоль и page errors пусты.
- [ ] **Step 5: Contrast spot-check в браузере.** Вычислить фактические цвета для 6–8 пар (не только токены), потому
  что opacity/фон карточки могут изменить результат; отдельно — focus-ring на canvas и статусные точки. Расхождения
  — исправить или записать в `IMPROVEMENTS.md`; фактические пары — в журнал.
- [ ] **Step 6: Commit** — `a11y: fix keyboard, table and contrast gaps`.

## Task 5: SEO, OG-PNG и измеренная производительность

**Files:**
- Create: `public/img/og-cover.png` (1200×630, committed), `scripts/explain-queries.js`, `docs/performance.md`
- Modify: `src/lib/seo.js`, `src/controllers/public.controller.js`, `src/views/partials/head.ejs` (если нужен
  `og:image:width/height/alt`), `tests/integration/landing.test.js`, `docs/deployment.md`
- Create: `tests/unit/og-image.test.js`, `tests/integration/cache-headers.test.js`
- Conditional: `db/migrations/007_m6_indexes.sql`, `tests/integration/migrations.test.js`

**Interfaces:**
- Границы задачи: `robots.txt`, `sitemap.xml`, `X-Robots-Tag`, cache-headers уже реализованы и зелёные в M1–M5. T5 не
  переписывает их, а закрепляет регрессионными тестами; красный тест здесь означает дефект, а не «новую фичу».
  Реальный объём T5: OG-PNG, `og:image:alt`/`twitter:image:alt`, размеры картинки и `EXPLAIN`-доказательства.
- `DEFAULT_OG_IMAGE = '/img/og-cover.png'` — статический PNG по умолчанию; `buildSeo` отдаёт абсолютный URL,
  `og:image:type=image/png`, `og:image:width=1200`, `og:image:height=630`, `og:image:alt` и
  `twitter:image:alt` с русским осмысленным текстом (не имя файла). SVG остаётся редактируемым источником; PNG
  генерируется локальным Chromium через `agent-browser` (скриншот 1200×630 с реальным Inter Tight), без новой
  зависимости и без canvas.
- OG из БД (`/media/<slug>/og-cover`) **откладывается**: в сиде лежит заглушка 1×1, и отдавать её как social
  preview — хуже статического PNG. Пункт фиксируется в `IMPROVEMENTS.md` как `deferred` (причина: 1×1 seeded
  asset; триггер: появление реального медиа-ассета), в коде остаётся статический дефолт.
- `tests/unit/og-image.test.js`: PNG-сигнатура, IHDR 1200×630, размер файла < 300 KB, `buildSeo` по умолчанию
  возвращает `/img/og-cover.png` и alt-текст. `landing.test.js`: `og:image` абсолютный и PNG, `og:image:alt` и
  `twitter:image:alt` непустые, `twitter:card=summary_large_image`, title ≤ 60, description ≤ 160, один `h1`,
  `lang="ru"`, JSON-LD парсится, canonical ровно один.
- `robots.txt`/`sitemap.xml`/`X-Robots-Tag`: только регрессия — `Disallow: /app`, `/api`; sitemap содержит только
  `/`; `/login` остаётся `noindex`; app/api не индексируются.
- `scripts/explain-queries.js`: `node scripts/explain-queries.js [--query dashboard|cohorts|attribution|passport]
  [--json]`; принимает **инъектируемый db-прокси**, который переписывает только одиночный `SELECT` (или
  `WITH … SELECT`) в `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` с теми же параметрами и **отклоняет любой
  не-SELECT** (`INSERT/UPDATE/DELETE/DDL/несколько выражений`) до выполнения. SQL не копируется в скрипт: запросы
  берутся из репозиториев через прокси; выполнение — в read-only транзакции, без записи. Печатает узел, индекс,
  rows, timing.
- `docs/performance.md`: таблица «запрос → план → индекс → rows → ms → решение»; N+1/query budgets; bundle sizes
  всех семи входов и общих чанков; политика кэша (`/assets` immutable 1y, `app.css` revalidate, `/app` no-store,
  `/api` no-store); вывод «индексы не добавлены» или обоснование `007`.
- `cache-headers.test.js`: регрессионный лок, не новая функциональность. Тест не зависит от локального
  `public/assets`: либо создаёт временную директорию с hashed-фикстурой и монтирует её, либо пропускает кейс с
  `console.warn` «нет сборки — проверьте `npm run build`», но не падает на чужой машине с чистым клоном.

**Steps:**
- [ ] **Step 1: Failing tests.** `og-image.test.js` (PNG ещё нет) и SEO-ассерты (сейчас SVG); `cache-headers.test.js`
  запускается как регрессионный лок и на fixture-директории должен быть зелёным — если он красный, это баг
  заголовков, фиксируется отдельно.
- [ ] **Step 2: Run and see fail.**
  `npx vitest run tests/unit/og-image.test.js tests/integration/landing.test.js tests/integration/cache-headers.test.js`.
- [ ] **Step 3: Generate OG PNG.** Поднять локальный сервер с собранными шрифтами, открыть `/img/og-cover.svg` в
  `agent-browser` при 1200×630, снять PNG, проверить `identify`/IHDR, закоммитить. Убедиться, что текст не уехал и
  шрифт настоящий (не fallback).
- [ ] **Step 4: Implement SEO defaults and regression locks.** Добавить `og:image:alt`/`twitter:image:alt`; если
  `express.static` для `app.css` отдаёт нежелательный `immutable`, разделить mounts: `/assets` immutable, `/css`,
  `/fonts`, `/img` — revalidate. Не включать aggressive caching для HTML. Изменения `robots`/`sitemap` — только при
  подтверждённом дефекте. Дополнить `docs/deployment.md` коротким разделом политики кэша (что immutable, что
  no-store), чтобы эксплуатация не включала «оптимизацию» HTML.
- [ ] **Step 5: Measure queries and bundle.** `npm run build`; `node scripts/explain-queries.js --json` для четырёх
  тяжёлых путей; `npx vitest run tests/integration/page-queries.test.js tests/integration/build-output.test.js`.
  Записать планы и размеры в `docs/performance.md`. Индекс добавлять только при seq scan на таблице, которая растёт
  с данными, и при подтверждённом выигрыше; иначе — секция «Отклонено».
- [ ] **Step 6: Commit** — `perf: add PNG Open Graph image, SEO checks and query evidence`.

## Task 6: E2E-матрица, ошибки и кросс-браузерная проверка

**Files:**
- Create: `tests/integration/error-pages.test.js`
- Modify: `docs/screenshots/m6/README.md`, `docs/screenshots/m6/*.png`
- Modify: `IMPROVEMENTS.md` (находки прогона), при необходимости — затронутые шаблоны/контроллеры

**Interfaces:**
- `error-pages.test.js` собирает мини-приложение из `createApp`-совместимых middleware (`notFoundPage`,
  `notFound`, `errorHandler`) и проверяет: HTML 404/403/500 — styled-страница с русским текстом, `noindex`, без
  stack trace; API 404/403/500 — JSON `{error:{code,message}}`, без stack; 500 не логирует тело запроса и куки.
  500-тест не требует падения БД: тестовый маршрут добавляется в мини-приложение, не в product router.
- Матрица (записать в журнал фактический результат, не «ожидаемо»):
  | Роль | Потоки | Обязательные проверки |
  |---|---|---|
  | admin | вход, дашборд, каналы/паспорт, пользователи (создать/роль/блокировка/сброс), аудит, импорт, экспорт, цели, алерты (пересчёт/скрыть), сценарии (сохранить), профиль | все действия доступны; `audit_log` пополняется; консоль пуста |
  | analyst | вход, дашборд, каналы (создать/изменить/архив), кампании, цели, импорт dry-run + commit, экспорт, алерты, сценарии | `/app/admin/users` и `/app/audit` → 403; мутации viewer → 403; CSRF без токена → 403 |
  | viewer | вход, дашборд, все аналитические экраны, экспорт, сохранённый сценарий, алерты | нет форм мутаций; прямой POST → 403 HTML/JSON; экспорт работает |
- Ошибки: 403 (page + API), 404 (page + API), 500 (styled + JSON), импорт (битый заголовок, дубликат, > 2 MB,
  > 10 000 строк, неверный MIME), медиа (неверный MIME, > 1 MB, чужой/несуществующий `id`), CSRF, rate-limit.
- Кросс-браузер: Chromium — полная матрица через `agent-browser` (клики, `console`, `errors`, 390×844). Firefox,
  Opera/Yandex, Windows 10 и Docker Desktop — **прогон владельца**; агент не заявляет их результат, а пишет
  «не проверено здесь — <причина>» и оставляет поля журнала для подписи владельца. Ручной сценарий Firefox (если
  владелец прогонит): login → dashboard → channels → attribution → scenarios (слайдер стрелками) → import dry-run.
  Windows smoke — по `docs/deployment.md`: native-путь, вход, импорт, backup + restore, Task Scheduler.
- Скриншоты: `login`, `dashboard-analyst`, `channels-analyst`, `cohorts`, `attribution`, `alerts`, `scenarios`,
  `admin-users`, `audit`, `import-error`, `403-viewer`, `404`, `500`, `mobile-390`; `firefox-*` — только если
  владелец их предоставил, с пометкой автора прогона. Каждый снимок — после клика, не только открытия.
- E2E идёт до финальных руководств: журнал и скриншоты должны быть готовы, когда T7 пишет `docs/user-guide.md`.

**Steps:**
- [ ] **Step 1: Failing error-page test.** Сначала тест на 500/403/404; убедиться, что отсутствие styled 500 —
  реальный пробел, а не выдумка.
- [ ] **Step 2: Run and see fail.** `npx vitest run tests/integration/error-pages.test.js`.
- [ ] **Step 3: Fix only confirmed defects.** Если 500 уже styled — тест фиксирует контракт, кода не трогаем. Любой
  найденный в прогоне баг — регрессионный тест в том же коммите.
- [ ] **Step 4: Full Chromium E2E.** Поднять чистый стенд (сид + build), пройти матрицу тремя ролями; на каждом шаге
  `agent-browser console` и `errors`; проверить 390×844 на каждом экране; записать команды, дату, SHA, версии
  Node/PostgreSQL/Chromium.
- [ ] **Step 5: Owner-supplied evidence.** Заполнить разделы Firefox/Windows/Docker Desktop явной пометкой «не
  проверено здесь — <причина>»; если владелец принесёт скриншоты/логи — вложить с указанием, кто и когда прогнал.
  Не выдавать «работает в Firefox/Windows» без прогона.
- [ ] **Step 6: Commit** — `test: add M6 error-page coverage and E2E evidence`.

## Task 7: Руководства и финальный README

**Files:**
- Create: `docs/user-guide.md`
- Modify: `docs/deployment.md` (скелет — T1, разделы — T2/T3/T5, здесь — финальная сборка)
- Create: `docs/screenshots/m6/guide/*.png`
- Modify: `README.md`, `.env.example`, `docs/superpowers/specs/2026-11-21-assignment-traceability.md` (только
  ссылки «где проверять», если они изменились)
- Create: `tests/unit/docs-links.test.js`

**Interfaces:**
- `docs/deployment.md` — единственный источник эксплуатационных команд: требования (Node 24, PostgreSQL 18,
  Compose v2 и путь установки плагина); Docker-путь (`cp .env.example .env` опционально, `docker compose up
  --build`, автосид, вход, `down`/`down -v`, health и 503-контракт); native Linux; **Windows 10 пошагово** (Node 24,
  PostgreSQL 18, PATH, роль/базы, `.env`, `npm ci`, `db:setup`, `migrate`, `seed`, `build`, `start`, проверка
  `/health`); Docker Desktop как альтернатива; таблица переменных окружения (включая `DEMO_INSECURE_COOKIES`,
  `AUTO_SEED_DEMO`, `BACKUP_KEY_FILE`, `PG_DUMP`/`PG_RESTORE`, `RESTORE_TMP_DIR`); TLS/reverse-proxy; backup/restore
  runbook; обновление; troubleshooting-таблица. Windows-раздел помечен как проверенный владельцем или
  «не проверено здесь».
- `docs/user-guide.md` — русский, для трёх ролей: вход и демо-пароль, навигация, дашборд, каналы и паспорт,
  кампании, когорты, атрибуция, алерты, сценарии, цели, импорт/экспорт, аудит, пользователи, профиль; для каждого
  экрана — 1–2 скриншота и «что здесь можно понять»; блок «Ошибки и что делать» (403, 404, 500, лимит импорта,
  неверный CSV); дисклеймер о вымышленных данных и BYN.
- README финальный: что работает (M1–M6), быстрый старт native и Docker, демо-аккаунты, маршруты, скрипты,
  структура, документация, Windows, troubleshooting, данные/лицензия. Обязательно: `engines`/требование Node 24,
  пример ответа `/health` (актуальная версия и поля), и явный список всего, что очищает `db/seed/seed.js` (сессии,
  медиа, аудит, сценарии, алерты, `import_batches` и остальные таблицы — берётся из кода, не по памяти), чтобы
  читатель не запускал seed на живых данных. README не дублирует все команды deployment — даёт короткий путь и
  ссылку.
- `docs-links.test.js`: все относительные markdown-ссылки в `README.md` и `docs/**` существуют; перед извлечением
  ссылок вырезаются fenced-блоки (```) и inline-код (`` ` ``), иначе примеры команд дают ложные «битые ссылки»;
  нет `/home/`, `C:\Users\` и других домашних путей; нет битых ссылок на скриншоты;
  `docs/deployment.md` содержит обязательные разделы (`Windows 10`, `Docker`, `Резервное`, `TLS`).
- `.env.example`: каждая переменная из `parseEnv` присутствует с комментарием; новые M6-переменные — с
  объяснением, где взять значение; никаких реальных секретов.

**Steps:**
- [ ] **Step 1: Failing docs test.** `docs-links.test.js` падает на отсутствующем `user-guide.md` и на
  несуществующих ссылках; отдельно проверить, что fenced-блоки не участвуют в проверке.
- [ ] **Step 2: Finalize deployment guide.** Прогнать каждую команду на чистой БД и в контейнере; вставлять только
  фактический вывод. Windows-раздел писать так, чтобы его можно было выполнить без Linux-команд; отметить, что
  прогон делает владелец.
- [ ] **Step 3: Write user guide and screenshots.** Скриншоты — после T4/T5/T6, на актуальном HEAD, 1440×1000
  (и 390 для мобильного раздела); подписи по-русски, без вымышленных цифр вне демо. Пары «шаг → снимок» должны
  совпадать с фактическим UI.
- [ ] **Step 4: Final README.** Убрать «M6 отложен», обновить список экранов, маршрутов, скриптов, документации;
  добавить Node 24, пример `/health`, список очищаемых seed таблиц; проверить, что все ссылки ведут на существующие
  файлы; вставить один свежий скриншот лендинга.
- [ ] **Step 5: Re-run docs test + link check.** `npx vitest run tests/unit/docs-links.test.js`; пройти README
  глазами с нуля, как чужой человек.
- [ ] **Step 6: Commit** — `docs: add deployment and user guides, finalize README`.

## Task 8: Готовность к публикации и финальные ворота

**Files:**
- Create: `LICENSE` (плейсхолдер), `docs/publication.md`, `scripts/fresh-clone-check.js`
- Create: `tests/unit/repo-hygiene.test.js`, `tests/unit/publication.test.js`
- Modify: `IMPROVEMENTS.md`, `.env.example`, `README.md`, `package.json` (`version` 1.0.0, только `check:fresh`)

**Interfaces:**
- `LICENSE`: текст «Copyright (c) 2026. No license is granted yet; the license text is pending the owner's
  decision. All rights reserved until then.» Без названия конкретной лицензии. Тег блокируется, пока владелец не
  заменит файл; `publication.test.js` проверяет, что `LICENSE` существует, содержит `Copyright`, а
  `docs/publication.md` фиксирует статус лицензии (плейсхолдер или выбранная владельцем). Замена плейсхолдера на
  MIT/проприетарный текст не ломает тест.
- `docs/publication.md`: описание репозитория (одно предложение ≤ 160 символов и расширенное ≤ 350), темы GitHub
  (`nodejs`, `express`, `postgresql`, `ejs`, `react`, `recharts`, `marketing-analytics`, `cac`, `ltv`, `romi`,
  `course-project`), социальный preview (OG-PNG), предлаговый чек-лист, **предложение тега `v1.0.0`** с аннотацией
  «M6 delivery: Docker, encrypted backups, deployment and user guides», список известных ограничений и правило
  «тег/пуш — только владелец». В `package.json` `version` поднимается до `1.0.0`, README-пример `/health` показывает
  актуальные версию/поля.
- `scripts/fresh-clone-check.js`: `npm run check:fresh`; по умолчанию клонирует **зафиксированное состояние** (чистый
  worktree/copy mode от указанного SHA, а не грязный рабочий каталог) в `mkdtemp`, `npm ci --prefer-offline`,
  генерирует `.env` из `.env.example` со случайным `SESSION_SECRET` и отдельной БД `metrika_clone_check`, выполняет
  `db:setup`/`migrate`/`seed`/`build`/`start` на свободном порту, проверяет `/`, `/login`, `/health`, вход admin,
  затем останавливает процесс, удаляет БД и каталог. Требует `ADMIN_DATABASE_URL` или дефолт из `db/setup.js`
  (роль с `CREATEDB`); при недоступности — понятная ошибка, не молчаливый skip. Запускается **после** коммита T8
  (SHA пишется в журнал); при необходимости обновить журнал результатом — отдельный `docs:` коммит, а не правка
  задним числом.
- `repo-hygiene.test.js`: `git ls-files` не содержит `.env`, `public/assets`, `node_modules`, `*.log`, `backups/*.enc`,
  файлов > 5 MB (кроме допустимых шрифтов/PNG) и домашних путей. Проверка имени автора не делается: имя владельца
  легитимно встречается в git-метаданных/лицензии, а жёсткий чек ложно срабатывает на самом тесте. Паттерны
  собираются в рантайме (конкатенация частей), сам тестовый файл исключается из сканирования — иначе литералы
  находят себя же. `.env.example` содержит все ключи `parseEnv`; `package-lock.json` в индексе;
  `docs/screenshots/m6` не пуст; в `src/` нет `console.log` (CLI-скрипты могут писать в stdout намеренно).
- `IMPROVEMENTS.md`: закрывающий triage. Каждый открытый пункт получает один из статусов: `fixed in M6` (со ссылкой
  на файл/тест), `deferred` (причина и триггер пересмотра), `rejected` (причина). Ничего не удаляется; история
  M1–M5 сохраняется. M5 deferrals (per-channel caps, edit/delete сценариев, first_detected_at, экспорт сценариев)
  остаются `deferred` с явной пометкой «M6+». Сюда же — OG из БД (1×1 seeded asset) и slow-query/user-id, если
  реализация отложена.
- `package.json`: `"version": "1.0.0"`, `"check:fresh": "node scripts/fresh-clone-check.js"`. Скрипты `backup` и
  `restore` уже добавлены в Task 2 и здесь не переписываются. Новых зависимостей нет.

**Steps:**
- [ ] **Step 1: Failing hygiene/publication tests.** Проверить, что они падают на отсутствующем `LICENSE`, пустом
  `docs/publication.md` и несуществующем скрипте; убедиться, что hygiene-тест не ловит сам себя.
- [ ] **Step 2: Run and see fail.** `npx vitest run tests/unit/repo-hygiene.test.js tests/unit/publication.test.js`.
- [ ] **Step 3: Publication pack.** Описание, темы, скриншот preview, `LICENSE`-плейсхолдер, известные ограничения,
  предложение тега `v1.0.0`, версия `1.0.0` в `package.json`, README-пример `/health`. Никаких `git remote`,
  `git push`, `git tag` — только текст и локальный коммит.
- [ ] **Step 4: IMPROVEMENTS triage.** Пройти файл сверху вниз; каждому пункту — статус и причина. Сверить, что
  исправленные пункты действительно закрыты тестом/кодом, а не «выглядит исправленным».
- [ ] **Step 5: Final gate (pre-commit).** `npm test` (весь набор), `npm run build`, Docker smoke через реальный
  `docker compose` (или зафиксированный блокер), чек-лист трассировки §7. Записать итог в журнал M6.
- [ ] **Step 6: Commit** — `chore: prepare repository for publication`.
- [ ] **Step 7: Fresh-clone check after commit.** `npm run check:fresh` на записанном SHA (worktree/copy mode);
  отдельно — Docker-путь с чистого клона без `.env`, если Compose доступен. Записать SHA, длительность, результат;
  поломки исправить отдельным фикс-коммитом или вынести в `IMPROVEMENTS.md` с блокировкой тега. Если журнал нужно
  дополнить фактическим результатом — `docs:` коммит.
- [ ] **Step 8: Tag gate.** Тег `v1.0.0` предлагается, но не ставится: нужны подпись владельца по Firefox/Windows/
  Docker Desktop, реальный `docker compose` вывод и решение по лицензии. Невыполненное — явный блокер в
  `docs/publication.md`.

## Review Focus: пять режимов отказа и где они проверяются

1. **Compose volume/permissions.** Симптомы: плагин `docker compose` не установлен и Docker-путь объявлен «готовым» по
   тексту файлов; PG18 не стартует из-за старого `/var/lib/postgresql/data`; `app` не может писать `session-secret`
   в `/app/data`; bind-mount `./backups` принадлежит хосту и недоступен uid 1000. Проверка: предусловие Compose и
   реальный вывод `docker compose config/up`; `container-contract.test.js` (путь `/var/lib/postgresql`, `USER node`,
   `read_only`, tmpfs 256m/1777, named volumes, healthcheck `r.ok`), smoke в Task 1 с `id -u`, записью в `/app/data`,
   рестартом, `down`/`up` и 503 → `unhealthy`; бэкап — только named volume `/backup` + `docker compose cp`, без
   bind-mount. Ошибка entrypoint'а валит healthcheck, а не оставляет «полуживой» контейнер.
2. **Бэкап не читается на Windows.** Симптомы: файл скопирован через PowerShell `>`/`Out-File` и повреждён; ключ
   передан в неверной кодировке или лежит в env Compose; `pg_dump`/`pg_restore` новее/старше сервера; путь с
   пробелами/кириллицей ломает shell. Проверка: `backup-format.test.js` (потоковый round-trip, header как AAD, тег в
   трейлере, подмена iv/header/ciphertext/тега, обрезанный header, неверный ключ), `backup-restore.test.js`
   (`spawn` без shell, restore + row-count/key checksum), ручной прогон владельца на Windows по runbook с
   `Copy-Item` и проверкой «Последний результат» = `0x0`. Скрипт печатает мажоры `pg_dump`/сервера: клиент < сервера
   — отказ, клиент > сервера — предупреждение.
3. **Обход production-guard.** Симптомы: `NODE_ENV=production` задан в compose, а `.env` подсовывает
   `COOKIE_SECURE=false`; плейсхолдер секрета принимается; `DEMO_INSECURE_COOKIES` случайно уезжает на публичный
   хост; булево `0`/`1` трактуется как истина. Проверка: `config-env.test.js` в Task 1 — полная матрица, включая
   `localhost.evil.com`, `127.0.0.1.evil.com`, `[::1].evil.com`, `true/false` и отказ `0/1`;
   `container-contract.test.js` (`NODE_ENV=production` в финальной стадии/compose), Docker smoke с проверкой
   `Set-Cookie` без `Secure` только на loopback. Task 3 этот код не редактирует. Публичный стенд без HTTPS описан в
   `deployment.md` как ошибка, а не «настройка».
4. **Кросс-браузерная регрессия.** Симптомы: Recharts/фокус/`<details>`/слайдер ведут себя иначе в Firefox;
   горизонтальный скролл появляется только на 390; шрифт подменяется. Проверка: Task 6 — Chromium полная матрица;
   Firefox/Windows — прогон владельца или честная пометка «не проверено здесь — недоступно»; Task 4 — 390×844,
   клавиатура и контраст focus-ring на canvas; `firefox-*.png` только с указанием автора прогона. CSS без
   вендор-специфичных хаков, `focus-visible` и `prefers-reduced-motion` — стандартные.
5. **Сломанный чистый клон.** Симптомы: забыт `npm run build`, нет манифеста; `.env.example` не совпадает с
   `parseEnv`; документация ссылается на несуществующий файл; в индексе `.env`/`public/assets`/большой артефакт;
   Docker-путь требует правки compose. Проверка: `scripts/fresh-clone-check.js` в worktree/copy mode от коммита
   (а не от грязного каталога) → `npm ci` → env → DB → migrate/seed/build/start → login; Docker-путь с чистого
   клона без `.env`; `repo-hygiene.test.js` (паттерны в рантайме, без проверки имени автора); `docs-links.test.js`
   (fenced/inline-код вырезан); `publication.test.js`. Оба пути фиксируются в журнале с SHA и временем.

## Порядок выполнения и ворота

1. T1 (Docker) → T2 (бэкапы) → T3 (заголовки/доступ) → T4 (доступность) → T5 (SEO/perf) → T6 (E2E) →
   T7 (документация) → T8 (публикация). `docs/deployment.md` появляется скелетом в T1, наполняется в T2 (бэкапы),
   T3 (TLS), T5 (кэш/perf) и финализируется в T7 после E2E: руководство не может описывать экраны, которых ещё не
   прогоняли. T2 зависит от T1 каталогом `/backup` и правами `app_data`.
2. После каждой задачи: затронутые тесты зелёные, `npm test` не сломан, браузерная проверка выполнена, коммит
   один. Перед T8 — полный `npm test`. Docker-задача считается закрытой только по реальному `docker compose`
   выводу; `docker run` fallback — блокер, а не зелёный результат.
3. Критичная находка (потеря данных, обход auth, неработающий restore) останавливает задачу и выносится владельцу;
   некритичные — в `IMPROVEMENTS.md`, не в код.
4. Тег `v1.0.0` и пуш — только после приёмки владельцем. Условные блокеры тега: решение по лицензии, подпись
   владельца по Firefox/Windows/Docker Desktop, отсутствие реального Compose-доказательства. Пока хоть один
   открыт, `docs/publication.md` фиксирует его как блокер, а тег не ставится.

## Чек-лист приёмки M6 (сверка с трассировкой §7)

- [ ] `docker compose up --build` с чистого клона поднимает app + PostgreSQL 18 без правки файлов; `/health` — 200;
  реальный вывод Compose записан (плагин установлен), 503 → `unhealthy` доказан.
- [ ] `npm run migrate && npm run seed && npm run build && npm start` с нуля на native-пути; фактическая версия
  Node — 24, `engines.node >= 24`, версия проекта `1.0.0`.
- [ ] Бэкап создаётся, шифруется AES-256-GCM (header AAD + тег в трейлере), восстанавливается в scratch-БД,
  row-count/key checksum зелёный; ключ не в env Compose; runbook для Windows подписан владельцем или помечен.
- [ ] Production-guard: плейсхолдер секрета, insecure-кука вне loopback, spoof-хосты и `0/1` не проходят; публичный
  путь — HTTPS.
- [ ] Каждый мутирующий маршрут: guard + CSRF + аудит; route-audit и RBAC-матрица зелёные; `Permissions-Policy`
  отдаётся вручную (Helmet 8.3 без такой опции).
- [ ] Клавиатура, 390×844, контраст (включая focus-ring canvas), таблицы-дубли графиков,
  `prefers-reduced-motion`; известное исключение записано.
- [ ] Landing: title/description/OG PNG с `width/height/alt`/JSON-LD/sitemap/robots; `/app` и `/api` — noindex.
- [ ] EXPLAIN четырёх тяжёлых путей записан через SELECT-only прокси; N+1/query budgets и bundle budgets не выросли
  без решения.
- [ ] README (Node 24, `/health`, список таблиц, очищаемых seed), `docs/deployment.md`, `docs/user-guide.md` со
  скриншотами, демо-аккаунтами и дисклеймером; без домашних путей.
- [ ] E2E Chromium тремя ролями + ошибки (403/404/500/импорт/медиа); Firefox/Windows/Docker Desktop — подпись
  владельца или «не проверено здесь — причина».
- [ ] `.env.example` полон и без секретов; `LICENSE`-плейсхолдер; `IMPROVEMENTS.md` с triage; предложение тега
  `v1.0.0` с перечисленными блокерами.
- [ ] Ни одного нового npm-пакета, ни одного нового CSS-файла, ни одного `.ts`/`.tsx`.

## Вне M6

Пояснительная записка, IDEF0/UML-диаграммы, слайды и демо-сценарий защиты — владелец. Новые продуктовые фичи
(per-channel caps, редактирование/удаление сценариев, campaign-scope атрибуции, экспорт алертов/сценариев,
`first_detected_at`, второй бакет лимитера на пользователя, а не сессию) — M6+ и фиксируются в `IMPROVEMENTS.md`,
если всплывут при прогоне. Пуш, создание удалённого репозитория и тег — только по команде владельца.
