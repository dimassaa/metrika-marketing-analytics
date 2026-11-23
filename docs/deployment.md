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
chmod +x ~/.docker/cli-plugins/docker-compose
docker compose version
```

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
| `SESSION_SECRET` | — | минимум 32 символа; в контейнере генерируется в файл |
| `APP_URL` | — | абсолютный URL; для демо — `http://localhost:3000` |
| `COOKIE_SECURE` | `false` | только `true`/`false`; в production обязан быть `true`, кроме демо-исключения |
| `DEMO_INSECURE_COOKIES` | `false` | демо-исключение: принимается только с loopback `APP_URL` |
| `AUTO_SEED_DEMO` | `false` | entrypoint проверяет пустоту трёх таблиц и сеет демо |
| `RUN_MIGRATIONS` | `false` в `env.js`, `true` в entrypoint | `false` отключает миграции при старте |
| `TRUST_PROXY` | `false` | число хопов, список подсетей или `false`; формат не булев |
| `LOG_LEVEL` | `info` | `pino` |
| `SESSION_SECRET_FILE` | `/app/data/session-secret` | файл секрета в контейнере |
| `BACKUP_KEY_FILE` | — | файл 32-байтного ключа бэкапа (Task 2) |
| `BACKUP_DIR` | — | каталог зашифрованных дампов; в Compose `/backup` |
| `RESTORE_TMP_DIR` | — | временные файлы восстановления; в Compose `/app/data/tmp` |

Булевы переменные принимают **только** `true` и `false`. Значения `0`, `1`, `yes` отклоняются на старте с русским
сообщением: entrypoint и `env.js` не должны расходиться в трактовке одного и того же значения.

Production-guard: при `NODE_ENV=production` и `COOKIE_SECURE=false` приложение стартует только если одновременно
`DEMO_INSECURE_COOKIES=true` и hostname `APP_URL` точно равен `localhost`, `127.0.0.1` или `[::1]`.
`localhost.evil.com`, `127.0.0.1.evil.com` и `[::1].evil.com` отклоняются. С `COOKIE_SECURE=true` флаг игнорируется.

## 5. Windows 10

Заглушка. Раздел будет описывать установку Node 24 и PostgreSQL 18, PowerShell-эквиваленты команд, планировщик
заданий для бэкапов и альтернативу Docker Desktop. Прогон на Windows выполняет владелец; агентский Linux-прогон
его не заменяет.

## 6. TLS и reverse proxy

Заглушка. Публичный стенд обязан работать по HTTPS: reverse proxy (Caddy/nginx) завершает TLS, приложение слушает
loopback, `COOKIE_SECURE=true`, `DEMO_INSECURE_COOKIES=false`, `TRUST_PROXY` соответствует числу прокси. Раздел
наполняется вместе с аудитом безопасности.

## 7. Резервные копии

Заглушка. Формат, ключ, retention и проверка восстановления описываются в Task 2: `pg_dump -Fc` → AES-256-GCM,
ключ только в файле `BACKUP_KEY_FILE` (никогда в переменной окружения), восстановление — в scratch-БД с проверкой.
До готовности этого раздела бэкапы не считать настроенными.

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
