# Развёртывание «Метрики»

Руководство для двух путей: Docker-стенд (демонстрация и проверка) и native Linux (разработка и стенд без
контейнеров). Windows, TLS и резервные копии — разделы-заглушки: они наполняются в задачах M6, которые отвечают за
эти сценарии, и до этого не считаются проверенными.

Состояние на 24.11.2026: Docker-путь проверен реальным `docker compose config/up` на Docker Engine 29.9.2 и
Docker Compose v5.8.0; native-путь ранее проверен на Node.js 26 и PostgreSQL 18.6. Подробный журнал с выводом
команд — `docs/screenshots/m6/README.md`.

## 1. Требования

| Компонент | Минимум | Примечание |
|---|---|---|
| Node.js | 24 LTS | `engines.node` — `>=24`; контейнер использует `node:24-bookworm-slim` |
| PostgreSQL | 18 | в контейнере — `postgres:18-alpine`; клиент в образе — `postgresql-client-18` |
| Docker Engine | 27+ | проверено на 29.9.2 |
| Docker Compose | v2 (плагин) | проверено на v5.8.0; без плагина Docker-путь не считается проверенным |
| Свободный порт | 3000/TCP на loopback | меняется через `APP_PORT`, публикуется только на `127.0.0.1` |

Валюта — белорусский рубль (BYN), расчёты идут в целых копейках. Часовой пояс расчётов — Europe/Minsk; «сегодня»
берётся из данных (`MAX(daily_stats.stat_date)`), а не из системных часов.

## 2. Docker-путь

### 2.1. Предусловие: плагин Compose

```bash
docker compose version
```

Если команда отвечает `docker: unknown command: docker compose`, установите pinned-релиз Compose v2 user-level, без
`sudo`. Замените `vX.Y.Z` на конкретную версию из GitHub Releases; «latest» вслепую не тяните, версию запишите в
журнал.

```bash
mkdir -p ~/.docker/cli-plugins
curl -fsSL -o ~/.docker/cli-plugins/docker-compose \
  https://github.com/docker/compose/releases/download/vX.Y.Z/docker-compose-linux-x86_64
curl -fsSL -o /tmp/docker-compose.sha256 \
  https://github.com/docker/compose/releases/download/vX.Y.Z/docker-compose-linux-x86_64.sha256
expected=$(cut -d' ' -f1 < /tmp/docker-compose.sha256)
actual=$(sha256sum ~/.docker/cli-plugins/docker-compose | cut -d' ' -f1)
[ "$expected" = "$actual" ] || { echo "checksum mismatch"; exit 1; }
chmod +x ~/.docker/cli-plugins/docker-compose
docker compose version
```

Проверка контрольной суммы сверяет скачанный бинарь с `.sha256` из того же релиза; для более строгой проверки
сравните `expected` с digest, опубликованным на странице релиза. Без этой сверки установка плагина считается
непроверенной.

Для другой архитектуры возьмите соответствующий артефакт (`docker-compose-linux-aarch64` и т. п.). Если установка
невозможна (нет сети, политика), остаётся только `docker run` fallback: он проверяет образ, но не Compose, поэтому
Docker-путь и публикация остаются незакрытыми.

### 2.2. Запуск без правки файлов

```bash
docker compose config
docker compose up --build -d
docker compose ps
curl -fsS http://127.0.0.1:3000/health
```

`docker compose config` обязан завершаться с кодом 0 и без файла `.env`: все значения имеют дефолты
(`${POSTGRES_USER:-postgres}` и т. п.). `up` поднимает `db`, дожидается `service_healthy`, применяет миграции,
сеет демо-данные только на пустой БД и запускает приложение.

Демо-вход: `admin@metrika.by` / `Metrika2026!`. Пароль демонстрационный и совпадает с `db/seed/data.js`; на публичном
стенде он не используется.

### 2.3. Что происходит при старте

1. `docker/entrypoint.sh` читает или генерирует `SESSION_SECRET` в файле `/app/data/session-secret` (0600).
2. Создаёт `/app/data/tmp` (0700) для временных файлов восстановления.
3. Если `RUN_MIGRATIONS` не `false`, выполняет `node db/migrate.js`; повторный запуск идемпотентен.
4. Если `AUTO_SEED_DEMO=true`, выполняет `node scripts/seed-demo.js`. Сид запускается, только когда одновременно
   пусты `users`, `channels` и `daily_stats`; иначе данные не трогаются.
5. `exec node src/server.js` — приложение становится прямым потомком init-процесса и получает SIGTERM.

`RUN_MIGRATIONS` намеренно имеет разные значения по умолчанию: `env.js` (обычный `npm start` вне контейнера)
считает отсутствующую переменную за `false`, а `docker/entrypoint.sh` — за `true`, потому что Compose-стенд должен
подниматься без правки файлов. Это не расхождение трактовки, а разные точки входа: приложение не накатывает
миграции само, entrypoint делает это до старта. Явное `RUN_MIGRATIONS=false` в `.env` или Compose отключает шаг в
обеих точках входа.

### 2.4. Остановка и сброс

```bash
docker compose stop db          # приложение отвечает /health 503 и становится unhealthy
docker compose start db         # снова healthy
docker compose down             # контейнеры удалены, named volumes сохранены
docker compose up -d            # данные и сессии на месте
docker compose down -v          # полный сброс: БД, секрет сессии, бэкапы
```

Порт PostgreSQL наружу не публикуется. Порт приложения привязан к `127.0.0.1`; для публичного доступа нужен
reverse proxy с TLS (раздел 5) и `COOKIE_SECURE=true`.

## 3. Native Linux

```bash
cp .env.example .env
# отредактируйте DATABASE_URL, TEST_DATABASE_URL, SESSION_SECRET, APP_URL
npm ci
npm run db:setup      # создаёт dev/test БД идемпотентно
npm run migrate
npm run seed           # детерминированный демо-набор «Зёрна»
npm run build          # Vite: public/assets
npm start              # http://localhost:3000
```

`DATABASE_URL` и `TEST_DATABASE_URL` должны указывать на разные базы. Тесты используют только
`TEST_DATABASE_URL`; интеграционные тесты очищают её схему. Для production задайте `NODE_ENV=production`,
`COOKIE_SECURE=true` и реальный `SESSION_SECRET` (не плейсхолдер из `.env.example`).

`npm run db:setup` требует роль, которая может подключаться к базе `postgres` и создавать БД. Если таких прав нет,
создайте базы вручную через `createdb` и пропустите шаг.

## 4. Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `NODE_ENV` | `development` | `production` включает guard'ы секрета и cookie |
| `PORT` | `3000` | HTTP-порт приложения внутри контейнера |
| `DATABASE_URL` | — | `postgres://…`; в Compose собирается из `POSTGRES_*` |
| `TEST_DATABASE_URL` | — | только для интеграционных тестов |
| `POSTGRES_USER` | `postgres` | только Compose: пользователь и владелец БД |
| `POSTGRES_PASSWORD` | `postgres` | только Compose: пароль; см. предупреждение ниже |
| `POSTGRES_DB` | `metrika` | только Compose: имя создаваемой БД |
| `SESSION_SECRET` | — | минимум 32 символа; в контейнере генерируется в файл |
| `SESSION_SECRET_FILE` | `/app/data/session-secret` | файл секрета в контейнере |
| `APP_URL` | — | абсолютный URL; для демо — `http://localhost:3000` |
| `COOKIE_SECURE` | `false` | только `true`/`false`; в production обязан быть `true`, кроме демо-исключения |
| `DEMO_INSECURE_COOKIES` | `false` | демо-исключение: принимается только с loopback `APP_URL` |
| `AUTO_SEED_DEMO` | `false` | entrypoint проверяет пустоту трёх таблиц и сеет демо |
| `RUN_MIGRATIONS` | `false` в `env.js`, `true` в entrypoint | `false` отключает миграции при старте |
| `TRUST_PROXY` | `false` | число хопов, список подсетей или `false`; формат не булев |
| `LOG_LEVEL` | `info` | `pino` |
| `BACKUP_KEY_FILE` | — | файл 32-байтного ключа бэкапа (hex или base64), права `0600` |
| `BACKUP_KEY` | — | ключ строкой только для native CLI без файла; в Compose не задаётся |
| `BACKUP_DIR` | `./backups` (CLI) | каталог зашифрованных дампов; в Compose `/backup` |
| `BACKUP_RETENTION_DAYS` | `7` | возраст, после которого старые `metrika-*.dump.enc` удаляются |
| `RESTORE_TMP_DIR` | `os.tmpdir()` | временные файлы восстановления; в Compose `/app/data/tmp` |
| `ADMIN_DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/postgres` | подключение для `db:setup` и `restore --create`; роль с `CREATEDB` |
| `PG_DUMP` | `pg_dump` из `PATH` | абсолютный путь к клиенту `pg_dump` |
| `PG_RESTORE` | `pg_restore` из `PATH` | абсолютный путь к клиенту `pg_restore` |

`POSTGRES_USER`, `POSTGRES_PASSWORD` и `POSTGRES_DB` читает только Compose: из них собирается `DATABASE_URL` для
контейнера `app` и создаётся кластер `db`. Пароль подставляется в URL без percent-encoding, поэтому символы
`@ : / ?` ломают строку подключения. Для демо используется литерал `postgres`; на другом стенде берите
URL-безопасный пароль (буквы, цифры, `-`, `_`) или задавайте `DATABASE_URL` вручную с percent-encoding
(`p%40ss` вместо `p@ss`). Обратная косая черта и `#` в `.env` тоже требуют осторожности: `#` начинает комментарий.

Булевы переменные принимают **только** `true` и `false`. Значения `0`, `1`, `yes` отклоняются на старте с русским
сообщением: entrypoint и `env.js` не должны расходиться в трактовке одного и того же значения.

Production-guard: при `NODE_ENV=production` и `COOKIE_SECURE=false` приложение стартует только если одновременно
`DEMO_INSECURE_COOKIES=true` и hostname `APP_URL` точно равен `localhost`, `127.0.0.1` или `[::1]`.
`localhost.evil.com`, `127.0.0.1.evil.com` и `[::1].evil.com` отклоняются. С `COOKIE_SECURE=true` флаг игнорируется.

## 5. Windows 10

Раздел описывает native-путь без Docker Desktop. **Фактический прогон на Windows в этом репозитории не
выполнялся** — все команды ниже проверены только на Linux; владелец подтверждает их на своей машине и дописывает
результат в журнал `docs/screenshots/m6/README.md`. Непроверенный Windows-путь не считается закрытым.

### 5.1. Установка

1. Node.js 24 LTS с nodejs.org; `node -v` и `npm -v` должны работать в новой консоли.
2. PostgreSQL 18 с enterprisedb.com; запомните пароль суперпользователя. Клиенты `pg_dump.exe` и `pg_restore.exe`
   лежат в `C:\Program Files\PostgreSQL\18\bin`. Либо добавьте этот каталог в `PATH`, либо задайте абсолютные пути
   в `.env` (надёжнее для Планировщика).
3. Репозиторий, например `C:\Metrika`. Скопируйте `.env.example` в `.env`.

```ini
DATABASE_URL=postgres://postgres:postgres@localhost:5432/metrika_dev
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/metrika_test
ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
BACKUP_KEY_FILE=C:\ProgramData\Metrika\backup.key
BACKUP_DIR=C:\MetrikaBackups
BACKUP_RETENTION_DAYS=7
RESTORE_TMP_DIR=C:\Metrika\tmp
PG_DUMP=C:\Program Files\PostgreSQL\18\bin\pg_dump.exe
PG_RESTORE=C:\Program Files\PostgreSQL\18\bin\pg_restore.exe
```

Путь с пробелами задаётся в `.env` без кавычек: значение читает Node, а не shell. Если пароль PostgreSQL содержит
`@`, `:`, `/` или `?`, percent-encode его в URL (см. §4).

### 5.2. Ключ бэкапа и ACL

Ключ создаётся один раз, в PowerShell 5.1:

```powershell
New-Item -ItemType Directory -Force 'C:\ProgramData\Metrika' | Out-Null
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
[IO.File]::WriteAllText('C:\ProgramData\Metrika\backup.key', $hex)
```

ACL: наследование снимается, читать могут только SYSTEM и администраторы; служебному пользователю задачи
добавляется только чтение. SID надёжнее локализованных имён групп:

```powershell
icacls 'C:\ProgramData\Metrika\backup.key' /inheritance:r
icacls 'C:\ProgramData\Metrika\backup.key' /grant:r '*S-1-5-18:(R)' '*S-1-5-32-544:(R)'
# если задача идёт не от SYSTEM, а от выделенной учётной записи:
icacls 'C:\ProgramData\Metrika\backup.key' /grant:r 'METRIKA\svc-metrika:(R)'
```

Ключ не кладётся в репозиторий, `.env` или аргументы командной строки. Права проверяются через
`icacls 'C:\ProgramData\Metrika\backup.key'`: лишние записи (`Users`, `Everyone`) недопустимы.

### 5.3. Задача Планировщика

Задача запускает абсолютный `node.exe`, а не `npm`, иначе `npm` станет лишним родителем и код выхода потеряется.
Рабочий каталог — корень репозитория, чтобы `dotenv` нашёл `.env`. PowerShell (запуск от администратора):

```powershell
$action = New-ScheduledTaskAction `
  -Execute 'C:\Program Files\nodejs\node.exe' `
  -Argument 'C:\Metrika\scripts\backup.js' `
  -WorkingDirectory 'C:\Metrika'
$trigger = New-ScheduledTaskTrigger -Daily -At 02:30
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'Metrika backup' -Action $action -Trigger $trigger -Principal $principal
```

Для выделенной учётной записи вместо SYSTEM: `-UserId 'METRIKA\svc-metrika' -LogonType Password` и регистрация
с паролем (или GUI-переключатель «Выполнять независимо от того, вошёл ли пользователь в систему»). SYSTEM не
требует пароля и всегда работает без входа пользователя.

### 5.4. Проверка после прогона

1. В Планировщике: «Последний результат» (`Last Run Result`) = `0x0`.
2. В `C:\MetrikaBackups` появился `metrika-YYYY-MM-DDTHH-mm-ssZ.dump.enc`, размер больше нуля.
3. Файл расшифровывается и восстанавливается:

```powershell
cd C:\Metrika
node scripts\restore.js --file C:\MetrikaBackups\<file>.dump.enc `
  --database metrika_restore_check --create --verify
```

4. `--verify` печатает «row-count + key checksum: совпадает». Scratch-базу после проверки удалите:
`dropdb -h localhost -U postgres metrika_restore_check`.

Копирование бэкапа на другой диск/в сетевое хранилище — только `Copy-Item` или `robocopy`:

```powershell
Copy-Item 'C:\MetrikaBackups\metrika-*.dump.enc' 'D:\Backups\Metrika\' -Force
robocopy 'C:\MetrikaBackups' '\\nas\backups\Metrika' *.dump.enc /COPY:DAT /R:2 /W:5
```

Нельзя использовать `>` и `Out-File`: PowerShell перекодирует поток и испортит бинарный файл. Скрипты сами не
используют shell-редиректы и текстовые режимы, поэтому `spawn` с массивом аргументов работает одинаково на
Windows и Linux.

Docker Desktop — альтернатива native-пути; тогда действуют §2 и §7, а Планировщик запускает
`docker compose exec app node scripts/backup.js` с абсолютным путём к `docker.exe`.

## 6. TLS и reverse proxy

Заглушка. Публичный стенд обязан работать по HTTPS: reverse proxy (Caddy/nginx) завершает TLS, приложение слушает
loopback, `COOKIE_SECURE=true`, `DEMO_INSECURE_COOKIES=false`, `TRUST_PROXY` соответствует числу прокси. Раздел
наполняется вместе с аудитом безопасности.

## 7. Резервные копии

### 7.1. Формат и ключ

`pg_dump --format=custom --no-owner --no-acl` шифруется AES-256-GCM и пишется атомарно (`*.tmp` + `rename`) с
правами `0600`. Раскладка файла `v1`:

```
MTRKBK1\0 | uint32BE длина заголовка | JSON {"v":1,"alg":"aes-256-gcm","iv":"…"} | ciphertext | 16-байтный тег GCM
```

Заголовок передаётся в `cipher.setAAD()` ровно теми байтами, что лежат в файле: подмена `v`, `alg` или `iv` ломает
аутентификацию, а не меняет поведение расшифровки. Имя БД, время создания и версия `pg_dump` в заголовок не
попадают — они печатаются в консоль запуска. Тег лежит в трейлере, поэтому размер ciphertext вычисляется как
`fileSize − 8 − 4 − headerLength − 16`; весь дамп в память не загружается.

Ключ — ровно 32 байта. Основной источник — файл `BACKUP_KEY_FILE` с правами `0600`; `BACKUP_KEY` допустим только
для native-CLI, где файла нет, и **никогда** не задаётся в Compose. Плейсхолдер `replace-with-…`, короткий или
длинный ключ отвергаются до запуска `pg_dump`.

Linux/macOS, один раз:

```bash
install -d -m 700 backups
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))" > backups/backup.key
chmod 600 backups/backup.key
```

`backups/` и `*.dump.enc` уже в `.gitignore`. Windows — §5.2. Один и тот же ключ нужен для восстановления: без
него файл не расшифровать, восстановление невозможно.

### 7.2. Создание копии

```bash
npm run backup
npm run backup -- --keep 14
npm run backup -- --out ./backups/manual.dump.enc
```

- `BACKUP_DIR` (по умолчанию `./backups`) — каталог; имя `metrika-YYYY-MM-DDTHH-mm-ssZ.dump.enc` в UTC.
- `BACKUP_RETENTION_DAYS` (по умолчанию `7`) — возраст, после которого старые файлы удаляются. Удаляются только
  `metrika-*.dump.enc`; `README.txt`, ручные копии и `--out` не затрагиваются. Минимум один бэкап остаётся всегда.
- `--keep N` — сохранить как минимум N самых новых файлов независимо от возраста.
- `--out PATH` — записать в конкретный файл и не применять retention (удобно для ручной копии).
- `PG_DUMP` переопределяет бинарь; `pg_dump` вызывается без shell, массивом аргументов.

Перед дампом сравниваются мажорные версии. `pg_dump` старше сервера → запуск отменяется: данные новее формата.
`pg_dump` новее сервера → предупреждение и продолжение. Фактические версии печатаются в лог. Пароль из
`DATABASE_URL` в сообщениях и `stderr` редактируется на `***`.

Код выхода `0` — файл создан; `1` — понятное сообщение об ошибке и никакого нового файла. Временный `.staged`
удаляется, существующий `--out` не перезаписывается частичным дампом.

### 7.3. Восстановление и проверка

```bash
npm run restore -- --file ./backups/<file>.dump.enc
npm run restore -- --file ./backups/<file>.dump.enc --database metrika_restore_check --create --verify
```

- `--database` валидируется `/^[a-z][a-z0-9_]*$/` и цитируется через `escapeIdentifier` **до** любого подключения;
  `bad;drop`, `Bad-Name` и другие имена отвергаются.
- Без `--force` скрипт отказывается писать в базу, совпадающую с `DATABASE_URL`: `pg_restore --clean` удаляет
  объекты. `--force` — только осознанное восстановление поверх рабочей БД.
- `--create` создаёт scratch-базу через `ADMIN_DATABASE_URL` (по умолчанию
  `postgres://postgres:postgres@localhost:5432/postgres`); роль обязана иметь `CREATEDB`. Существующая база
  переиспользуется, но не пересоздаётся. База создаётся от роли `ADMIN_DATABASE_URL`, а восстанавливает её роль из
  `DATABASE_URL`; если это разные роли, роль восстановления должна владеть базой или иметь `CREATE` на схеме
  `public` — иначе `pg_restore --clean` не сможет удалить и создать схему. В дефолтном демо обе роли совпадают.
- Дамп расшифровывается во временный файл `0600` в `RESTORE_TMP_DIR` (по умолчанию `os.tmpdir()`), затем
  `pg_restore --clean --if-exists --no-owner --no-acl`, затем временный каталог удаляется в `finally` даже при
  ошибке.
- `--verify` сравнивает **row-count + key checksum**: `count(*)` и
  `md5(string_agg(id::text, ',' ORDER BY id))` по `users`, `channels`, `campaigns`, `customers`, `orders`,
  `daily_stats`, `audit_log`. Печатается таблица, при любом расхождении код выхода `1`. Это не побайтовое и не
  полное логическое сравнение БД; формулировка «row-count + key checksum» и есть граница проверки.
- Источник для `--verify` — `DATABASE_URL`. Запускайте проверку сразу после создания копии: если рабочая БД
  изменилась между дампом и проверкой, расхождение ожидаемо.
- Повреждённый файл (подменённый байт, битый тег, неверный ключ) завершается кодом `1` на этапе расшифровки;
  `pg_restore` не запускается, scratch-база не создаётся.

### 7.4. Docker/Compose

В Compose уже заданы `BACKUP_KEY_FILE=/app/data/backup.key`, `BACKUP_DIR=/backup`,
`RESTORE_TMP_DIR=/app/data/tmp`; `BACKUP_KEY` в окружении отсутствует. Ключ создаётся один раз внутри контейнера
(файл в volume `app_data`, не в образе):

```bash
docker compose exec -T app node -e "require('node:fs').writeFileSync('/app/data/backup.key', require('node:crypto').randomBytes(32).toString('hex')+'\n', {mode:0o600})"
docker compose exec -T app stat -c '%a %n' /app/data/backup.key   # 600
docker compose exec -T app node scripts/backup.js
docker compose exec -T app ls -l /backup
docker compose cp app:/backup/<file>.dump.enc .
```

Восстановление внутри контейнера требует `ADMIN_DATABASE_URL`, указывающего на сервис `db`, а не на `localhost`:

```bash
docker compose exec -T -e ADMIN_DATABASE_URL=postgres://postgres:postgres@db:5432/postgres \
  app node scripts/restore.js --file /backup/<file>.dump.enc \
  --database metrika_restore_check --create --verify
docker compose exec -T db psql -U postgres -d postgres -c 'DROP DATABASE metrika_restore_check'
```

`/tmp` в контейнере — tmpfs 256 MB; крупный дамп туда не поместится, поэтому `RESTORE_TMP_DIR` указывает на
`/app/data/tmp` в volume. Не меняйте его на `/tmp` без увеличения tmpfs. Забирать бэкап с контейнера — только
`docker compose cp`; bind-mount `./backups` оставляет файлы принадлежащими хосту и может быть недоступен uid 1000.

## 8. Диагностика

Заглушка. Базовые команды уже проверены:

```bash
docker compose ps
docker compose logs app --tail=100
docker inspect --format '{{.State.Health.Status}}' metrika-app-1
curl -i http://127.0.0.1:3000/health
docker compose exec app id -u      # 1000, не 0
```

Частые причины: занятый `APP_PORT`, неприменённые миграции, недоступная БД (тогда `/health` отдаёт 503, а
контейнер — `unhealthy`), неверный `SESSION_SECRET` (короче 32 символов), `COOKIE_SECURE=false` в production без
демо-исключения.
