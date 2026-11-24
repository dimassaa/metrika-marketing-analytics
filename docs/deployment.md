# Развёртывание «Метрики»

Руководство для двух путей: Docker-стенд (демонстрация и проверка) и native-установка (разработка и стенд без
контейнеров). Windows 10 разобран отдельно в §5, TLS/reverse proxy — в §6, резервное копирование — в §7,
обновление — в §8, восстановление демо-базы — в §9, диагностика — в §10. Фактический прогон на Windows и Docker Desktop
подтверждает владелец отдельно (§11): агент эти пути не выполнял и не выдаёт их за проверенные.

Состояние на 24.11.2026: Docker-путь проверен реальным `docker compose config/up` на Docker Engine 29.9.2 и
Docker Compose v5.8.0; native-путь проверен на Node.js 26 (`engines.node` — `>=24`) и PostgreSQL 18.6.
Подробный журнал с выводом команд — `docs/screenshots/m6/README.md`. Windows-команды ниже не выполнялись в этом
репозитории: это инструкция для прогона владельцем, а не отчёт о прогоне.

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
docker compose down -v          # полный сброс: БД, секрет сессии, бэкапы и ключ в app_data
```

`down -v` удаляет и ключ `/app/data/backup.key` из тома `app_data`: без копии на хосте старые бэкапы больше не
расшифровать. Перед сбросом скопируйте ключ на хост и закройте права:

```bash
docker compose cp app:/app/data/backup.key ./backup.key.offline
chmod 600 ./backup.key.offline
```

Порядок хранения и ротации ключа — §7.6.

Порт PostgreSQL наружу не публикуется. Порт приложения привязан к `127.0.0.1`; для публичного доступа нужен
reverse proxy с TLS (раздел 6) и `COOKIE_SECURE=true`.

### 2.5. Контракт проверки

```bash
curl -fsS http://127.0.0.1:3000/health
# {"status":"ok","db":"up","version":"1.0.0"}
```

`/health` проверяет БД запросом `SELECT 1`. Если PostgreSQL недоступен, приложение отвечает `503` с
`{"status":"error","db":"down","version":"1.0.0"}`, а Compose-контейнер становится `unhealthy`: это ожидаемое
поведение, а не падение процесса. Демо-вход — `admin@metrika.by` / `Metrika2026!`; данные появляются только при
пустой БД, повторный `docker compose up` их не перезаписывает.

## 3. Native Linux

### 3.1. Первый запуск

Понадобятся Node.js 24 LTS, npm и PostgreSQL 18. Проверьте версии до установки пакетов:

```bash
node -v       # v24.x или новее
npm -v
psql --version
```

```bash
git clone <URL-репозитория> metrika
cd metrika
npm ci
cp .env.example .env
```

Сгенерируйте `SESSION_SECRET` (не короче 32 символов) и заполните `.env`:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

```bash
npm run db:setup      # создаёт dev/test БД идемпотентно
npm run migrate       # применяет SQL-миграции 001–006
npm run seed          # детерминированный демо-набор «Зёрна»
npm run build         # Vite: public/assets
npm start             # http://localhost:3000
```

`npm start` не собирает острова. Без `public/assets/.vite/manifest.json` production-режим останавливается с
подсказкой выполнить `npm run build`. Для разработки удобнее `npm run dev`: он собирает острова один раз и
перезапускает сервер при изменении файлов.

### 3.2. Проверка

```bash
curl -fsS http://localhost:3000/health
curl -sSI http://localhost:3000/login | head -1
```

Ожидается `200` и JSON из §2.5. Войдите демо-учётной записью и откройте дашборд; в шапке должна быть подпись
«Данные по …» — это фактический data anchor, а не системная дата.

`DATABASE_URL` и `TEST_DATABASE_URL` должны указывать на разные базы. Тесты используют только
`TEST_DATABASE_URL`; интеграционные тесты очищают её схему. Для production задайте `NODE_ENV=production`,
`COOKIE_SECURE=true` и реальный `SESSION_SECRET` (не плейсхолдер из `.env.example`).

`npm run db:setup` требует роль, которая может подключаться к базе `postgres` и создавать БД. Если таких прав нет,
создайте базы вручную через `createdb` и пропустите шаг.

## 4. Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `NODE_ENV` | `development` | `production` включает guard'ы секрета и cookie |
| `PORT` | `3000` | HTTP-порт приложения внутри контейнера и native-процесса |
| `APP_PORT` | `3000` | только Compose: порт на loopback-хосте (`127.0.0.1:APP_PORT`) |
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

> **Статус:** на Windows 10 этот раздел **не проверялся** в текущем репозитории. Команды составлены по
> требованиям Node.js и PostgreSQL и по проверенному Linux-пути; владелец выполняет их на своей машине и
> дописывает результат в `docs/screenshots/m6/README.md`. Без этого прогона Windows-путь считается открытым,
> а не «работает, потому что написано».

### 5.1. Node.js 24 LTS

1. Установите Node.js 24 LTS с nodejs.org (MSI x64) или командой `winget install OpenJS.NodeJS.LTS`.
2. Откройте **новое** окно PowerShell и проверьте версии. Старое окно не увидит обновлённый `PATH`.

```powershell
node -v      # v24.x
npm -v
```

### 5.2. PostgreSQL 18, служба и PATH

1. Установите PostgreSQL 18 с enterprisedb.com. Порт оставьте `5432`, пароль роли `postgres` сохраните: он нужен
   в строке подключения.
2. Клиенты `pg_dump.exe` и `pg_restore.exe` лежат в `C:\Program Files\PostgreSQL\18\bin`. Добавьте этот каталог
   в `PATH` через «Параметры системы → Переменные среды → Path → Изменить → Создать» либо задайте абсолютные
   пути в `.env` (надёжнее для Планировщика заданий).
3. Проверьте, что служба запущена, а новый PowerShell видит клиент:

```powershell
Get-Service postgresql* | Format-Table Name, Status
psql --version
```

Если `psql` не найден, вернитесь к шагу 2 или используйте полный путь
`& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' --version`.

### 5.3. Роль, базы и `.env`

Роль `postgres` из установщика имеет право создавать БД, поэтому `db:setup` может создать `metrika_dev` и
`metrika_test` сам. Если используется отдельная роль, выдайте ей `CREATEDB` или создайте базы вручную:

```powershell
createuser -h localhost -U postgres --pwprompt metrika
createdb -h localhost -U postgres -O metrika metrika_dev
createdb -h localhost -U postgres -O metrika metrika_test
```

Скопируйте шаблон и откройте его в редакторе:

```powershell
cd C:\Metrika
Copy-Item .env.example .env
notepad .env
```

Минимальный Windows-набор (значения замените на свои):

```ini
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/metrika_dev
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/metrika_test
ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
SESSION_SECRET=<32-байтная-hex-строка>
APP_URL=http://localhost:3000
COOKIE_SECURE=false
BACKUP_KEY_FILE=C:\ProgramData\Metrika\backup.key
BACKUP_DIR=C:\MetrikaBackups
BACKUP_RETENTION_DAYS=7
# В .env переменные %LOCALAPPDATA% не раскрываются: укажите полный путь, который печатает $env:LOCALAPPDATA.
# Не используйте C:\Metrika\tmp: расшифрованный дамп не должен быть доступен другим локальным учётным записям.
RESTORE_TMP_DIR=C:\Users\<профиль>\AppData\Local\Temp\Metrika
PG_DUMP=C:\Program Files\PostgreSQL\18\bin\pg_dump.exe
PG_RESTORE=C:\Program Files\PostgreSQL\18\bin\pg_restore.exe
```

В `.env.example` блок `BACKUP_*` закомментирован: раскомментируйте нужные строки. Путь с пробелами задаётся без
кавычек — значение читает Node, а не PowerShell. Если пароль содержит `@`, `:`, `/` или `?`, percent-encode его
в URL (см. §4); проще выбрать пароль из букв, цифр, `-` и `_`.

`SESSION_SECRET` генерируется один раз и копируется в `.env`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Для локальной демонстрации оставьте `NODE_ENV=development` и `COOKIE_SECURE=false`. Для стенда, открытого по
HTTPS, обязательны `NODE_ENV=production`, `COOKIE_SECURE=true` и `APP_URL=https://…` (§6).

### 5.4. Установка, миграции и запуск

```powershell
cd C:\Metrika
npm ci
npm run db:setup
npm run migrate
npm run seed
npm run build
npm start
```

`npm run db:setup` идемпотентен. Если он отвечает `permission denied to create database`, роль из
`ADMIN_DATABASE_URL` не имеет `CREATEDB`: создайте базы вручную (см. §5.3) и повторите с `npm run migrate`.
`npm start` требует готового `public/assets`: без `npm run build` production-режим остановится с подсказкой.
Для разработки вместо пары `build` + `start` можно запустить `npm run dev`.

Проверка в другом окне PowerShell:

```powershell
Invoke-RestMethod http://localhost:3000/health
# status  db  version
# ------  --  -------
# ok      up  1.0.0
Start-Process http://localhost:3000/login
```

Войдите как `admin@metrika.by` / `Metrika2026!` и откройте дашборд. На системном стенде с реальными данными
сразу смените пароли и `SESSION_SECRET`.

### 5.5. Docker Desktop как альтернатива

Docker Desktop для Windows 10 требует WSL2. После установки и перезапуска проверьте, что доступен Compose v2:

```powershell
docker compose version
cd C:\Metrika
docker compose up --build -d
docker compose ps
Invoke-RestMethod http://127.0.0.1:3000/health
```

Compose-путь не требует `.env`: логин, пароль БД и секрет сессии создаются внутри контейнера. Для сброса стенда
используйте `docker compose down -v` (удаляет БД, секрет, бэкапы и ключ в `app_data`). **Сначала создайте ключ по
§7.5** — без него `backup.js` завершится ошибкой `BACKUP_KEY_FILE`. Перед `down -v` скопируйте ключ на хост:
`docker compose cp app:/app/data/backup.key .\backup.key.offline` (§7.6). После этого бэкап запускается внутри
контейнера:

```powershell
docker compose exec -T app node scripts/backup.js
docker compose cp app:/backup/<file>.dump.enc .
```

Docker Desktop в этом репозитории не запускался; это альтернативная инструкция для прогона владельцем. Если
Docker Desktop не установлен, native-путь выше полностью самодостаточен.

### 5.6. Ключ бэкапа и ACL

Ключ создаётся один раз, в PowerShell 5.1. `CreateNew` отказывается перезаписывать существующий файл: новый ключ
сделал бы все прежние бэкапы нечитаемыми, поэтому ошибка «файл уже существует» — это защита, а не помеха.

```powershell
New-Item -ItemType Directory -Force 'C:\ProgramData\Metrika' | Out-Null
$path = 'C:\ProgramData\Metrika\backup.key'
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$hex = -join ($bytes | ForEach-Object { $_.ToString('x2') })
$stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
  $out = [Text.Encoding]::ASCII.GetBytes($hex)
  $stream.Write($out, 0, $out.Length)
} finally {
  $stream.Dispose()
}
```

Если файл уже есть, команда падает с `The file already exists` — это ожидаемо. Не удаляйте ключ ради повторного
запуска: сначала заархивируйте его вместе с бэкапами (§7.6).

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

### 5.7. Задача Планировщика

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
требует пароля и всегда работает без входа пользователя. В задаче должен быть тот же `BACKUP_KEY_FILE`, что и в
`.env`: не передавайте ключ аргументом.

### 5.8. Проверка после прогона

1. В Планировщике: «Последний результат» (`Last Run Result`) = `0x0`.
2. В `C:\MetrikaBackups` появился `metrika-YYYY-MM-DDTHH-mm-ssZ.dump.enc`, размер больше нуля.
3. Файл расшифровывается и восстанавливается в отдельную базу:

```powershell
cd C:\Metrika
node scripts\restore.js --file C:\MetrikaBackups\<file>.dump.enc `
  --database metrika_restore_check --create --verify
```

4. `--verify` печатает «row-count + key checksum: совпадает». Scratch-базу после проверки удалите:
`dropdb -h localhost -U postgres metrika_restore_check`.
5. Повторно проверьте `/health` и вход после восстановления. Копия, которая ни разу не восстанавливалась, не
   считается проверенной.

Копирование бэкапа на другой диск/в сетевое хранилище — только `Copy-Item` или `robocopy`:

```powershell
Copy-Item 'C:\MetrikaBackups\metrika-*.dump.enc' 'D:\Backups\Metrika\' -Force
robocopy 'C:\MetrikaBackups' '\\nas\backups\Metrika' *.dump.enc /COPY:DAT /R:2 /W:5
```

Нельзя использовать `>` и `Out-File`: PowerShell перекодирует поток и испортит бинарный файл. Скрипты сами не
используют shell-редиректы и текстовые режимы, поэтому `spawn` с массивом аргументов работает одинаково на
Windows и Linux.

## 6. TLS и reverse proxy

Публичный стенд обязан работать только по HTTPS. Приложение само TLS не завершает: оно слушает loopback (или
внутреннюю сеть Docker), а сертификат и HTTP→HTTPS редирект обеспечивает reverse proxy. Production с
`COOKIE_SECURE=false` не стартует (кроме явного loopback-демо с `DEMO_INSECURE_COOKIES=true`), поэтому забыть
флаг на публичном стенде нельзя.

Обязательные значения для публичного стенда:

```dotenv
NODE_ENV=production
APP_URL=https://metrika.example.by
COOKIE_SECURE=true
DEMO_INSECURE_COOKIES=false
TRUST_PROXY=1
```

`TRUST_PROXY=1` означает ровно один прокси-хоп перед приложением. Если цепочка длиннее (CDN → nginx → app),
укажите число хопов или доверенные подсети (`TRUST_PROXY=loopback, 10.0.0.0/8`). `TRUST_PROXY=true` доверяет
всему `X-Forwarded-For` и допустим только когда приложение недоступно напрямую. При `false` подделанный заголовок
не влияет ни на `req.ip`, ни на ключ лимитера, ни на `audit_log.ip` — это безопасный дефолт, но за прокси он
запишет в аудит адрес прокси.

Проверка после настройки (замените домен):

```bash
curl -sSI https://metrika.example.by/login | grep -Ei 'strict-transport|content-security|permissions-policy|referrer-policy'
curl -sSI http://metrika.example.by/login | head -1     # ожидается 301/308 на https
curl -sS https://metrika.example.by/health              # {"status":"ok","db":"up",…}
```

`Strict-Transport-Security` появляется только при `COOKIE_SECURE=true`. Если его нет на HTTPS-стенде — проверьте
`COOKIE_SECURE` и перезапуск контейнера.

### 6.1. Caddy

Caddy сам получает и продлевает сертификат Let's Encrypt. Пример `Caddyfile`:

```caddyfile
metrika.example.by {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-For {remote_host}
    }
}
```

HTTP→HTTPS редирект Caddy делает автоматически. Приложение публикуется только на loopback
(`APP_PORT=3000`, привязка `127.0.0.1:3000` в `docker-compose.yml`); порт 3000 не открывается наружу. После
изменения DNS и запуска проверьте оба `curl` выше и отсутствие в логах Caddy ошибок ACME.

### 6.2. nginx

Сертификат выпускается отдельно (certbot или корпоративный CA). Минимальный server-блок:

```nginx
server {
    listen 80;
    server_name metrika.example.by;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name metrika.example.by;

    ssl_certificate     /etc/letsencrypt/live/metrika.example.by/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/metrika.example.by/privkey.pem;

    client_max_body_size 3m;   # CSV 2 MB + multipart overhead
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
    }
}
```

`client_max_body_size` должен быть не меньше лимита импорта (2 MB) плюс запас на multipart; иначе nginx ответит
413 раньше, чем приложение проверит файл. HSTS приложение отправляет само, дублировать его в nginx не нужно:
два заголовка с разными `max-age` дают непредсказуемый результат.

После настройки:

```bash
curl -sSI https://metrika.example.by/app/dashboard | grep -Ei 'x-robots-tag|cache-control'
```

Ожидается `noindex, nofollow` и `no-store`: приватные страницы не должны попадать в кэш прокси или поисковик.
Публичный стенд без HTTPS — ошибка развёртывания, даже если приложение технически отвечает по HTTP на loopback.

### 6.3. Политика кэширования

Приложение уже отправляет правильные заголовки; задача эксплуатации — не переопределить их на прокси.

| Путь | Ожидаемый `Cache-Control` | Что это значит |
|---|---|---|
| `/assets/*` | `public, max-age=31536000, immutable` | хешированные острова; имя меняется вместе с содержимым |
| `/css/app.css`, `/fonts/*`, `/img/*` | `public, max-age=0` + `ETag` | имя не хешировано, браузер ревалидирует и получает 304 |
| `/` и `/login` (HTML) | без долгого TTL | документ называет текущий хеш бандла |
| `/app/*` | `no-store`, `X-Robots-Tag: noindex, nofollow` | приватные данные и сессия |
| `/api/*` | `no-store`, `X-Robots-Tag: noindex, nofollow` | ответ зависит от пользователя |
| `/health` | `no-store` | состояние стенда нельзя кэшировать |

Не добавляйте в Caddy/nginx `expires`, `immutable` или `proxy_cache` для HTML: после деплоя страница со старым
хешем сошлётся на удалённый файл. Не переопределяйте `no-store` на `/app` и `/api`. Проверка:

```bash
curl -sSI https://metrika.example.by/assets/<hashed>.js | grep -i cache-control
curl -sSI https://metrika.example.by/css/app.css | grep -i cache-control
curl -sSI https://metrika.example.by/app/dashboard | grep -Ei 'cache-control|x-robots-tag'
```

Регрессионный тест политики — `tests/integration/cache-headers.test.js`; он не зависит от локальной сборки.

## 7. Резервное копирование и восстановление

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

На POSIX скрипт **отказывается** читать файл ключа, доступный группе или остальным (режим шире `0600`): это
защищает от случайного ключа, созданного с umask `022`. Осознанное исключение — явный флаг
`--allow-loose-key`, который печатает предупреждение и продолжает. На Windows POSIX-биты не имеют смысла,
поэтому проверка не блокирует запуск: скрипт предупреждает, что ACL нужно проверить через `icacls`
(docs/deployment.md §5.6).

Linux/macOS, один раз. Сначала создайте ключ, затем укажите его в `.env`:

```bash
install -d -m 700 backups
node -e "require('node:fs').writeFileSync('backups/backup.key', require('node:crypto').randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' })"
chmod 600 backups/backup.key
```

`flag: 'wx'` отказывается перезаписывать существующий файл (`EEXIST`): новый ключ сделал бы все прежние бэкапы
нечитаемыми. Если команда упала с `EEXIST`, ничего не удаляйте — сначала заархивируйте ключ вместе с бэкапами
(§7.6).

```dotenv
BACKUP_KEY_FILE=./backups/backup.key
```

Без этой строки `npm run backup` не найдёт ключ и завершится ошибкой; переменную можно экспортировать в
оболочке вместо `.env`, но для Планировщика и повторных запусков надёжнее файл. `backups/` и `*.dump.enc` уже в
`.gitignore`. Windows — §5.6. Один и тот же ключ нужен для восстановления: без него файл не расшифровать,
восстановление невозможно.

### 7.2. Создание копии

```bash
npm run backup
npm run backup -- --keep 14
npm run backup -- --out ./backups/manual.dump.enc
npm run backup -- --allow-loose-key
```

- `BACKUP_DIR` (по умолчанию `./backups`) — каталог; имя `metrika-YYYY-MM-DDTHH-mm-ssZ.dump.enc` в UTC.
- `BACKUP_RETENTION_DAYS` (по умолчанию `7`) — возраст, после которого старые файлы удаляются. Удаляются только
  `metrika-*.dump.enc`; `README.txt`, ручные копии и `--out` не затрагиваются. Минимум один бэкап остаётся всегда.
- `--keep N` — сохранить как минимум N самых новых файлов независимо от возраста.
- `--out PATH` — записать в конкретный файл и не применять retention (удобно для ручной копии).
- `--allow-loose-key` — разрешить файл ключа с правами шире `0600` (POSIX), с предупреждением.
- `PG_DUMP` переопределяет бинарь; `pg_dump` вызывается без shell, массивом аргументов.

Перед дампом сравниваются мажорные версии. `pg_dump` старше сервера → запуск отменяется: данные новее формата.
`pg_dump` новее сервера → предупреждение и продолжение. Фактические версии печатаются в лог. Пароль из
`DATABASE_URL` не передаётся в аргументах: URL для `argv` очищается, а сам пароль попадает в окружение дочернего
процесса через `PGPASSWORD`. Поэтому argv процессов (`ps` без `e`, Task Manager) секрет не показывает; `PGPASSWORD`
остаётся в окружении, как любой секрет в env. Сообщения и `stderr` дополнительно редактируются на `***`. Дочерний
процесс также не наследует `DATABASE_URL`, `TEST_DATABASE_URL`, `ADMIN_DATABASE_URL`, `BACKUP_KEY` и
`SESSION_SECRET`. То же правило действует для `pg_restore` и для административного подключения `--create`.

Код выхода `0` — файл создан; `1` — понятное сообщение об ошибке и никакого нового файла. Временный `.staged`
удаляется, существующий `--out` не перезаписывается частичным дампом.

### 7.3. Восстановление и проверка

```bash
npm run restore -- --file ./backups/<file>.dump.enc
npm run restore -- --file ./backups/<file>.dump.enc --database metrika_restore_check --create --verify
```

- `--database` валидируется `/^[a-z][a-z0-9_]*$/` и цитируется через `escapeIdentifier` **до** любого подключения;
  `bad;drop`, `Bad-Name` и другие имена отвергаются.
- `--allow-loose-key` разрешает файл ключа с правами шире `0600` (POSIX) с предупреждением; без флага такой файл
  отвергается до расшифровки.
- Без `--force` скрипт отказывается писать в базу, совпадающую с `DATABASE_URL`: `pg_restore --clean` удаляет
  объекты. `--force` — только осознанное восстановление поверх рабочей БД. Если одновременно указан `--verify`,
  источник и цель совпадают, поэтому проверка сравнивает живую базу с самой собой и всегда зелёная; скрипт
  печатает об этом предупреждение. Для доказательной проверки восстанавливайте в отдельную базу.
- `--create` создаёт scratch-базу через `ADMIN_DATABASE_URL` (по умолчанию
  `postgres://postgres:postgres@localhost:5432/postgres`); роль обязана иметь `CREATEDB`. Существующая база
  переиспользуется, но не пересоздаётся. База создаётся от роли `ADMIN_DATABASE_URL`, а восстанавливает её роль из
  `DATABASE_URL`; если это разные роли, роль восстановления должна владеть базой или иметь `CREATE` на схеме
  `public` — иначе `pg_restore --clean` не сможет удалить и создать схему. В дефолтном демо обе роли совпадают.
- Дамп расшифровывается во временный файл `0600` в `RESTORE_TMP_DIR` (по умолчанию `os.tmpdir()`), затем
  `pg_restore --clean --if-exists --no-owner --no-acl`, затем временный каталог удаляется в `finally` даже при
  ошибке. Каталоги `metrika-restore-*` старше 24 часов, оставшиеся после kill/power loss, удаляются при старте;
  активный concurrent-restore моложе порога не затрагивается.
- **Если удалить временный каталог не удалось, команда завершается кодом `1`,** а не предупреждением: в каталоге
  лежит расшифрованный дамп, который читается без ключа. Скрипт делает одну повторную попытку (антивирус или
  индексатор могут держать файл), затем печатает путь и требует удалить его вручную.
- **Windows: `RESTORE_TMP_DIR` — только каталог в профиле пользователя.** Путь `C:\Metrika\tmp` наследует ACL
  корня репозитория и может быть доступен другим локальным учётным записям; plaintext-дамп это не допускает.
  Укажите полный путь (`$env:LOCALAPPDATA\Temp\Metrika`, в `.env` — без `%…%`, они не раскрываются) и ограничьте
  ACL:

  ```powershell
  New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Temp\Metrika" | Out-Null
  icacls "$env:LOCALAPPDATA\Temp\Metrika" /inheritance:r
  icacls "$env:LOCALAPPDATA\Temp\Metrika" /grant:r "$env:USERNAME:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'
  ```

  Каталог `%LOCALAPPDATA%\Temp` уже привязан к профилю, но явный `/inheritance:r` закрывает доступ `Users`, если
  профиль когда-либо получил широкое наследование. `os.tmpdir()` на Windows обычно указывает сюда же — это
  безопасный дефолт; переопределяйте его только на путь с таким же ACL.
- `--verify` сравнивает **row-count + key checksum**: `count(*)` и
  `md5(string_agg(id::text, ',' ORDER BY id))` по `users`, `channels`, `campaigns`, `customers`, `orders`,
  `daily_stats`, `audit_log`. Печатается таблица, при любом расхождении код выхода `1`. Это не побайтовое и не
  полное логическое сравнение БД; формулировка «row-count + key checksum» и есть граница проверки.
- Источник для `--verify` — `DATABASE_URL`. Запускайте проверку сразу после создания копии: если рабочая БД
  изменилась между дампом и проверкой, расхождение ожидаемо.
- Повреждённый файл (подменённый байт, битый тег, неверный ключ) завершается кодом `1` на этапе расшифровки;
  `pg_restore` не запускается, scratch-база не создаётся.

### 7.4. Runbook оператора

| Когда | Что сделать | Проверка |
|---|---|---|
| Ежедневно, 02:30 | `npm run backup` по расписанию (Linux cron/systemd или Планировщик Windows, §5.7) | код выхода `0`, новый `metrika-*.dump.enc` ненулевого размера |
| Ежедневно после копии | скопировать `*.dump.enc` на другой диск/в хранилище (`rsync`, `Copy-Item`, `robocopy`) | файл на приёмнике совпадает по размеру и контрольной сумме |
| Еженедельно | проверить, что retention не удалил последнюю копию и свободного места хватает | минимум один файл, дата свежая |
| Ежемесячно | восстановить последнюю копию в scratch-базу с `--verify` | «row-count + key checksum: совпадает» |
| Перед обновлением | сделать ручную копию `npm run backup -- --out ./backups/before-update.dump.enc` | файл `before-update.dump.enc` существует |
| При инциденте | остановить приложение, сохранить текущую БД, восстановить копию, запустить приложение | `/health` = 200, вход работает, контрольные суммы совпали |

Ключ `BACKUP_KEY_FILE` хранится отдельно от каталога с дампами и резервируется своей процедурой. Без ключа
зашифрованные файлы бесполезны: `restore.js` не сможет их расшифровать. Не храните ключ рядом с копиями на том же
диске.

Восстановление поверх рабочей БД — только осознанная операция:

```bash
# 1. Остановить приложение, чтобы никто не писал в БД во время restore.
# 2. Сделать аварийную копию текущего состояния.
npm run backup -- --out ./backups/before-restore.dump.enc
# 3. Восстановить выбранную копию в рабочую базу. Имя базы возьмите из DATABASE_URL:
#    без --database скрипт по умолчанию пишет в metrika_restore_check, а не в рабочую базу.
#    --force обязателен: без него скрипт откажется писать в базу из DATABASE_URL.
npm run restore -- --file ./backups/<file>.dump.enc --database <имя_базы_из_DATABASE_URL> --force
# 4. Запустить приложение и проверить /health и вход.
```

`--force` вместе с `--verify` сравнивает живую базу с самой собой и всегда зелёный; для доказательной проверки
восстанавливайте в отдельную базу, как в §7.3. Для публичного стенда сначала снимите трафик с reverse proxy,
затем останавливайте приложение.

### 7.5. Docker/Compose

В Compose уже заданы `BACKUP_KEY_FILE=/app/data/backup.key`, `BACKUP_DIR=/backup`,
`RESTORE_TMP_DIR=/app/data/tmp`; `BACKUP_KEY` в окружении отсутствует. Сначала ключ, потом бэкап: без файла ключа
`scripts/backup.js` откажется работать. Ключ создаётся один раз внутри контейнера, в томе `app_data` (не в образе),
с `flag: 'wx'`, чтобы не перезаписать существующий:

```bash
docker compose exec -T app node -e "require('node:fs').writeFileSync('/app/data/backup.key', require('node:crypto').randomBytes(32).toString('hex')+'\n', {mode:0o600, flag:'wx'})"
docker compose exec -T app stat -c '%a %n' /app/data/backup.key   # 600
docker compose cp app:/app/data/backup.key ./backup.key.offline   # копия вне тома, для down -v
chmod 600 ./backup.key.offline
docker compose exec -T app node scripts/backup.js
docker compose exec -T app ls -l /backup
docker compose cp app:/backup/<file>.dump.enc .
```

Повторный запуск `wx` падает с `EEXIST` — это защита: ключ, перезаписанный ради «чистого» запуска, делает все
прежние `*.dump.enc` нечитаемыми. `app_data` удаляется командой `down -v`, поэтому `backup.key.offline` на хосте —
не резервная копия «на всякий случай», а обязательная часть архива. Ротация и архив — §7.6.

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

### 7.6. Ротация и архив ключа

Ключ шифрует бэкапы, а не базу: **старые копии остаются зашифрованы старым ключом**, поэтому ротация — это новый
ключ для новых копий плюс архив старого ключа рядом с теми копиями, которые он открывает.

1. **Архив перед ротацией.** Скопируйте текущий ключ под именем с датой и закройте права; положите его в отдельное
   защищённое хранилище, доступное независимо от каталога бэкапов (не в репозиторий, не в `.env`, не в Compose):

   ```bash
   # native
   cp -p backups/backup.key "backups/backup.key.$(date -u +%Y%m%d)"
   chmod 600 "backups/backup.key.$(date -u +%Y%m%d)"
   # Docker: ключ живёт в app_data, поэтому сначала на хост
   docker compose cp app:/app/data/backup.key "./backup.key.$(date -u +%Y%m%d).offline"
   chmod 600 "./backup.key.$(date -u +%Y%m%d).offline"
   ```

2. **Новый ключ.** Уберите текущий файл из рабочего места (`mv backups/backup.key …` для native; для Docker —
   скопируйте его на хост и удалите внутри контейнера `rm /app/data/backup.key`), затем создайте ключ заново по
   §7.1 или §7.5. `flag: 'wx'` не даст перезаписать файл, если предыдущий шаг забыт.

3. **Проверка.** Сделайте новую копию и восстановите её в scratch-базу (`restore --create --verify`). Отдельно
   проверьте, что архивная копия со старым ключом всё ещё открывается: `BACKUP_KEY_FILE=<архив> npm run restore --
   --file <старый>.dump.enc --database metrika_restore_check --create --verify`.

4. **Что нельзя делать.** Держать единственную копию ключа только в `app_data` (`down -v` её удалит); хранить ключ
   в репозитории, `.env` или аргументах командной строки; «пересоздавать» ключ поверх существующего; удалять старый
   ключ, пока существуют зашифрованные им копии. Ротация не перешифровывает старые дампы — это осознанно: иначе
   понадобился бы доступ ко всем ключам сразу.

5. **Когда ротировать.** При подозрении на утечку ключа, при смене ответственного за стенд и при переезде на другой
   хост. Для демо-стенда достаточно одного ключа на весь срок; ротация — часть эксплуатации, а не проверка M6.

## 8. Обновление стенда

Миграции `001`–`006` применяются по порядку и идемпотентно. Перед обновлением всегда есть свежая копия: схема
меняется только вперёд, автоматического отката миграций нет.

### 8.1. Native Linux

```bash
npm run backup -- --out ./backups/before-update.dump.enc
git pull
npm ci
npm run migrate
npm run build
# перезапустите процесс, которым запущен сервер (systemd, pm2 или терминал с npm start)
curl -fsS http://localhost:3000/health
```

Если обновление ломает приложение, откатите код (`git checkout <предыдущий-коммит>`, `npm ci`, `npm run build`) и
восстановите копию, снятую до обновления. Откат только кода без отката схемы допустим, пока миграции совместимы;
при сомнении восстанавливайте БД целиком.

### 8.2. Docker/Compose

```bash
docker compose exec -T app node scripts/backup.js
git pull
docker compose build --pull
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3000/health
docker compose logs app --tail=100
```

Entrypoint применит новые миграции до старта приложения. `docker compose down` без `-v` сохраняет тома; `down -v`
удаляет БД, секрет сессии, бэкапы и ключ в `app_data` и для обновления не используется. Если после `up` контейнер `unhealthy`,
смотрите §10 и не удаляйте volume: данные всё ещё на месте.

## 9. Восстановление демонстрационной базы

Демо-набор детерминирован: 8 каналов, 32 кампании, 4 000 клиентов, 14 месяцев статистики, 3 пользователя.
`seed` создаёт его заново с нуля. Отчётная дата — вчерашний день по Минску, поэтому «та же база» означает тот же
состав и объём, а не те же календарные даты. Если нужен исходный снимок с конкретной датой, используйте
шифрованный бэкап (§7.3), а не сид.

Перед любым вариантом остановите приложение: сид очищает таблицы, включая сессии, и активные входы станут
недействительны.

### 9.1. Docker: полный сброс

```bash
docker compose down -v
docker compose up --build
```

`down -v` удаляет базу, ключ и бэкапы в томах. Перед сбросом скопируйте ключ, если старые архивы ещё нужны
(§2.4). После `up` контейнер применит миграции и заполнит пустую базу автоматически. Проверьте `/health` и вход
`admin@metrika.by` / `Metrika2026!`.

### 9.2. Native: восстановить только данные

```bash
npm run seed
npm start
```

Сид очищает `users`, `sessions`, `channels`, `campaigns`, `daily_stats`, `customers`, `touchpoints`, `orders`,
`goals`, `alerts`, `scenarios`, `audit_log`, `import_batches`, `media_assets` и заполняет их заново. Демо-пароль
снова становится `Metrika2026!`; реальные пользователи, аудит, сценарии и импортированные данные пропадут.
Схема и миграции не затрагиваются.

### 9.3. Native: полная пересборка схемы

Если схема повреждена или миграции применялись вручную:

```bash
psql "$DATABASE_URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
npm run migrate
npm run seed
npm start
```

Роль должна владеть базой. На Windows выполните те же шаги через `psql.exe`, подставив строку подключения из
`.env`. Альтернатива — удалить и создать базу через `dropdb`/`createdb`, затем `npm run db:setup`, `npm run migrate`,
`npm run seed`.

### 9.4. Из шифрованного бэкапа

Если нужен именно сохранённый снимок, а не новый демо-набор:

```bash
npm run restore -- --file backups/<файл>.dump.enc --database metrika_restore_check --create --verify
```

Сначала восстановите в scratch-базу и проверьте отчёт. Замена рабочей базы — только осознанно:
`--database metrika_dev --force` (см. §7.3). Бэкап должен быть снят с совместимой схемой; после отката кода
миграции могут отличаться.

## 10. Диагностика

Сначала проверьте факты, а не догадки:

```bash
docker compose ps
docker compose logs app --tail=100
docker inspect --format '{{.State.Health.Status}}' metrika-app-1
curl -i http://127.0.0.1:3000/health
docker compose exec app id -u      # 1000, не 0
```

| Симптом | Вероятная причина | Действие |
|---|---|---|
| `docker: unknown command: docker compose` | не установлен плагин Compose v2 | установить pinned-релиз по §2.1, проверить `docker compose version` |
| `port is already allocated` / `EADDRINUSE` | порт 3000 занят другим стендом | остановить старый контейнер или задать `APP_PORT`/`PORT` и `APP_URL` |
| `/health` = `503`, контейнер `unhealthy` | PostgreSQL недоступен или перезапускается | `docker compose ps`, `docker compose logs db`, дождаться `healthy`; не считать это падением Node |
| `permission denied to create database` | у роли из `ADMIN_DATABASE_URL` нет `CREATEDB` | выдать право или создать базы вручную через `createdb` |
| `password authentication failed` | неверный пароль, URL или `pg_hba.conf` | проверить `psql "$DATABASE_URL"`, percent-encoding пароля, роль и `pg_hba.conf` |
| `TEST_DATABASE_URL is not set` | не заполнен `.env` или тестовая база | скопировать `.env.example`, создать `metrika_test` |
| Миграции «уже применены», таблиц нет | `DATABASE_URL` указывает не на ту базу | проверить имя БД и `schema_migrations`, не запускать `seed` вслепую |
| `Asset manifest not found` | `npm start` без `npm run build` | выполнить `npm run build` или запускать `npm run dev` |
| `SESSION_SECRET must be at least 32 characters` | плейсхолдер или короткая строка | сгенерировать 32 байта и перезапустить |
| `COOKIE_SECURE must be true in production` | production без HTTPS | включить HTTPS/reverse proxy и `COOKIE_SECURE=true`; демо-исключение только для loopback |
| Бэкап: `файл ключа доступен группе` | права шире `0600` на POSIX | `chmod 600`, либо осознанно `--allow-loose-key` |
| Бэкап: `pg_dump` старше сервера | клиент PostgreSQL ниже 18 | указать `PG_DUMP` от PostgreSQL 18 или обновить клиент |
| Restore: `отказывается писать в DATABASE_URL` | защита от затирания рабочей БД | восстановить в scratch-базу; `--force` только по runbook §7.4 |
| Windows: `psql`/`pg_dump` не найден | каталог `bin` не в `PATH` | добавить `C:\Program Files\PostgreSQL\18\bin` или задать `PG_DUMP`/`PG_RESTORE` |
| Windows: задача Планировщика `0x1` | неверный рабочий каталог, `.env` или ключ | запустить `node scripts\backup.js` вручную из корня репозитория и прочитать stderr |
| Импорт: `413` / `Файл превышает 2 МБ` | сработал лимит загрузки | уменьшить файл или разбить его; лимит не поднимать без пересмотра безопасности |
| Импорт: `400` про MIME/расширение | загружен не CSV | сохранить файл как `.csv` в UTF-8 и повторить |
| Страница 500 | отказ БД или ошибка шаблона | посмотреть `requestId` в логе и `docker compose logs app`; не показывать stack пользователю |

Для native-стенда те же проверки выполняются без Docker: `psql "$DATABASE_URL" -c 'select 1'`,
`curl -i http://localhost:3000/health`, `npm run migrate`, проверка `SESSION_SECRET`.

## 11. Что проверяет владелец (не проверено здесь)

Следующие пункты агент не выполнял: в окружении не было Windows 10, Docker Desktop, публичного HTTPS-стенда и
Firefox. Они не считаются закрытыми, пока владелец не прогонит сценарий и не допишет результат в
`docs/screenshots/m6/README.md`.

- **Windows 10, native:** установка Node 24 и PostgreSQL 18, `npm ci`, `db:setup`, `migrate`, `seed`, `build`,
  `start`, вход, импорт, `/health`, ключ бэкапа и ACL, Планировщик (`0x0`), restore в scratch-базу.
- **Docker Desktop:** `docker compose version`, `up --build -d`, `ps`, `/health`, вход, `down`/`down -v`.
- **TLS/публичный HTTPS:** Caddy или nginx, `COOKIE_SECURE=true`, HSTS, редирект HTTP→HTTPS, `X-Robots-Tag` на
  `/app`.
- **Firefox/Opera/Yandex:** smoke-сценарий входа, дашборда, каналов, атрибуции, сценариев и импорта; Chromium
  уже покрыт E2E-матрицей M6.
- **Восстановление на Windows:** расшифровка копии, `pg_restore`, `--verify`, удаление scratch-базы.

Пока эти пункты не отмечены владельцем, README и журнал доказательств должны прямо говорить «не проверено здесь»,
а не «работает везде».
