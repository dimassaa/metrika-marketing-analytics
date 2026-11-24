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
--format=custom --no-owner --no-acl --dbname postgres://dimass@localhost:5432/metrika_dev
no password in argv
```

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
остаются `#3398e1` (3,13:1 на белой карточке).

### 3. Записанное исключение владельца

Highlight-пара `#3398e1` на `#c1e1f7` — **2,29:1**, ниже AA даже для крупного текста. Владелец решил сохранить
брендовую пару только в заголовке лендинга; для тела текста и интерфейса она не используется. Исключение
зафиксировано комментарием у `.highlight` и тестом `contrast.test.js`.

### 4. Фактическая проверка в браузере

Снимки: `a11y-390-dashboard.png`, `a11y-focus-menu-390.png`, `a11y-focus-nav-1280.png`,
`a11y-focus-skip-390.png`, `a11y-focus-table-390.png`.

Живой `getComputedStyle` (не токены, а фактические пары на страницах): muted `rgb(120,113,108)` на
`rgb(250,250,249)` — 4,59; заголовок таблицы на белом — 4,80; здоровый статус на белом — 4,98; активный пункт
меню на белом — 19,76; подпись поля на canvas — 18,92; highlight — 2,29 (исключение выше). Кольцо фокуса в
браузере — `rgb(47,139,208)`, ширина 2 px, offset 2 px. Ширина 390 px: `scrollWidth === clientWidth` на всех
12 экранах, таблицы прокручиваются внутри `.table-wrap`, topbar начинается после меню (нет перекрытия).

## Не проверено здесь — закрывает владелец

- **Windows 10** и **Docker Desktop**: у агента нет Windows-машины; Linux-прогон их не заменяет. Для Task 2 это
  значит, что Windows-ветка `docs/deployment.md` §5 (ACL ключа, Планировщик, `0x0`) написана, но не выполнена.
- **Firefox**: доступен только Chromium через `agent-browser`; кросс-браузерная матрица — прогон владельца.
- **TLS**: публичный HTTPS-стенд за reverse proxy в этой задаче не поднимался.

## Verdict

Compose установлен и проверен реальным выводом `docker compose config/up`; Docker-путь Task 1 **закрыт**.
Task 2 **закрыт на Linux и в контейнере** (row-count + key checksum, включая password-auth Compose-стенд); Windows-прогон
остаётся за владельцем. Ограничения выше относятся к T6/T8 и не выдаются за выполненные.
