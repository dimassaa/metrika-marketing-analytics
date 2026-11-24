# Аудит безопасности «Метрики»

Состояние на 24.11.2026, M6 Task 3. Документ описывает фактическую реализацию, а не намерения: каждая строка
таблицы маршрутов сверена с кодом `src/routes/*.js` и с тестами. Расхождения и остаточные риски перечислены в
конце; они не скрыты за формулировкой «будет сделано».

Проверки этого этапа:

- `tests/integration/security-headers.test.js` — набор заголовков, CSP, HSTS, `X-Robots-Tag`, cache-control.
- `tests/integration/route-audit.test.js` — обход `app.router.stack`, CSRF и guard на каждом маршруте.
- `tests/integration/auth.test.js` — лимиты входа, в том числе 30 попыток с одного адреса и успешный вход.
- `tests/unit/slow-query.test.js` — наблюдатель медленных запросов.

## 1. Маршруты, guard, CSRF и аудит

Сокращения: **В** — viewer, **А** — analyst, **Ад** — admin. `requireAuth` означает «любой вошедший пользователь».
CSRF-токен обязателен для всех методов, кроме `GET`, `HEAD`, `OPTIONS`; проверка выполняется глобальным
`csrfProtection` до входа в любой роутер, поэтому в таблице у мутаций стоит «да».

| Метод | Маршрут | Guard | CSRF | Действие в `audit_log` | Тест |
|---|---|---|---|---|---|
| GET | `/` | публичный | — | — | `landing.test.js` |
| GET | `/robots.txt` | публичный | — | — | `landing.test.js` |
| GET | `/sitemap.xml` | публичный | — | — | `landing.test.js` |
| GET | `/media/slug/:slug` | публичный | — | — | `media.test.js` |
| GET | `/media/:id` | публичный | — | — | `media.test.js` |
| GET | `/login` | публичный | — | — | `auth.test.js` |
| POST | `/login` | публичный + два лимитера | да | `auth.login` | `auth.test.js` |
| POST | `/logout` | публичный (сессия) | да | `auth.logout` | `auth.test.js` |
| GET | `/health` | публичный | — | — | `health.test.js` |
| GET | `/app` | `requireAuth` | — | — | `rbac.test.js` |
| GET | `/app/dashboard` | `dashboard:view` | — | — | `dashboard-screen.test.js` |
| GET | `/app/cohorts` | `cohorts:view` | — | — | `cohorts-screen.test.js` |
| GET | `/app/attribution` | `attribution:view` | — | — | `attribution-screen.test.js` |
| GET | `/app/channels` | `channels:view` | — | — | `channels-screen.test.js` |
| GET | `/app/channels/:id` | `channels:view` | — | — | `channels-screen.test.js` |
| POST | `/app/channels` | `channels:manage` | да | `channel.create` | `channels.test.js` |
| POST | `/app/channels/:id` | `channels:manage` | да | `channel.update` | `channels.test.js` |
| POST | `/app/channels/:id/archive` | `channels:manage` | да | `channel.archive` / `channel.restore` | `channels.test.js` |
| GET | `/app/campaigns` | `campaigns:view` | — | — | `campaigns.test.js` |
| POST | `/app/campaigns` | `campaigns:manage` | да | `campaign.create` | `campaigns.test.js` |
| POST | `/app/campaigns/:id` | `campaigns:manage` | да | `campaign.update` | `campaigns.test.js` |
| POST | `/app/campaigns/:id/delete` | `campaigns:manage` | да | `campaign.delete` | `campaigns.test.js` |
| GET | `/app/goals` | `goals:view` | — | — | `goals.test.js` |
| POST | `/app/goals` | `goals:manage` | да | `goal.create` | `goals.test.js` |
| POST | `/app/goals/:id` | `goals:manage` | да | `goal.update` | `goals.test.js` |
| POST | `/app/goals/:id/delete` | `goals:manage` | да | `goal.delete` | `goals.test.js` |
| GET | `/app/alerts` | `alerts:view` | — | — | `alerts.test.js` |
| POST | `/app/alerts/recalculate` | `alerts:manage` | да | **нет** — риск R2 | `alerts.test.js` |
| POST | `/app/alerts/:id/dismiss` | `alerts:manage` | да | `alert.dismiss` | `alerts.test.js` |
| GET | `/app/scenarios` | `scenarios:view` | — | — | `scenarios.test.js` |
| GET | `/app/scenarios/:id` | `scenarios:view` | — | — | `scenarios.test.js` |
| POST | `/app/scenarios` | `scenarios:manage` | да | `scenario.create` | `scenarios.test.js` |
| GET | `/app/import` | `import:run` | — | — | `import.test.js` |
| GET | `/app/import/templates/:kind.csv` | `import:run` | — | — | `import.test.js` |
| GET | `/app/import/batches/:id` | `import:run` | — | — | `import.test.js` |
| GET | `/app/export/:dataset.csv` | `export` | — | `export.csv` | `export.test.js` |
| GET | `/app/profile` | `requireAuth` | — | — | `users-admin.test.js` |
| POST | `/app/profile/password` | `requireAuth` (свой пароль) | да | `user.password_change` | `users-admin.test.js` |
| GET | `/app/audit` | `audit:view` | — | — | `users-admin.test.js` |
| GET | `/app/admin/users` | `users:manage` | — | — | `users-admin.test.js` |
| POST | `/app/admin/users` | `users:manage` | да | `user.create` | `users-admin.test.js` |
| POST | `/app/admin/users/:id/role` | `users:manage` | да | `user.role_change` | `users-admin.test.js` |
| POST | `/app/admin/users/:id/toggle-active` | `users:manage` | да | `user.deactivate` / `user.activate` | `users-admin.test.js` |
| POST | `/app/admin/users/:id/reset-password` | `users:manage` | да | `user.password_reset` | `users-admin.test.js` |
| GET | `/api/v1/dashboard` | `dashboard:view` | — | — | `metrics-api.test.js` |
| GET | `/api/v1/channels` | `channels:view` | — | — | `metrics-api.test.js` |
| GET | `/api/v1/channels/:id` | `channels:view` | — | — | `metrics-api.test.js` |
| GET | `/api/v1/cohorts` | `cohorts:view` | — | — | `metrics-api.test.js` |
| GET | `/api/v1/attribution` | `attribution:view` | — | — | `metrics-api.test.js` |
| GET | `/api/v1/ranking` | `channels:view` | — | — | `metrics-api.test.js` |
| GET | `/api/v1/alerts` | `alerts:view` | — | — | `alerts.test.js` |
| POST | `/api/v1/alerts/recalculate` | `alerts:manage` | да | **нет** — риск R2 | `alerts.test.js` |
| POST | `/api/v1/alerts/:id/dismiss` | `alerts:manage` | да | `alert.dismiss` | `rbac.test.js` |
| GET | `/api/v1/scenarios` | `scenarios:view` | — | — | `scenarios.test.js` |
| GET | `/api/v1/scenarios/:id` | `scenarios:view` | — | — | `scenarios.test.js` |
| POST | `/api/v1/scenarios` | `scenarios:manage` | да | `scenario.create` | `scenarios.test.js` |
| POST | `/api/v1/import` | `import:run` + лимитер импорта | да | `import.run` | `import.test.js` |
| POST | `/api/v1/profile/avatar` | `requireAuth` (свой аватар) | да | `media.upload` | `media.test.js` |
| POST | `/api/v1/admin/media/og-cover` | `users:manage` | да | `media.upload` | `media.test.js` |

Маршрут без guard считается ошибкой: `route-audit.test.js` находит 59 пар «метод + путь» и падает, если
мутация осталась без CSRF, а `/app` или `/api` — без `requireAuth`/`requirePermission`. Публичный allowlist
мутаций — ровно `POST /login` и `POST /logout`; оба всё равно требуют CSRF, у `/logout` сессия должна быть
валидной.

## 2. RBAC-матрица

Права аддитивны: analyst наследует viewer, admin наследует analyst. Источник — `src/config/permissions.js`.

| Право | viewer | analyst | admin |
|---|---|---|---|
| `dashboard:view`, `cohorts:view`, `attribution:view` | да | да | да |
| `channels:view`, `campaigns:view`, `goals:view` | да | да | да |
| `alerts:view`, `scenarios:view` | да | да | да |
| `export` | да | да | да |
| `channels:manage`, `campaigns:manage`, `goals:manage` | нет | да | да |
| `alerts:manage`, `scenarios:manage` | нет | да | да |
| `import:run` | нет | да | да |
| `users:manage`, `audit:view` | нет | нет | да |

Проверка выполняется на сервере в каждом маршруте. Скрытие кнопки в шаблоне — только представление: viewer
получает styled 403 на странице и JSON `FORBIDDEN` на API, это закреплено в `rbac.test.js`. Смена роли или
блокировка удаляет строки сессий пользователя (`deleteUserSessions`), поэтому старый cookie перестаёт работать
сразу, а не через 8 часов.

## 3. Сессии и куки

- Хранилище — таблица `sessions` через `connect-pg-simple`; отдельного in-memory хранилища в production нет.
- Cookie `metrika.sid`: `HttpOnly`, `SameSite=Lax`, `Path=/`, TTL 8 часов; `Secure` включается через
  `COOKIE_SECURE=true` (в production это обязательное значение, кроме явного loopback-демо).
- При успешном входе вызывается `req.session.regenerate`: идентификатор до аутентификации не переживает вход
  (защита от session fixation). При выходе сессия уничтожается.
- Анонимный посетитель не получает строку сессии, пока CSRF-слой не выдаст токен; отклонённый POST не создаёт
  сессию.
- CSRF — double-submit: токен в сессии, сравнение с `X-CSRF-Token` или полем `_csrf`. Повторяющееся поле формы
  отклоняется, а не приводится к массиву. Исключений по методу, кроме `GET`/`HEAD`/`OPTIONS`, нет.
- `trust proxy` по умолчанию `false`. `req.ip` принимается только как IP-литерал (`clientIp`); подделанный
  `X-Forwarded-For` не меняет ключ лимитера и не попадает в `audit_log.ip`. За прокси оператор обязан задать
  `TRUST_PROXY=1` (или список подсетей); `true` допустим только когда приложение недоступно напрямую.

## 4. Заголовки и CSP

Набор одинаков для всех ответов, включая статику, редиректы и ошибки:

| Заголовок | Значение / условие |
|---|---|
| `Content-Security-Policy` | явный список; `script-src 'self'` + nonce, без `unsafe-inline` |
| `X-Content-Type-Options` | `nosniff` (helmet) |
| `Referrer-Policy` | `no-referrer` (helmet) |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` — вручную, в helmet 8.3 такой опции нет |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` только при `COOKIE_SECURE=true` |
| `X-Robots-Tag` | `noindex, nofollow` только на `/app` и `/api` |
| `X-Powered-By` | отсутствует (`app.disable`) |
| `Cache-Control` | `/app`, `/api`, `/health` — `no-store`; `/assets` — год и `immutable`; CSS — revalidation |

CSP: `default-src`, `base-uri`, `form-action`, `font-src`, `connect-src` — только `'self'`; `object-src 'none'`;
`frame-ancestors 'none'`; `img-src 'self' data:`; `script-src-attr 'none'`. Единственное вынужденное послабление —
`style-src-attr 'unsafe-inline'`: Recharts пишет inline `style` в SVG, а `style-src` атрибуты не покрывает.
Ослаблять `script-src` ради этого запрещено.

HSTS не отправляется в демо-режиме без HTTPS: обещание `includeSubDomains` на HTTP-стенде вводит браузер в
заблуждение. Публичный стенд без TLS считается ошибкой развёртывания (см. `docs/deployment.md` §6).

## 5. Лимитеры и размеры

| Что | Ключ | Лимит |
|---|---|---|
| Вход, пара | `IP + нормализованный e-mail` | 5 неудач / 15 мин |
| Вход, адрес | IP-литерал или socket-адрес | 30 неудач / 15 мин |
| Импорт | `session.user.id` (fallback — адрес) | 20 файлов / 15 мин |
| Тело JSON/формы | — | 100 KB |
| CSV-загрузка | — | 2 MB, расширение и MIME проверяются |
| Изображение | — | 1 MB, поле и MIME проверяются |

Успешный вход не расходует квоту (`skipSuccessfulRequests`). Оба логин-лимитера создаются на экземпляр
приложения, а не как модульные singleton'ы: интеграционные тесты изолированы, а production-процесс имеет один
набор счётчиков. Хранилище — память процесса; при нескольких репликах счётчики не разделяются (риск R3).

## 6. Секреты и резервные копии

- `SESSION_SECRET` — минимум 32 символа; production отклоняет плейсхолдер `replace-with-…`. Секрет в `.env`
  или в файле контейнера с правами `0600`; в git не попадает.
- Смена `SESSION_SECRET` разлогинивает всех: cookie подписаны старым секретом. Плановая ротация — смена секрета
  и перезапуск; отдельного «двойного» ключа для плавного перехода нет.
- Ключ бэкапа — 32 байта, только файл `BACKUP_KEY_FILE` с правами `0600` (Windows ACL — `docs/deployment.md`
  §5.2), не переменная окружения Compose. Без ключа файл `*.dump.enc` не расшифровать; потеря ключа означает
  потерю копий. Ротация ключа не перешифровывает старые архивы: старый ключ нужно хранить столько же, сколько
  сами копии.
- Бэкап — `pg_dump --format=custom`, AES-256-GCM, атомарная запись, retention по возрасту. Восстановление
  проверяется `--verify` (row-count + контрольная сумма ключевых таблиц).
- `audit_log` пишет вход/выход, управление пользователями, каналами, кампаниями, целями, импорт, экспорт,
  загрузки, сценарии и закрытие алертов.

## 7. Медленные запросы

Пул оборачивается наблюдателем в `createApp`; каждый запрос, включая клиентов внутри `withTransaction`,
измеряется. Запрос дольше 200 мс пишет в pino предупреждение с полями `durationMs`, `operation`, `statement`
(одна строка, максимум 120 символов) и `userId` (`anon`, если запрос вне аутентифицированного контекста).
SQL-параметры и тела запросов в лог не попадают. Порог и логгер инъектируются для юнит-теста; production
использует общий pino.

## 8. Остаточные риски

Приоритет: **высокий** — исправить до публичного стенда; **средний** — принять осознанно или закрыть в
следующей итерации; **низкий** — документальная/эксплуатационная мелочь.

| ID | Риск | Приоритет | Решение |
|---|---|---|---|
| R1 | У загрузки изображений нет отдельного лимитера: вошедший пользователь может часто менять аватар в пределах 1 MB на запрос | средний | Добавить лимитер по `session.user.id` (как у импорта) при следующем касании `media`-маршрутов |
| R2 | `POST /app/alerts/recalculate` и `/api/v1/alerts/recalculate` меняют `alerts`, но не пишут строку в `audit_log` | средний | Решить, является ли пересчёт «значимым действием»; если да — добавить `alert.recalculate` в `AUDIT_ACTIONS` и писать строку в транзакции |
| R3 | Лимитеры хранятся в памяти процесса: реплики не разделяют счётчики, перезапуск их очищает | средний | Для одного контейнера приемлемо; при масштабировании — общий store (PostgreSQL/Redis) |
| R4 | `trust proxy` — конфигурация, а не автоматика: неверное значение ломает IP в аудите и ключ лимитера | средний | Раздел TLS в `docs/deployment.md` требует `TRUST_PROXY=1` за одним прокси; проверять на стенде |
| R5 | Запросы хранилища сессий выполняются до установки контекста запроса, поэтому медленная загрузка/сохранение сессии логируется как `anon` | низкий | Приемлемо: запрос сессии не принадлежит пользователю до её чтения |
| R6 | `style-src-attr 'unsafe-inline'` остаётся вынужденным для Recharts | низкий | Пересмотреть при переходе на CSS-классы в графиках; `script-src` не ослаблять |
| R7 | `Permissions-Policy` — статический allowlist: новая функция (камера, геолокация) не заработает без правки заголовка | низкий | Осознанно: приложению эти API не нужны |
| R8 | 30 неудачных входов с одного адреса за 15 минут могут задеть большой общий NAT | низкий | Порог выбран с запасом; при жалобах — поднять или считать по подсети |
| R9 | Нет уведомления администратору о серии неудачных входов; есть только строка `login rejected` в логе | низкий | Вне рамок курсового проекта; при необходимости — правило алерта по логам |
| R10 | `audit_log` не защищён от изменения владельцем БД и не имеет политики хранения | низкий | Для курсового стенда приемлемо; для production — отдельная роль с правом только `INSERT` и retention |
| R11 | Статика `/media/*` публична по замыслу (аватары и OG-обложка), поэтому приватных файлов там быть не должно | низкий | Загрузки валидируются и получают случайный slug; не класть в `media_assets` документы с персональными данными |
| R12 | HSTS не отправляется при `COOKIE_SECURE=false`; стенд, открытый наружу без TLS, останется без HSTS | низкий | Это ошибка развёртывания, а не кода: публичный стенд обязан иметь HTTPS и `COOKIE_SECURE=true` |
