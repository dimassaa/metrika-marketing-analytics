# M6 — журнал доказательств

Дата прогона: 24.11.2026. База: коммит `c6bfba7` (M5 закрыт, план M6 закоммичен); артефакты Task 1 в рабочем
дереве на момент прогона — следующий коммит. Все команды выполнены на Linux (CachyOS), не в Windows и не в Docker
Desktop.

## Окружение

| Компонент | Версия / значение |
|---|---|
| Node.js на хосте | `v26.13.0` |
| npm | `12.2.1` |
| Docker Engine | `29.9.2` (client и server) |
| Docker Compose | `v5.8.0` (user-level плагин) |
| Node.js в образе | `v24.22.3` (`node:24-bookworm-slim`) |
| PostgreSQL | `18.7` (`postgres:18-alpine`; `psql`/`pg_dump` — `18.7-1.pgdg12+5`) |
| Образ приложения | `metrika-app:latest`, ID `sha256:a6421a4fc082…` (финальная сборка, healthcheck timeout 15s) |
| Порт | `127.0.0.1:3000` только loopback |

## Docker

### 1. Предусловие Compose

Исходное состояние — плагина нет:

```text
$ docker compose version
docker: unknown command: docker compose

$ which docker-compose
which: no docker-compose in (...)
```

Плагин установлен user-level, без `sudo`, pinned-версией v5.8.0:

```bash
mkdir -p ~/.docker/cli-plugins
curl -fsSL -o ~/.docker/cli-plugins/docker-compose \
  https://github.com/docker/compose/releases/download/v5.8.0/docker-compose-linux-x86_64
chmod +x ~/.docker/cli-plugins/docker-compose
docker compose version
```

```text
Docker Compose version v5.8.0
```

### 2. `docker compose config` без `.env`

`.env` временно убран, чтобы проверить дефолты:

```text
$ mv .env /tmp/metrika-env-backup
$ docker compose config
exit=0
$ mv /tmp/metrika-env-backup .env
```

Разрешённые значения без `.env`: `DATABASE_URL=postgres://postgres:postgres@db:5432/metrika`,
`POSTGRES_USER=postgres`, `POSTGRES_DB=metrika`. Проверенные свойства:

```text
name=metrika
db.image=postgres:18-alpine
db.health=["CMD-SHELL","pg_isready -U \"$$POSTGRES_USER\" -d \"$$POSTGRES_DB\""]
app.ports=[{"mode":"ingress","host_ip":"127.0.0.1","target":3000,"published":"3000","protocol":"tcp"}]
app.health=["CMD","node","-e","fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
app.read_only=true
app.tmpfs=["/tmp:mode=1777,size=256m"]
app.cap_drop=["ALL"]
app.security_opt=["no-new-privileges:true"]
volumes=app_data,backup_data,db_data
```

У сервиса `db` нет секции `ports`; PostgreSQL доступен только по внутренней сети Compose.

### 3. Сборка и запуск

```bash
docker compose build
docker compose up -d
```

```text
Successfully built 7cefabb6a1d5
Successfully tagged metrika-app:latest

 Network metrika_default Creating
 Volume metrika_backup_data Creating
 Volume metrika_app_data Creating
 Volume metrika_db_data Creating
 Container metrika-db-1 Creating
 Container metrika-db-1 Starting
 Container metrika-db-1 Healthy
 Container metrika-app-1 Starting
 Container metrika-app-1 Started
```

```text
$ docker compose ps
NAME            IMAGE                SERVICE   STATUS                            PORTS
metrika-app-1   metrika-app          app       Up 19 seconds (healthy)           127.0.0.1:3000->3000/tcp
metrika-db-1    postgres:18-alpine   db        Up 24 seconds (healthy)           5432/tcp
```

### 4. Миграции, автосид и `/health`

```text
app-1 | {"msg":"applied 001_init.sql"}
app-1 | {"msg":"applied 002_m2_data.sql"}
app-1 | {"msg":"applied 003_media_mime_check.sql"}
app-1 | {"msg":"applied 004_m3_metrics_indexes.sql"}
app-1 | {"msg":"applied 005_drop_redundant_customer_index.sql"}
app-1 | {"msg":"applied 006_decisions.sql"}
app-1 | {"msg":"demo stand was empty: seeded users, channels and daily stats"}
app-1 | {"port":3000,"nodeEnv":"production","msg":"server listening"}
```

```text
$ curl -fsS http://127.0.0.1:3000/health
{"status":"ok","db":"up","version":"0.1.0"}
```

Asset-пути из отданного HTML отвечают 200, включая `/img/og-cover.svg` и `/css/app.css`:

```text
/assets/chunks/ChartTooltip-aqaNQ0-l.js -> 200
/assets/chunks/HealthBadge-oo31xU77.js -> 200
/img/og-cover.svg -> 200
/css/app.css -> 200
```

### 5. Вход и счётчики

```text
$ curl -sS -c cookies -b cookies -X POST http://127.0.0.1:3000/login \
    --data-urlencode "_csrf=$TOKEN" \
    --data-urlencode "email=admin@metrika.by" \
    --data-urlencode "password=Metrika2026!"
HTTP/1.1 302 Found
$ curl -sS -b cookies http://127.0.0.1:3000/app/dashboard
<title>Дашборд — Метрика

$ docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
    "select count(*) from users; select count(*) from channels; select count(*) from daily_stats"'
3
8
12723
```

### 6. Non-root, read-only rootfs, права файлов

```text
$ docker compose exec -T app id
uid=1000(node) gid=1000(node) groups=1000(node)

$ docker compose exec -T app touch /app/data/probe
-rw-r--r-- 1 node node 0 … /app/data/probe

$ docker compose exec -T app touch /app/should-fail
touch: cannot touch '/app/should-fail': Read-only file system

$ docker compose exec -T app stat -c '%a %U %n' /app/data/session-secret /app/data/tmp
600 node /app/data/session-secret
700 node /app/data/tmp
```

### 7. Рестарт и повторный `up` сохраняют сессию и данные

```text
$ docker compose restart
$ curl -sS -b cookies http://127.0.0.1:3000/app/dashboard
status=200
<title>Дашборд — Метрика
app-1 | {"msg":"database is up to date, nothing to apply"}
app-1 | {"msg":"demo stand already has data (users=3, channels=8, daily_stats=12723); seeding skipped"}

$ docker compose down && docker compose up -d
$ curl -sS -b cookies http://127.0.0.1:3000/app/dashboard
status=200
$ docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from users"'
3
```

### 8. Health-контракт: БД упала → 503 и `unhealthy`

```text
$ docker compose stop db
$ curl -sS -o /tmp/health-down.json -w '%{http_code}' http://127.0.0.1:3000/health
503
{"status":"error","db":"down","version":"0.1.0"}

$ docker inspect --format '{{.State.Health.Status}}' metrika-app-1
unhealthy

$ docker inspect --format '{{range .State.Health.Log}}{{.ExitCode}} {{end}}' metrika-app-1
1 1 1 1 1
```

Код выхода `1` (а не только таймаут процесса) подтверждает, что healthcheck проверяет `r.ok`: ответ 503 считается
провалом. После `docker compose start db`:

```text
$ docker compose start db
$ docker inspect --format '{{.State.Health.Status}}' metrika-app-1
healthy
$ curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/health
200
```

### 9. `down -v` сбрасывает стенд

```text
$ docker compose down -v
 Volume metrika_app_data Removed
 Volume metrika_backup_data Removed
 Volume metrika_db_data Removed

$ docker compose up -d
 Container metrika-db-1 Healthy
 Container metrika-app-1 Started
app-1 | {"msg":"applied 001_init.sql"} … {"msg":"applied 006_decisions.sql"}
app-1 | {"msg":"demo stand was empty: seeded users, channels and daily stats"}

$ docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
    "select count(*) from users; select count(*) from channels; select count(*) from daily_stats"'
3
8
12723
```

После сброса стенд оставлен запущенным и `healthy`.

### 10. Контракт образа

```text
$ docker image inspect metrika-app:latest --format 'user={{.Config.User}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}}'
user=node entrypoint=["/usr/local/bin/entrypoint.sh"] cmd=["node","src/server.js"]
```

Runtime-стадия получает фронтенд одной строкой `COPY --from=client-build /app/public ./public`; исходный
`public/` и собранные `public/assets` проверены запросами выше. В образ не попадают `tests/`, `docs/`, `.env`,
`.git`, `public/assets` из хоста, `backups` и `.superpowers`.

## Тесты

```bash
npx vitest run tests/integration/container-contract.test.js tests/unit/seed-demo.test.js tests/unit/config-env.test.js
```

```text
✓ tests/integration/container-contract.test.js (33 tests)
✓ tests/unit/config-env.test.js (36 tests)
✓ tests/unit/seed-demo.test.js (6 tests)

Test Files  3 passed (3)
Tests       75 passed (75)
```

Полный прогон:

```text
Test Files  94 passed (94)
Tests       1132 passed (1132)
Duration    87.42s
```

## Task 2 — бэкапы и восстановление

Дата прогона: 24.11.2026. База: коммит `4afe303` (T1) + рабочее дерево Task 2. Linux (CachyOS), локальный
PostgreSQL 18.6 и Compose-стенд; Windows недоступен.

### 1. Тесты

```text
$ npx vitest run tests/unit/backup-format.test.js tests/integration/backup-restore.test.js
✓ tests/unit/backup-format.test.js (47 tests)
✓ tests/integration/backup-restore.test.js (3 tests)
Tests  50 passed (50)
```

Unit: потоковый round-trip (включая проверку, что `.tmp` растёт до конца входного потока), ровно `v/alg/iv` в
заголовке, неверный ключ, подмена ciphertext/IV/версии/тега, обрезанные header/tag, ключи 0/16/31/33/64 байта,
плейсхолдер, retention (только `metrika-*.dump.enc`, минимум один, `--keep`), имена БД и отказ писать в
`DATABASE_URL` без `--force`. Integration: дамп `metrika_test` → шифрование → расшифровка → restore в
`metrika_test_restore_check` → `--verify` зелёный → scratch удалён; отдельный прогон на пустой мигрированной БД;
повреждённая копия → код 1.

### 2. Локальный стенд (`metrika_dev`)

```text
$ node scripts/backup.js   # BACKUP_KEY_FILE=…/backup.key, BACKUP_DIR=…/backups
pg_dump (PostgreSQL) 18.6; сервер PostgreSQL 18.6; БД metrika_dev
Бэкап создан: …/metrika-2026-11-24T08-49-45Z.dump.enc
  размер: 709.6 КиБ (726533 байт дампа), AES-256-GCM
$ file …dump.enc
…: data
$ stat -c '%a %s' …dump.enc
600 726612
$ strings …dump.enc | grep -E 'CREATE TABLE|PostgreSQL|INSERT INTO'
(пусто)
```

```text
$ node scripts/restore.js --file …dump.enc --database metrika_restore_check --create --verify
Таблица        строк   восстановлено   md5 (первые 12)
users              3              3   55b84a9d3171 ok
channels           8              8   b5ca3ba695d8 ok
campaigns         32             32   8d65c605aa11 ok
customers       4000           4000   4389e1a10681 ok
orders          9436           9436   f946520fec47 ok
daily_stats    12691          12691   ab578525f37e ok
audit_log          1              1   c4ca4238a0b9 ok
Проверка row-count + key checksum: совпадает (7 таблиц).
restore_exit=0
restore_tmp_entries=0
```

Повреждённая копия (перевёрнут байт ciphertext):

```text
Восстановление не выполнено: Не удалось расшифровать бэкап: неверный ключ или файл повреждён (не совпал тег GCM).
damaged_restore_exit=1
tamper_db_count=0
```

### 3. Контейнерный путь

Образ пересобран (`metrika-app:latest`, ID `71626cc17d5d`), `docker compose up -d app` → healthy. Ключ создан
внутри контейнера, права проверены:

```text
$ docker compose exec -T app stat -c '%a %s %n' /app/data/backup.key /app/data/tmp
600 65 /app/data/backup.key
700 /app/data/tmp
$ docker compose exec -T app node scripts/backup.js
pg_dump (PostgreSQL) 18.7; сервер PostgreSQL 18.7; БД metrika
Бэкап создан: /backup/metrika-2026-11-24T08-50-51Z.dump.enc
  размер: 695.6 КиБ, AES-256-GCM, ключ из файла /app/data/backup.key
```

```text
$ docker compose exec -T -e ADMIN_DATABASE_URL=postgres://postgres:postgres@db:5432/postgres \
    app node scripts/restore.js --file /backup/<file> --database metrika_restore_check --create --verify
users 3/3, channels 8/8, campaigns 32/32, customers 4000/4000,
orders 9446/9446, daily_stats 12723/12723, audit_log 0/0
Проверка row-count + key checksum: совпадает (7 таблиц).
container_restore_exit=0
container_tmp_entries=0
```

`docker compose cp app:/backup/<file>` + `docker compose cp app:/app/data/backup.key` на хост: файл 712329 байт,
локальный `restore.js --create` восстановил `metrika_copy_check` (users 3, orders 9446) и удалил временный каталог.
Scratch-базы `metrika_restore_check`, `metrika_copy_check`, `metrika_tamper_check` после проверок удалены.

### 4. Review fixes

- Пароль убран из `argv`: `pg_dump`/`pg_restore` получают URL без пароля, сам пароль — через `PGPASSWORD`.
  Wrapper-лог реального прогона:

```text
PGPASSWORD_UNSET
--version
PGPASSWORD_SET
--format=custom --no-owner --no-acl --dbname postgres://metrika@localhost:5432/metrika_dev
no password in argv
```

  Имя роли в примере обезличено; команда и вывод остальные.

  Интеграционный тест дополнительно проверяет, что `review-secret` из `DATABASE_URL` не встречается ни в одном
  залогированном argv и что дочерний процесс видит `PGPASSWORD`.
- Файл ключа с режимом `0644` отвергается на POSIX до подключения; `--allow-loose-key` продолжает с
  предупреждением. Unit-тесты покрывают 0600, 0644, override и ветку `win32` (warning вместо отказа). Оба CLI
  проверены отдельными запусками: код 1, сообщение про `chmod 600`/`--allow-loose-key`, без `ECONNREFUSED`.
- Убрано дублирование `pg_dump pg_dump`, сравнение `--force` декодирует percent-encoded имя БД, а
  `--force + --verify` печатает предупреждение о сравнении живой базы с самой собой.
- Устаревший `metrika-restore-*` старше 24 часов удаляется при старте:

```text
Удалён устаревший временный каталог: …/tmp/metrika-restore-stale
```

### 5. Password-auth regression (`connectionString` + `password`)

`pg` parses `connectionString` after merging explicit options, so `new pg.Client({ connectionString: passwordless,
password })` produced `connectionParameters.password === null`. The fix builds an explicit config (`host`, `port`,
`user`, `database`, `ssl`, optional libpq fields) and sets `password` last; `connectionString` is never passed with
`password`. The unit test asserts `new pg.Client(config).connectionParameters.password` directly, so local `trust`
auth cannot hide the regression.

Final container rebuild `metrika-app:latest` = `5d0695aa94fe`; the Compose stand uses password auth for both
`DATABASE_URL` and `ADMIN_DATABASE_URL`:

```text
$ docker compose exec -T app node scripts/backup.js
pg_dump (PostgreSQL) 18.7 (Debian 18.7-1.pgdg12+5); сервер PostgreSQL 18.7; БД metrika
Бэкап создан: /backup/metrika-2026-11-24T09-25-08Z.dump.enc (695.6 КиБ)

$ docker compose exec -T -e ADMIN_DATABASE_URL=postgres://postgres:postgres@db:5432/postgres \
    app node scripts/restore.js --file /backup/<file> --database metrika_regression_check --create --verify
Создана scratch-база "metrika_regression_check".
users 3/3, channels 8/8, campaigns 32/32, customers 4000/4000,
orders 9446/9446, daily_stats 12723/12723, audit_log 0/0
Проверка row-count + key checksum: совпадает (7 таблиц).
final_container_password_restore_exit=0
```

Scratch-база удалена, `/app/data/tmp` пуст.

### 6. Мелкие правки по ревью T1

- `docker/entrypoint.sh` получил executable-бит (`100755`); содержимое не менялось.
- В `docs/deployment.md` добавлена сверка SHA-256 для скачиваемого Compose-плагина.
- Задокументировано расхождение дефолтов `RUN_MIGRATIONS` (`env.js` — `false`, entrypoint — `true`): это разные
  точки входа, а не разная трактовка значения.
- В таблицу переменных добавлены `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` и предупреждение о символах
  `@ : / ?` в неpercent-encoded `DATABASE_URL`.

## Task 4 — доступность и мобильная ширина

Дата прогона: 24.11.2026. База: `54ceeaa` + рабочее дерево Task 4. Linux (CachyOS), Chromium через `agent-browser`.
Метод: WCAG 2.1 relative luminance по фактическим токенам `public/css/app.css` (`tests/unit/contrast.test.js`), затем
точечная сверка через `getComputedStyle` в браузере на живом стенде.

### 1. Контраст токенов

Порог текста 4,5:1, нетекстовых элементов 3:1.

| Пара | Отношение | Порог | Итог |
|---|---:|---:|---|
| `#0c0a09` на `#ffffff` | 19,76 | 4,5 | ok |
| `#0c0a09` на `#fafaf9` | 18,92 | 4,5 | ok |
| `#1c1917` на `#ffffff` | 17,49 | 4,5 | ok |
| `#1c1917` на `#fafaf9` | 16,74 | 4,5 | ok |
| `#78716c` на `#ffffff` | 4,80 | 4,5 | ok |
| `#78716c` на `#fafaf9` | 4,59 | 4,5 | ok |
| `#2f7d5f` (healthy) на `#ffffff` | 4,98 | 4,5 | ok |
| `#a16207` (watch) на `#ffffff` | 4,92 | 4,5 | ok |
| `#b91c1c` (risk) на `#ffffff` | 6,47 | 4,5 | ok |

`#a8a29e` (ash gray) на белом — 2,52:1, поэтому им окрашены только disabled-поля; смысловой текст и иконки
используют `#78716c`. Статусные точки — `currentColor` рядом с текстом статуса, не единственный носитель смысла.

### 2. Кольцо фокуса

| Пара | Отношение | Порог |
|---|---:|---:|
| `#3398e1` на `#ffffff` | 3,13 | 3 |
| `#3398e1` на `#fafaf9` | **2,99** | 3 — не проходит |
| `#2f8bd0` (`--color-cyan-focus`) на `#ffffff` | 3,67 | 3 |
| `#2f8bd0` на `#fafaf9` | 3,51 | 3 |

Поэтому кольцо фокуса — `#2f8bd0`, а не брендовый `#3398e1`: на canvas брендовый cyan даёт 2,99:1. Линии графиков
остаются `#3398e1` (3,13:1 на белой карточке). Пару «кольцо к линии графика» отдельно не измеряем: plot не
focusable, кольцо рисуется вокруг белой карточки или скроллера и с линией не пересекается — сравнение не имеет
смысла, пока график не станет фокусируемым.

### 3. Записанное исключение владельца

Highlight-пара `#3398e1` на `#c1e1f7` — **2,29:1**, ниже AA даже для крупного текста. Решение владельца от
24.11.2026 (`docs/superpowers/plans/2026-11-25-metrika-m6-delivery.md`, §13): сохранить брендовую пару только в
заголовке лендинга; для тела текста и интерфейса она не используется. Исключение зафиксировано комментарием у
`.highlight` и тестом `contrast.test.js`.

### 4. Фактическая проверка в браузере

Снимки: `a11y-390-dashboard.png`, `a11y-focus-menu-390.png`, `a11y-focus-nav-1280.png`,
`a11y-focus-skip-390.png`, `a11y-focus-table-390.png`, `a11y-channels-error-1280.png`.

Живой `getComputedStyle` (не токены, а фактические пары на страницах): muted `rgb(120,113,108)` на
`rgb(250,250,249)` — 4,59; заголовок таблицы на белом — 4,80; здоровый статус на белом — 4,98; активный пункт
меню на белом — 19,76; подпись поля на canvas — 18,92; highlight — 2,29 (исключение выше). Кольцо фокуса в
браузере — `rgb(47,139,208)`, ширина 2 px, offset 2 px. `<summary>` дублирующей таблицы измерен в Chromium как
25,67 px (было 23,67 при 2 px padding). Ширина 390 px: `scrollWidth === clientWidth` на всех 12 экранах, таблицы
прокручиваются внутри `.table-wrap`, topbar начинается после меню (нет перекрытия).

## Не проверено здесь — закрывает владелец

- **Windows 10** и **Docker Desktop**: у агента нет Windows-машины; Linux-прогон их не заменяет. Для Task 2 это
  значит, что Windows-ветка `docs/deployment.md` §5 (ACL ключа, Планировщик, `0x0`) написана, но не выполнена.
- **Firefox**: доступен только Chromium через `agent-browser`; кросс-браузерная матрица — прогон владельца.
- **TLS**: публичный HTTPS-стенд за reverse proxy в этой задаче не поднимался.

## Verdict

Compose установлен и проверен реальным выводом `docker compose config/up`; Docker-путь Task 1 **закрыт**.
Task 2 **закрыт на Linux и в контейнере** (row-count + key checksum, включая password-auth Compose-стенд); Windows-прогон
остаётся за владельцем. Ограничения выше относятся к T6/T8 и не выдаются за выполненные.

## Task 6 — E2E-матрица, ошибки и кросс-ролевая проверка

Дата прогона: 24.11.2026. База: коммит `2e78bed` (T1–T5 закрыты); во время прогона владелец добавил `3906f21`
(убрана карточка демо-аккаунтов на входе), поэтому финальный снимок входа снят уже на нём. Рабочее дерево Task 6 —
финальный коммит задачи. Linux (CachyOS), нативный путь без Docker; браузер — Chromium через `agent-browser`.

### 1. Окружение и стенд

| Компонент | Значение |
|---|---|
| Node.js на хосте | `v26.13.0` (Docker-образ T1 — `v24.22.3`; `engines.node >= 24`) |
| npm | `12.2.1` |
| PostgreSQL | сервер `18.6`, `psql` `18.6` |
| Chromium | `158.0.0.0` headless (`agent-browser 0.41.1`) |
| Порт | `127.0.0.1:3100` (Docker-стенд T1 оставался на 3000 и в прогоне не участвовал) |
| БД стенда | `metrika_e2e`, создана с нуля; Docker не использовался |

Команды (вывод сокращён):

```text
$ npm run build
✓ built in 1.42s
public/assets/chunks/ChartTooltip-aqaNQ0-l.js  642.06 kB │ gzip: 193.70 kB
(!) Some chunks are larger than 500 kB after minification

$ DATABASE_URL=postgres://…/metrika_e2e ADMIN_DATABASE_URL=postgres://…/postgres npm run db:setup
metrika_e2e: created
metrika_test: already exists

$ DATABASE_URL=…/metrika_e2e npm run migrate
applied 001_init.sql … 006_decisions.sql      (6 migrations)

$ DATABASE_URL=…/metrika_e2e npm run seed
seeded anchor 2026-11-23, window 2025-10-01..2026-11-23:
8 channels, 32 campaigns, 4000 customers, 9446 orders, 14042 touchpoints,
12723 daily stat rows, 4 goals; spend 151 819,30 BYN, revenue 1 133 981,63 BYN

$ DATABASE_URL=…/metrika_e2e PORT=3100 APP_URL=http://localhost:3100 npm start
$ curl -fsS http://127.0.0.1:3100/health
200 {"status":"ok","db":"up","version":"0.1.0"}
```

Пользователей на стенде — 3 (`admin@metrika.by`, `analyst@metrika.by`, `viewer@metrika.by`).
Data anchor — `2026-11-23` («Данные по 23.11.2026» на всех экранах).

### 2. Найденные дефекты и фиксы

1. **Импорт не проверял MIME/расширение.** Спека §10 требует «проверка MIME/расширения», бриф Task 6 —
   отдельный кейс «неверный MIME». Фактически PNG с расширением `.png` уходил в CSV-парсер и получал
   `400 «В файле нет обязательных колонок: …»` — сообщение про колонки вместо типа файла. Добавлен
   `assertCsvUploadFile` в `src/validators/import.schema.js`: расширение `.csv` и тип из
   `text/csv`, `application/csv`, `text/plain`, `application/vnd.ms-excel` (последние два — то, что присылают
   Windows/офисные клиенты). Регрессионный тест — `tests/integration/import.test.js`, «rejects a non-CSV MIME
   type or a non-CSV extension before parsing» (PNG, подменённый `image/png` у `.csv`, `.txt` с `text/csv`).
   В браузере после фикса: `«Файл не загружен — Допустим только файл CSV с расширением .csv»`; настоящий
   `.csv` по-прежнему проходит (Chrome отправляет `text/csv`).
2. **Сид клал в `media_assets` заглушку 1×1 вместо реальной OG-обложки.** Админ-страница показывала
   растянутый пустой пиксель, `/media/slug/og-cover` отдавал 70 байт, хотя с T5 в репозитории лежит
   `public/img/og-cover.png` 1200×630 (35 656 байт). Сид теперь читает этот committed PNG; байты и checksum
   совпадают со статическим файлом. Регрессионный тест — `tests/integration/seed.test.js`, «seeds the committed
   1200×630 raster as the OG cover» (байтовое равенство + IHDR 1200×630).
   После повторного сида: `Content-Length: 35656`, `ETag "16ad8e47…"`, превью на `/app/admin/users` показывает
   настоящую обложку.

Оба фикса не меняют контрактов API, кроме нового 400 на не-CSV файл.

### 3. Тесты

Целевые прогоны во время работы:

```text
$ npx vitest run tests/integration/error-pages.test.js
tests/integration/error-pages.test.js (7 tests) ✓

$ npx vitest run tests/integration/import.test.js
tests/integration/import.test.js (25 tests) ✓

$ npx vitest run tests/integration/seed.test.js tests/integration/media.test.js tests/unit/seed-demo.test.js
Test Files 3 passed (3), Tests 35 passed (35)

$ npx vitest run tests/integration/page-queries.test.js
Test Files 1 passed (1), Tests 10 passed (10)
```

Полный прогон на тихом дереве (никаких параллельных наборов), после всех правок:

```text
$ npm test
Test Files  105 passed (105)
Tests       1374 passed (1374)
Duration    103.25s      (полный прогон Task 6; follow-up ревью добавил два теста — см. §7)
```

`error-pages.test.js` собирает мини-приложение из `notFoundPage`, `requirePermission`, `notFound` и
`errorHandler` и фиксирует контракт: HTML 404/403/500 — стилизованная страница с русским текстом, `noindex`,
без stack trace; API 404/403/500 — `{error:{code,message}}`; 500 не пишет в лог тело запроса и куки.
Стилизованная 500-страница уже существовала — тест закрепляет контракт, кода для неё не потребовалось.

### 4. Матрица ролей (фактический результат)

Каждый шаг шёл через реальный браузер; после каждого экрана `agent-browser console` и `agent-browser errors`
возвращали пустой список. Счётчики и записи проверялись в PostgreSQL.

**admin**

| Поток | Результат |
|---|---|
| Вход | 302 → `/app/dashboard`; шапка «Администратор», в меню появились «Аудит» и «Пользователи» |
| Дашборд, каналы, паспорт канала (`/app/channels/1`), кампании, когорты, атрибуция, сценарии, алерты, цели, импорт, профиль | 200, `h1` совпадает с экраном, горизонтального скролла нет, консоль пуста |
| Пользователи | создан `e2e.viewer@metrika.by`; роль «Наблюдатель» → «Аналитик»; блокировка → «Заблокирован»; сброс пароля |
| Каналы | создан `admin_check` → «Admin проверка» (`/app/channels/9`), затем заархивирован → статус «В архиве» |
| Алерты | «Пересчитать» → «Последнее срабатывание: 24.11.2026 14:31» |
| Сценарии | сохранён «Admin сценарий» → `/app/scenarios/1` |
| Импорт | dry-run файла `daily_stats`: 2 строки, принято 2, дубликаты 0, ошибки 0 |
| Аудит | журнал открылся; после пересида в нём 7 записей: `auth.login`/`auth.logout`, `export.csv`, `channel.create`, `channel.archive`, `scenario.create` |
| Экспорт | `download channels.csv` — BOM, `code;name;kind;…` (кампании скачаны под analyst: 3 243 байта) |

Пополнение `audit_log` до пересида (хвост журнала, id 5–19; всего 19 записей за первый проход):

```text
 id | action                | entity   | entity_id
  5 | campaign.create       | campaign | 33
  6 | campaign.update       | campaign | 33
  7 | campaign.delete       | campaign | 33
  8 | goal.create           | goal     | 5
  9 | goal.delete           | goal     | 5
 10 | alert.dismiss         | alert    | 2
 11 | scenario.create       | scenario | 1
 12 | import.run            | import   | 1
 13 | export.csv            | campaigns|
 14 | auth.logout           | user     | 2
 15 | auth.login            | user     | 1
 16 | user.create           | user     | 4
 17 | user.role_change      | user     | 4
 18 | user.deactivate       | user     | 4
 19 | user.password_reset   | user     | 4
```

**analyst**

| Поток | Результат |
|---|---|
| Вход, дашборд, каналы, кампании, цели, импорт, экспорт, алерты, сценарии | все экраны 200 |
| Каналы: создать / изменить / архив | создан `e2e_check`, переименован в «E2E проверка 2», цель CAC 1000, заархивирован → статус «В архиве», канал пропал из формы кампаний, но остался в истории |
| Кампании: создать / изменить / удалить | `e2e_campaign` → «E2E кампания 2», статус «На паузе», затем удалена; строка исчезла |
| Цели | создана CAC 45 BYN на Email на 01.11–30.11.2026, затем удалена |
| Алерты | «Пересчитать» → «Последнее срабатывание 13:53», активных 2; скрыт один алерт с причиной «E2E: шум в канале» → активно 1, скрыто 1 |
| Сценарии | слайдер получил 3 нажатия `ArrowRight` (2 684,70 → 2 684,73 BYN), «Рассчитать», сохранён «E2E сценарий аналитика» → `/app/scenarios/1`, детальный экран 200 |
| Импорт | dry-run 2 строки / принято 2 / дубликаты 0 / ошибки 0; commit — «Импорт сохранён» |
| Экспорт | `download campaigns.csv` 3 243 байта |
| `/app/admin/users`, `/app/audit` | стилизованная 403 (`h1 «Недостаточно прав»`, `meta robots noindex, nofollow`) |
| CSRF без токена | `POST /api/v1/import` и `POST /api/v1/scenarios` → `403` JSON `{code:"FORBIDDEN",message:"CSRF token mismatch"}`; `POST /app/channels` → `403 text/plain "CSRF token mismatch"` |

**viewer**

| Поток | Результат |
|---|---|
| Вход, дашборд, каналы, кампании, когорты, атрибуция, сценарии, сохранённый сценарий `/app/scenarios/1`, алерты, цели, профиль | 200 |
| Формы мутаций | на 8 экранах единственный POST — `/logout`; «Новый канал», «Архивировать», «Пересчитать»/«Скрыть» алертов, «Сохранить сценарий» отсутствуют; GET-кнопки рейтинга и экспорта остались |
| Прямой POST | без токена — `403` JSON/text (CSRF); с валидным токеном `POST /api/v1/scenarios` → `403 JSON «Недостаточно прав»`, `POST /app/channels` → стилизованная 403 HTML |
| Экспорт | `download campaigns.csv` 3 243 байта — работает |
| `/app/admin/users`, `/app/audit` | 403; `/app/admin/users` снят как `403-viewer.png` |

### 5. Ошибки: что реально вернулось

| Кейс | Ответ |
|---|---|
| HTML 404 `/no-such-page` и `/app/scenarios/99999` | `404`, `errors/404`, «Страница не найдена», `noindex, nofollow`, без stack |
| HTML 403 (viewer/analyst на admin-разделах) | `403`, `errors/403`, «Недостаточно прав», `noindex, nofollow` |
| HTML 500 | `500`, `errors/500`, «Что-то сломалось», `noindex`, без текста ошибки. Снято на копии БД с переименованной `daily_stats`: настоящий отказ PostgreSQL, не подставной маршрут |
| API 404 `/api/v1/no-such` | `404 application/json` `{error:{code:"NOT_FOUND",message:"Страница не найдена"}}` |
| API 403 (viewer, с CSRF) | `403 application/json` `{error:{code:"FORBIDDEN",message:"Недостаточно прав"}}` |
| API 500 `/api/v1/dashboard` при упавшей таблице | `500 application/json` `{error:{code:"INTERNAL_ERROR",message:"Внутренняя ошибка сервера"}}`, в теле нет stack |
| Битый заголовок CSV | `400` «В файле нет обязательных колонок: stat_date, clicks, leads, spend» |
| Дубликаты (customers, dry-run) | 3 строки → принято 1, дубликаты 2 (в браузере отдельный файл: 2 строки → 0/2/0) |
| Файл > 2 МБ | `413` «Файл превышает допустимый размер 2 МБ» |
| Файл > 10 000 строк | `400` «Превышен лимит 10 000 строк» |
| Неверный MIME (PNG) | до фикса — ошибка про колонки; после фикса — `400` «Допустим только файл CSV с расширением .csv» |
| Медиа: текст с именем `.png`, SVG, PNG с подменённым типом | `400` «Допустимы только изображения PNG, JPEG или WebP» |
| Медиа > 1 МБ | `413` «Файл превышает допустимый размер 1 МБ» |
| Медиа: несуществующий/некорректный id | `/media/999999` и `/media/not-an-id` → `404 text/plain «Изображение не найдено»` |
| Медиа: чужой id | `/media/2` без авторизации → `200 image/png`: публичные ассеты (аватары и OG) отдаются по дизайну, приватности у них нет |
| CSRF | см. матрицу: API — JSON 403, page POST — `403 text/plain` |
| Rate-limit логина | 5 неверных паролей → `401`, шестой → `429` с «Слишком много попыток входа. Попробуйте снова через 15 минут.» (страница входа, не JSON) |
| Rate-limit импорта | покрыт `tests/integration/import.test.js` (20 файлов → JSON 429); в браузере квоту не сжигали |

ETag медиа на текущем сиде:

```text
GET /media/slug/og-cover
200, Content-Type: image/png, Content-Length: 35656,
ETag: "16ad8e47cb504f76f1ff1ffab982125d815f3f806b4de0ece6c6e203a90677d5",
Cache-Control: public, max-age=86400, immutable
If-None-Match: <etag> → 304, 0 bytes
```

### 6. 390×844 и клавиатура

`documentElement.scrollWidth === clientWidth` на всех экранах (проверено в браузере после навигации):

```text
/login 390/390 · / 390/390 · /app/dashboard 390/390 · /app/channels 390/390 ·
/app/channels/1 390/390 · /app/campaigns 390/390 · /app/cohorts 390/390 ·
/app/attribution 390/390 · /app/scenarios 390/390 · /app/scenarios/1 390/390 ·
/app/alerts 390/390 · /app/goals 390/390 · /app/profile 390/390 ·
/app/admin/users (403) 390/390 · /app/audit (403) 390/390 · /no-such-page (404) 390/390
```

Порядок Tab на 390 (дашборд): «Перейти к содержанию» → переключатель меню → «Метрика» → профиль → «Выйти» →
селектор периода → «Показать». Меню открывается пробелом, после этого Tab ведёт по пунктам «Дашборд», «Каналы»,
«Кампании», «Когорты», «Атрибуция» — скрытые пункты не попадают в порядок фокуса, пока меню закрыто.

### 7. Бюджеты запросов и размеры страниц

Живой подсчёт обёрткой, которая считает и `pool.query`, и `client.query` (включая `BEGIN/COMMIT` снапшота):

| Экран | Запросов | Потолок теста |
|---|---:|---:|
| `/app/dashboard` | 17 | 18 |
| `/app/channels` | 15 | 16 |
| `/app/channels/1` | 27 | 27 |
| `/app/campaigns` | 5 | — |
| `/app/cohorts` | 8 | 9 |
| `/app/attribution` | 7 | 8 |
| `/app/scenarios` | 12 | 12 |
| `/app/alerts` | 26 | 32 |
| `/app/goals` | 5 | — |
| `/app/import` | 4 | — |
| `/app/profile` | 5 | — |
| `/api/v1/alerts` | 9 | 12 |
| `/api/v1/scenarios` | 12 | 12 |

По итогам ревью `page-queries.test.js` исправлен: он больше не передаёт `pool.connect` напрямую, а форвардит
`totalCount` и оборачивает `client.query`. Поэтому `withSnapshot` идёт по production-ветке, и паспорт канала
честно считается как 17 запросов вне снапшотов + два LTV-снапшота × [BEGIN + три чтения + COMMIT] = 27.
Потолок поднят до 27, точное число и наличие двух `BEGIN … READ ONLY` закреплены отдельным тестом — обёртка,
потерявшая `totalCount`, снова покажет 23 и упадёт. Транзакционные операторы исключены из проверки дублей
(они повторяются по одному на снапшот), а чтения внутри пишущей транзакции — из неё тоже: пересчёт алертов
законно читает затронутые строки до и после записи. Фокусный прогон после правки: 11 page-queries + 26 import,
37/37.

Сжатие (`Accept-Encoding: gzip`, авторизованная сессия):

| Страница | HTML | gzip |
|---|---:|---:|
| `/` | 14 875 | 4 231 |
| `/login` (аноним) | 5 367 | 1 734 |
| `/app/dashboard` | 35 890 | 6 335 |
| `/app/channels` | 43 707 | 7 160 |
| `/app/channels/1` | 63 435 | 8 818 |
| `/app/campaigns` | 48 073 | 5 092 |
| `/app/cohorts` | 112 150 | 9 289 |
| `/app/attribution` | 25 795 | 4 677 |
| `/app/scenarios` | 56 793 | 9 446 |
| `/app/alerts` | 20 360 | 4 910 |
| `/app/goals` | 17 959 | 3 480 |
| `/app/import` | 13 306 | 3 627 |
| `/app/admin/users` | 20 996 | 3 971 |
| `/app/audit` | 25 729 | 3 836 |
| `/app/profile` | 11 435 | 3 189 |

Все ответы несут `Content-Encoding: gzip`; самая большая JS-часть — Recharts
`ChartTooltip-*.js` 642,06 кБ / 193,70 кБ gzip (остров грузится только на экранах с графиками).

### 8. Скриншоты

Все сняты в Chromium 1440×1000, кроме `mobile-390.png` (390×844); в кадре — состояние после действий,
описанных в матрице.

| Файл | Что на снимке |
|---|---|
| `login.png` | форма входа с заполненным аналитиком (одна карточка, без списка демо-аккаунтов) |
| `dashboard-analyst.png` | дашборд аналитика, KPI и отрисованный график CAC |
| `channels-analyst.png` | каналы: веса рейтинга, форма нового канала, рейтинг |
| `cohorts.png` | матрица удержания, неполные когорты помечены |
| `attribution.png` | три модели и столбчатый график, «Последнее касание» выбрано |
| `alerts.png` | сводка и график CAC TikTok |
| `scenarios.png` | builder: слайдер, каналы, результат расчёта |
| `admin-users.png` | пользователи, настоящая OG-обложка после фикса сида |
| `audit.png` | журнал действий с фильтрами |
| `import-error.png` | битый заголовок CSV, отчёт «Файл не загружен» |
| `403-viewer.png` | viewer на `/app/admin/users` |
| `404.png` | публичный 404 |
| `500.png` | styled 500 при отказе БД |
| `mobile-390.png` | дашборд аналитика на 390×844 |

Первый снимок дашборда был сделан сразу после редиректа и показывал пустые карточки графиков — React-остров
ещё не гидратировался, при пустых `console`/`errors`. Снимок переснят после ожидания `.recharts-line-curve`;
процедура записана в `IMPROVEMENTS.md`. Перед финальными снимками дашборда/`admin-users`/`mobile-390` стенд
пересижен начисто, чтобы в кадр не попали тестовые канал/пользователь; журнал и записи аудита выше сняты до
этого пересида.

### 9. Не проверено здесь — закрывает владелец

- **Firefox** — в окружении агента только Chromium. Ручной сценарий для прогона владельцем: вход → дашборд →
  каналы → атрибуция → сценарии (слайдер стрелками) → импорт dry-run. Скриншоты `firefox-*.png` не создавались.
- **Opera/Yandex** — не установлены; результат не заявляется.
- **Windows 10** — Windows-машины нет. Smoke по `docs/deployment.md`: native-путь, вход, импорт, backup+restore,
  Планировщик заданий.
- **Docker Desktop** — не запускался; Docker Engine на Linux проверен в Task 1, но Docker Desktop — отдельный
  прогон владельца.
- **TLS/публичный HTTPS-стенд** — не поднимался; HSTS-ветка проверена интеграционным тестом с `hsts: true`.
- **Бэкап** — в Task 6 не перезапускался; доказательства Task 2 (создание, AES-256-GCM, restore в scratch-БД,
  row-count + key checksum, повреждённый файл → код 1) остаются в разделе Task 2 выше.

### Verdict Task 6

Матрица трёх ролей пройдена в Chromium на чистом нативном стенде; RBAC, CSRF, 403/404/500, импорт, медиа,
алерты, сценарии и экспорт подтверждены фактическими ответами и записями `audit_log`. Полный `npm test` —
105 файлов / 1374 теста. Найдены и закрыты два дефекта (MIME/расширение импорта, OG-заглушка в сиде) с
регрессионными тестами. Firefox, Opera/Yandex, Windows 10, Docker Desktop и TLS остаются за владельцем и здесь
не заявляются.

## Task 7 — снимки для руководства пользователя

Дата съёмки: 24.11.2026. База: `85a8f67`; UI не менялся с `6eb69cb`, отличаются только тесты и валидатор импорта.
Стенд — native Linux, Node.js на хосте, PostgreSQL 18, отдельный процесс на `127.0.0.1:3100`, браузер Chromium
через `agent-browser`, ширина 1440×1000 (мобильный снимок — 390×844). Перед съёмкой БД `metrika_dev` пересижена:
data anchor `2026-11-23`, 8 каналов, 32 кампании, 3 пользователя. Все снимки сняты после гидратации островов;
`agent-browser console` и `agent-browser errors` на каждом экране пусты.

| Файл | Что на снимке |
|---|---|
| `guide/landing.png` | лендинг, первый экран, 1440×1000 |
| `guide/landing-mobile.png` | лендинг на 390×844 |
| `guide/dashboard-admin.png` | дашборд под администратором: KPI, вердикт, CAC по неделям |
| `guide/channel.png` | паспорт канала Instagram: метрики, цели канала |
| `guide/campaigns.png` | кампании: фильтры, итоги, форма новой кампании, таблица |
| `guide/goals.png` | цели: фильтры, форма новой цели, список планов |
| `guide/profile.png` | профиль: учётная запись, аватар, смена пароля |
| `guide/import.png` | импорт CSV: форма, форматы и шаблоны |
| `guide/import-dry-run.png` | dry-run: «Проверка пройдена», 1 строка, 0 ошибок |
| `guide/import-success.png` | боевой импорт: «Импорт сохранён», ссылка на отчёт пакета |

Снимки `login.png`, `dashboard-analyst.png`, `channels-analyst.png`, `cohorts.png`, `attribution.png`,
`alerts.png`, `scenarios.png`, `admin-users.png`, `audit.png`, `import-error.png`, `403-viewer.png`, `404.png`,
`500.png` и `mobile-390.png` из Task 4/6 переиспользованы в руководстве: они сняты на том же HEAD и показывают
те же экраны. Новые снимки не подменяют доказательства Task 6 и не добавляют состояний, которых нет в продукте.

## Task 8 — публикационные ворота и чистый клон

Дата: 24.11.2026. Ветка `main`, Linux (CachyOS), Node.js на хосте `v26.13.0`, npm `12.2.1`, PostgreSQL `18.6`.
Проверялось дерево задачи T8: версия `1.0.0`, `LICENSE`-плейсхолдер, `docs/publication.md`,
`scripts/fresh-clone-check.js`, `tests/unit/repo-hygiene.test.js`, `tests/unit/publication.test.js`,
triage `IMPROVEMENTS.md`.

### 1. Предкоммитные ворота

| Проверка | Команда | Результат |
|---|---|---|
| Полный набор тестов | `npm test` | **108 файлов / 1406 тестов, все зелёные**, два прогона: 99,85 с и 100,82 с |
| Production-сборка | `npm run build` | `✓ built in 1.50s`; единственное предупреждение — известный чанк `ChartTooltip` 642,06 кБ / 193,70 кБ gzip |
| Конфигурация Compose | `docker compose config` | exit `0`, 94 строки, stderr пуст (Compose v5.8.0, Engine 29.9.2) |
| Гигиена индекса | `npx vitest run tests/unit/repo-hygiene.test.js` | 9 тестов: нет `.env`, `public/assets`, `node_modules`, логов, бэкапов, файлов > 5 МБ и домашних путей; `.env.example` полон; `src/` без `console.log` |
| Публикационный пакет | `npx vitest run tests/unit/publication.test.js` | 16 тестов: `LICENSE`, описания ≤ 160/≤ 350, 11 тем, OG-PNG, тег и блокеры, версия и `/health`, helper'ы `check:fresh` |

Версия и `/health` проверяются не только юнит-тестом: чистый клон ниже сравнивает `version` из `package.json` с
ответом запущенного сервера.

### 2. Чистый клон

Заполняется результатом `npm run check:fresh` **после** коммита задачи T8: скрипт берёт зафиксированный SHA, а не
рабочее дерево, поэтому его нельзя запускать до коммита. Итог (SHA, длительность, URL, удаление БД и каталога)
записан отдельным `docs:`-коммитом — без правки задним числом.
