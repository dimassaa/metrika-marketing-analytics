# M5 — журнал E2E, бюджеты и скриншоты

Дата прогона: 23.11.2026. Стенд: `http://localhost:3000`, PostgreSQL 18.6, Node.js 26.13.0, Chromium 158 через
`agent-browser 0.41.1` (headless). Сессии: `m5` (аналитик), `m5v` (наблюдатель), `m5e` (пустой стенд на
`localhost:3001`). Якорь данных — **22.11.2026** (вчера на момент `npm run seed`); демо-пароль — `Metrika2026!`.
Десктопные снимки — `1440×1000`, мобильные — `390×844`. Размеры проверены через
`identify -format "%f %wx%h" docs/screenshots/m5/*.png`.

## Два прохода: что проверено до T7-фикса и что переснято на HEAD

- **17:15–17:20, HEAD `3fe00c0`:** жизненный цикл алертов (авто- и ручной пересчёт, dismiss с аудитом, фильтры,
  пагинация на 51 временной строке), границы бюджета и клавиатура, RBAC наблюдателя, 390×844, регрессия
  дашборда/атрибуции, пустой стенд. Скриншоты первого прохода были сняты здесь.
- **17:21, `7a114cf`:** T7-фикс сделал проверку `curveChannelId` в API строгой и поправил caption последней
  измеренной недели. Диф не меняет жизненный цикл алертов, границы бюджета, RBAC или пустой builder, поэтому эти
  проверки не повторялись; их числа ниже относятся к первому проходу.
- **17:26–17:30, HEAD `7a114cf`:** полный `npm test` (1050 тестов), затем `npm run build` и рестарт сервера.
  Все пользовательские снимки пересняты на HEAD: `alerts.png`, `scenarios.png`, `scenarios-warning.png`,
  `scenarios-error.png`, `scenario-detail.png`, `alerts-390.png`, `scenarios-390.png`. Fallback кривой
  перепроверен отдельно: страница 200, API 400.
- **Финальный фикс M5 (ветка после `5dd6275`):** парсер BYN в алертах, база оптимизации, 12-месячная формула
  ROMI и styled-ошибка builder. Пересняты `alerts-dismissed.png` (строка TikTok со статусом «Скрыт», значение
  **58,69 BYN** и порог **56,74 BYN**), `scenarios.png`, `scenarios-error.png` и `scenario-detail.png`; ROMI в
  снимке теперь **+212,19%**, а не прежние −94,0%.
- `scenarios-empty.png` не переснимался после `7a114cf`: диф не затрагивает пустой стенд, и снимок остаётся
  доказательством того же кода страницы.
- Поэтому `17:15`/`17:16` в разделе алертов — это сохранённые `detected_at` первого прохода, а не время снимка.
  Текущий `alerts.png` снят в 17:30 и показывает «Последнее срабатывание»; столбец таблицы теперь также
  подписан «Сработало».

## Как воспроизвести

### 1. Чистая схема, данные и сборка

Команды рассчитаны на bash из корня репозитория. `.env` нужно загрузить в оболочку: `psql` не читает его сам,
а npm-скрипты делают это через `dotenv`.

```bash
set -a; . ./.env; set +a
npm run db:setup
psql "$DATABASE_URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
npm run migrate                   # 001–006 с нуля
npm run migrate                   # «database is up to date» — идемпотентно
npm run seed                      # якорь 22.11.2026
npm run build                     # семь входов Vite в public/assets
npm start                         # http://localhost:3000, /health → 200
```

Фактический вывод миграций: `applied 001_init.sql` … `applied 006_decisions.sql`, повторный запуск —
`database is up to date, nothing to apply`. Сид: 8 каналов, 32 кампании, 4 000 клиентов, 9 436 заказов,
14 062 касания, 12 691 строка статистики, 4 цели; расход 151 404,24 BYN, выручка 1 134 186,98 BYN.
`GET /health` вернул `{"status":"ok","db":"up","version":"0.1.0"}`.

> `npm start` запускался с `NODE_ENV=development` из `.env`: production-конфигурация требует
> `COOKIE_SECURE=true`, а локальный HTTP-стенд работает без TLS. Это тот же путь, что описан в README.

### 2. Полный набор тестов

```bash
npm test                          # 92 файла, 1050 тестов
```

Итог: **92 passed (92), 1050 passed (1050)**, 85,3 с. Предупреждений, `warn`/`error` в выводе нет. Единственное
сообщение сборки — стандартное предупреждение Vite `Some chunks are larger than 500 kB after minification`
(общий чанк React + Recharts: 642,06 kB minified / 193,70 kB gzip); это известный косметический пункт из
`IMPROVEMENTS.md`, а не ошибка.

### 3. Бюджеты запросов

`tests/integration/page-queries.test.js` теперь проверяет и экраны решений: потолок, отсутствие повторного
statement с теми же параметрами и отдельный кейс сохранённого снимка (страница и API). Проверка запускается
как `npx vitest run tests/integration/page-queries.test.js` — 10 тестов, все зелёные.

| Запрос | Измерено | Потолок | Комментарий |
|---|---:|---:|---|
| `GET /app/alerts` (первый GET в сессии) | 19 | 32 | включает авто-пересчёт: два окна, upsert, stale-резолв, аудит |
| `GET /app/alerts?status=all&severity=critical` | 9 | 32 | без авто-пересчёта: сессия уже прошла throttle |
| `GET /api/v1/alerts` | 9 | 12 | API на GET не пишет |
| `GET /app/scenarios` | 10 | 12 | builder + список снимков |
| `GET /api/v1/scenarios` | 10 | 12 | та же экранная модель |
| `GET /app/scenarios/:id` | 3 | 6 | только сохранённый JSONB, без повторной подгонки |
| `GET /api/v1/scenarios/:id` | 3 | 6 | тот же detail-загрузчик |

Повторных statement с идентичными параметрами нет ни на одном пути.

### 4. Размеры сборки

`tests/integration/build-output.test.js` проверяет вход ≤210 KB gzip и всю страницу ≤250 KB gzip. Замер тем же
способом (zlib level 9 по файлам манифеста):

| Страница | Entry gzip | Страница gzip | Сырой вес страницы |
|---|---:|---:|---:|
| Алерты | 1 350 B | 200 360 B (**195,7 KiB**) | 667 102 B |
| Сценарии | 5 113 B | 222 654 B (**217,4 KiB**) | 733 786 B |

Обе страницы укладываются в 250 KiB; общий чанк React + Recharts кэшируется между входами.

## Скриншоты: аналитик

```bash
agent-browser --session m5 set viewport 1440 1000
agent-browser --session m5 open http://localhost:3000/login
agent-browser --session m5 fill 'input[name=email]' "analyst@metrika.by"
agent-browser --session m5 fill 'input[name=password]' "Metrika2026!"
agent-browser --session m5 find role button click --name "Войти"
agent-browser --session m5 wait --url "**/app/dashboard**"

# Алерты: первый GET выполняет авто-пересчёт, затем снимок верха страницы
agent-browser --session m5 console --clear
agent-browser --session m5 open http://localhost:3000/app/alerts
agent-browser --session m5 wait --text "Сработавшие правила"
agent-browser --session m5 screenshot docs/screenshots/m5/alerts.png

# Скрыть TikTok с причиной и снять таблицу с dismissed-строкой
agent-browser --session m5 fill 'input[name=reason]' "Пик сезонный"
agent-browser --session m5 find role button click --name "Скрыть"
agent-browser --session m5 open 'http://localhost:3000/app/alerts?status=dismissed'
agent-browser --session m5 wait --text "Скрыт"
agent-browser --session m5 eval 'document.querySelector("[aria-label=Алерты]").scrollIntoView({block:"center"})'
agent-browser --session m5 screenshot docs/screenshots/m5/alerts-dismissed.png

# Builder в состоянии по умолчанию
agent-browser --session m5 open http://localhost:3000/app/scenarios
agent-browser --session m5 wait --text "Параметры расчёта"
agent-browser --session m5 screenshot docs/screenshots/m5/scenarios.png

# Предупреждение >2× (единственная карточка warnings) и отказ на 3×+1 копейку
agent-browser --session m5 open 'http://localhost:3000/app/scenarios?budgetByn=5388.01'
agent-browser --session m5 wait --text "Предупреждения расчёта"
agent-browser --session m5 eval 'window.scrollTo(0, document.body.scrollHeight)'
agent-browser --session m5 screenshot docs/screenshots/m5/scenarios-warning.png
agent-browser --session m5 open 'http://localhost:3000/app/scenarios?budgetByn=8082.01'
agent-browser --session m5 screenshot docs/screenshots/m5/scenarios-error.png

# Снимок: сохранить сценарий из builder и открыть detail
agent-browser --session m5 open http://localhost:3000/app/scenarios
agent-browser --session m5 wait --text "Сохранить сценарий"
agent-browser --session m5 fill 'input[name=name]' "Зёрна: снимок M5"
agent-browser --session m5 find role button click --name "Сохранить сценарий"
agent-browser --session m5 wait --url "**/app/scenarios/*"
agent-browser --session m5 screenshot docs/screenshots/m5/scenario-detail.png

# Мобильные снимки
agent-browser --session m5 set viewport 390 844
agent-browser --session m5 open http://localhost:3000/app/alerts
agent-browser --session m5 wait --text "Сработавшие правила"
agent-browser --session m5 screenshot docs/screenshots/m5/alerts-390.png
agent-browser --session m5 open http://localhost:3000/app/scenarios
agent-browser --session m5 wait --text "Параметры расчёта"
agent-browser --session m5 screenshot docs/screenshots/m5/scenarios-390.png
```

## Что проверено

### Алерты

- Первый GET аналитика (первый проход) создал две строки: Яндекс Директ и TikTok, правило «Всплеск CAC»,
  важность «Предупреждение», окно **26.10.2026 — 22.11.2026**, «Последнее срабатывание». В финальном фиксе
  таблица показала **55,62 BYN / 47,05 BYN** для Яндекс Директа и **58,69 BYN / 56,74 BYN** для TikTok — проверка
  парсера `NUMERIC(14,4)` на реальной строке.
  `GET /api/v1/alerts` вернул тот же объект: `total: 2`, `chart.series` — 12 недель, заголовок
  «CAC: Яндекс Директ, −14,3% за 12 измеренных недель».
- **Авто-пересчёт ровно раз в час.** Повторное открытие `/app/alerts` в той же сессии оставило
  `MAX(detected_at)` без изменений (`17:15:50`). Кнопка «Пересчитать» обновила его до `17:16:17`, то есть ручной
  пересчёт не подавляется session-throttle. Ручной POST отвечает 302 на `/app/alerts`; страница перезагружается,
  остров заново получает `data-props`, и 12-недельный график CAC отрисовывается с новым stamp проверки.
- **Повторный пересчёт не плодит строки.** После ручного пересчёта `SELECT count(*) FROM alerts` остался `2`;
  уникальность `(channel_id, rule, period_start)` удержала те же две записи, а не создала третью. Это же
  подтверждает интеграционный тест «two recalcs, count stable».
- **Скрытие с причиной.** У TikTok (`alerts.id=1`) заполнено «Проверено: пик сезонный», POST на
  `/app/alerts/1/dismiss` → 302, строка стала `dismissed`, в активных осталась одна. В `audit_log` появилась
  запись `action=alert.dismiss, entity=alert, entity_id=1` с payload `{rule, reason, severity, channelId,
  periodStart}`.
- **Фильтры.** `?status=all` — 2 строки, `?status=dismissed` — снятая TikTok, `?severity=critical` — честное
  «По фильтру ничего не найдено» (критичных на сиде нет), `?channelId=4&status=all` — только TikTok. Пустое
  состояние по фильтру отличимо от «Алертов пока нет».
- **Пагинация по 50.** Чтобы проверить её на демо-данных, в dev-базу временно добавлена 51 валидная строка:

  ```sql
  DO $$
  DECLARE c record; r text; p date; n int := 0;
  BEGIN
    FOREACH p IN ARRAY ARRAY['2025-10-06','2025-10-13','2025-10-20','2025-10-27']::date[] LOOP
      FOR c IN SELECT id FROM channels ORDER BY id LOOP
        FOREACH r IN ARRAY ARRAY['cac_spike','romi_below_target','romi_negative','payback_long','ltv_cac_low']::text[] LOOP
          EXIT WHEN n >= 51;
          INSERT INTO alerts (channel_id, rule, period_start, severity, value, threshold, status)
          VALUES (c.id, r, p, 'warning', 1, 1, 'active')
          ON CONFLICT (channel_id, rule, period_start) DO NOTHING;
          n := n + 1;
        END LOOP;
        EXIT WHEN n >= 51;
      END LOOP;
      EXIT WHEN n >= 51;
    END LOOP;
  END $$;
  ```

  Наблюдатель увидел «Страница 1 из 2», 50 строк и ссылку «Дальше»; `page=2` — 2 строки и «Назад».
  После проверки `npm run seed` вернул стенд к детерминированному состоянию (алертов 0, сценариев 0).
- **График проблемного канала** не зависит от фильтра таблицы: при `?status=dismissed` заголовок и 12 точек
  совпали с активным видом; явный `?channelId=…` сужает линию до выбранного канала.

### Сценарии и границы бюджета

Builder по умолчанию: недельный бюджет **2 694,00 BYN**, 12 месяцев ×52 = **140 088,00 BYN**, максимум
**8 082,00 BYN** (3×), порог предупреждения **5 388,00 BYN** (2×), 8 каналов, 26 полных недель. Пресет «×2»
открыл `/app/scenarios?budgetByn=5388.00…`, значение слайдера стало `5388`, подпись «280 176,00 BYN»; на ровно
2× предупреждения нет, а выше 2× оно показывается один раз — в карточке «Предупреждения расчёта».

| Бюджет, BYN | Ответ | Что видно |
|---:|---|---|
| `0.01` | 400 | styled-страница «Расчёт не выполнен»: «Бюджета не хватает даже на 1 копейку каждому каналу» |
| `0.06` | 200 | минимальный распределяемый бюджет: по 1 копейке на 6 кривых |
| `2 694` | 200 | значение по умолчанию, без предупреждения |
| `5 388` | 200 | ровно 2× базы оптимизации, предупреждения ещё нет |
| `5 388.01` | 200 | «Бюджет больше базы оптимизации более чем в 2 раза — прогноз за пределами наблюдённых расходов (экстраполяция)» |
| `8 082` | 200 | ровно 3×, предупреждение есть (это выше 2×) |
| `8 082.01` | 400 | styled-страница «Бюджет больше 3× базы оптимизации в BYN»; введённое `8082.01` остаётся в поле |

- **Клавиатура.** `focus '#budgetByn'` + `End` даёт `8082`, `Home` — `0.06` (минимум слайдера теперь равен
  1 копейке × число каналов с кривой); в accessibility-tree слайдер называется «Недельный бюджет» и объявляет
  собственное значение. Статический `aria-valuetext` убран: он не обновлялся вместе с ползунком и объявлял
  устаревшую сумму. Ошибка бюджета больше не уходит в plain-text 400 и не обрезается до 100: страница отвечает
  тем же 400, но рендерит builder с alert-карточкой, полем `number` (для `abc` — `text`) с реальными `min`/`max`
  и введённым значением.
- **Fallback кривой.** `?channelIds=1,2&curveChannelId=8` вернул 200, оставил Google Ads и Instagram и показал
  «Выбранный канал кривой не входит в набор — показываем первую доступную кривую». Это presentation-only:
  суммы плана от выбора кривой не зависят. API намеренно строже: тот же запрос к
  `/api/v1/scenarios?channelIds=1,2&curveChannelId=8` отвечает **400** `VALIDATION_ERROR`
  «Некорректный канал кривой», потому что JSON-клиент не должен молча получать другую кривую.
- **Пустой builder.** На отдельном стенде без фактов (см. ниже) `/app/scenarios` отвечает **200** с заголовком
  «Нет данных для расчёта сценария», объяснением и ссылкой «Перейти к импорту»; API при этом честно отвечает
  `400 VALIDATION_ERROR` «Нет каналов с валидной кривой». На боевом сиде тот же экран достигается выбором
  только бесплатного канала (`?channelIds=6`).
- **Снимок.** Сохранение «Зёрна: снимок после фикса» → `/app/scenarios/1`. Detail вернул `mode: 'detail'`,
  `invalid: false`, те же totals, что builder: расход `269 400` копеек, клиенты `62,0 → 58,0`, CAC `43,45 → 46,42`,
  выручка 12 месяцев `437 346,31 BYN`, ROMI **`+212,19%`**, 8 каналов. Ссылка «Повторить с этими параметрами»
  открыла `/app/scenarios?budgetByn=2694.00&channelIds=…` — тот же набор каналов и бюджет.

### Пустой стенд для builder

Чтобы получить настоящий пустой стенд, не трогая dev-базу:

```bash
set -a; . ./.env; set +a
EMPTY_DB=metrika_m5_empty
# Любая роль с правом CREATEDB из ADMIN_DATABASE_URL; локальный пользователь ОС не нужен.
EMPTY_DATABASE_URL="${EMPTY_DATABASE_URL:-postgres://postgres:postgres@localhost:5432/$EMPTY_DB}"
psql "$ADMIN_DATABASE_URL" -c "DROP DATABASE IF EXISTS $EMPTY_DB WITH (FORCE)"
psql "$ADMIN_DATABASE_URL" -c "CREATE DATABASE $EMPTY_DB"
DATABASE_URL="$EMPTY_DATABASE_URL" npm run migrate
DATABASE_URL="$EMPTY_DATABASE_URL" npm run seed
psql "$EMPTY_DATABASE_URL" -c "TRUNCATE daily_stats, customers, touchpoints, orders, alerts, scenarios RESTART IDENTITY CASCADE;"
PORT=3001 DATABASE_URL="$EMPTY_DATABASE_URL" npm start > /tmp/metrika-m5-empty.log 2>&1 &
# второй процесс на http://localhost:3001; дождитесь {"status":"ok"} от /health
```

`ADMIN_DATABASE_URL` — та же роль с `CREATEDB`, что нужна `npm run db:setup`; если базы уже созданы вручную,
подойдёт любой URL с правом создавать базы. Замените `postgres:postgres` на свою роль и пароль либо заранее
экспортируйте `EMPTY_DATABASE_URL`.

Скриншот пустого builder снимается так:

```bash
agent-browser --session m5e set viewport 1440 1000
agent-browser --session m5e open http://localhost:3001/login
agent-browser --session m5e fill 'input[name=email]' "viewer@metrika.by"
agent-browser --session m5e fill 'input[name=password]' "Metrika2026!"
agent-browser --session m5e find role button click --name "Войти"
agent-browser --session m5e wait --url "**/app/dashboard**"
agent-browser --session m5e open http://localhost:3001/app/scenarios
agent-browser --session m5e wait --text "Пока нечего распределять"
agent-browser --session m5e screenshot docs/screenshots/m5/scenarios-empty.png
agent-browser --session m5e console
agent-browser --session m5e errors

# API на пустом стенде обязан остаться строгим
agent-browser --session m5e eval '(async()=>{const r=await fetch("/api/v1/scenarios");return JSON.stringify({status:r.status,body:await r.text()})})()'
agent-browser --session m5e close

# Уборка в той же оболочке, где заданы EMPTY_DB и ADMIN_DATABASE_URL
kill $(lsof -ti:3001)          # или завершите процесс из другого терминала
psql "$ADMIN_DATABASE_URL" -c "DROP DATABASE IF EXISTS $EMPTY_DB WITH (FORCE)"
```

Проверено: `/app/scenarios` → 200, «Нет данных для расчёта сценария», `data-island="scenarios"` отсутствует
(остров не монтируется без модели), topbar подписан «Данные по 23.11.2026». API → 400 с русским сообщением.

### Наблюдатель: RBAC в браузере

```bash
agent-browser --session m5v set viewport 1440 1000
agent-browser --session m5v open http://localhost:3000/login
agent-browser --session m5v fill 'input[name=email]' "viewer@metrika.by"
agent-browser --session m5v fill 'input[name=password]' "Metrika2026!"
agent-browser --session m5v find role button click --name "Войти"
agent-browser --session m5v wait --url "**/app/dashboard**"
agent-browser --session m5v open http://localhost:3000/app/alerts
agent-browser --session m5v open http://localhost:3000/app/scenarios
```

- `/app/alerts`: формы `action="/app/alerts/recalculate"` нет, кнопок «Скрыть» — 0, страница читается и
  показывает те же данные. `/app/scenarios`: POST-форма сохранения и кнопка «Сохранить сценарий» отсутствуют,
  GET-форма параметров и остров на месте.
- Прямые POST с валидным CSRF-токеном из сессии наблюдателя отклонены: `/app/alerts/recalculate` → **403**
  styled-страница, `/app/scenarios` → **403**, `/api/v1/alerts/recalculate` → **403 JSON**
  `{"error":{"code":"FORBIDDEN","message":"Недостаточно прав"}}`.

### Регрессия дашборда и атрибуции

Меню «Дашборд → Атрибуция → Алерты» кликается: дашборд показывает «CAC по неделям», атрибуция —
«Выручка по моделям», алерты — «Сработавшие правила». Консоль и page errors после перехода пусты.

### 390×844, консоль и переполнение

- Алерты и сценарии на `390×844`: `scrollWidth = clientWidth = 390`, переполнение страницы **0 px** на обоих.
  Внутренние таблицы прокручиваются в своих `.table-wrap`, страница не расширяется.
- `console` и `errors` очищались перед экранами; на алертах, сценариях, detail, пустом builder, дашборде и
  атрибуции — ни одного сообщения или ошибки страницы. Серверный журнал за прогон не содержит записей уровня
  `warn`/`error`.

## Снимки

Все снимки — viewport `1440×1000` или `390×844`, без `--full`.

| Файл | Разрешение | Что реально видно |
|---|---|---|
| `alerts.png` | 1440×1000 | Верх алертов: фильтры статуса/важности/канала, «Пересчитать», четыре плитки сводки (1 активный, 0 критичных, 1 предупреждение после скрытия TikTok) и график CAC Яндекс Директа; таблица ниже сгиба |
| `alerts-dismissed.png` | 1440×1000 | Таблица после скрытия TikTok: прокручена к «Сработавшие правила», строка со статусом «Скрыт», значением **58,69 BYN** и порогом **56,74 BYN** |
| `alerts-390.png` | 390×844 | Мобильный верх алертов: свёрнутое меню, topbar, фильтры и начало сводки |
| `scenarios.png` | 1440×1000 | Builder: слайдер 2 694,00 BYN, 12 месяцев 140 088,00 BYN, максимум 8 082,00 BYN, каналы, пресеты и первые плитки результата |
| `scenarios-390.png` | 390×844 | Мобильный builder: заголовок, параметры, слайдер с подсказкой о базе оптимизации и начале каналов |
| `scenarios-warning.png` | 1440×1000 | Бюджет 5 388,01 BYN: прокручено к единственной карточке «Предупреждения расчёта» с «Бюджет больше базы оптимизации более чем в 2 раза… (экстраполяция)» |
| `scenarios-error.png` | 1440×1000 | Ответ 400 на 8 082,01 BYN: styled builder с карточкой «Расчёт не выполнен», «Бюджет больше 3× базы оптимизации в BYN», полем `number` со значением `8082.01` и `max="8082.01"` |
| `scenario-detail.png` | 1440×1000 | Сохранённый снимок «Зёрна: снимок после фикса»: автор, дата, отчётная дата, плитки и таблица «До и после» с ROMI `+212,19%` |
| `scenarios-empty.png` | 1440×1000 | Пустой стенд: «Нет данных для расчёта сценария», объяснение и ссылка «Перейти к импорту» |

`alerts.png` снят после скрытия TikTok: таблица начинается ниже сгиба, поэтому строка в кадр не попала, а плитки
показывают 1 активный алерт. Доказательство dismiss — `alerts-dismissed.png` (строка «Скрыт»), запись `dismissed`
в БД и `alert.dismiss` в `audit_log`.

Стенд после проверки возвращён к сиду (`npm run seed`, якорь 22.11.2026): алертов и сценариев 0, сессии
сброшены. Снимки и этот журнал — доказательство прогона; временная база `metrika_m5_empty` удалена.
