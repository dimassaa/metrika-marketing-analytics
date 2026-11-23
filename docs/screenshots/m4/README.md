# M4 — журнал E2E и скриншоты

Дата прогона: 23.11.2026. Стенд: `http://localhost:3000`, PostgreSQL 18, Node.js 26.13.0, Chromium через
`agent-browser 0.41.1` (headless), сессии `m4` (наблюдатель) и `m4a` (аналитик). Якорь данных — **22.11.2026**
(вчера на момент `npm run seed`). Демо-пароль всех аккаунтов — `Metrika2026!`. Десктопные снимки — `1440×1000`,
мобильные — `390×844`; полностраничный пустой дашборд — `1440×2922`. Размеры проверены через
`identify -format "%f %wx%h" docs/screenshots/m4/*.png`.

## Как воспроизвести

Команды рассчитаны на bash из корня репозитория. `.env` нужно загрузить в текущую оболочку: `psql` не читает
`.env` сам, а `npm`-скрипты делают это через `dotenv`.

```bash
# 1. Чистая схема, данные и сборка
set -a; . ./.env; set +a          # DATABASE_URL, TEST_DATABASE_URL, ADMIN_DATABASE_URL
npm run db:setup
psql "$DATABASE_URL" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
npm run migrate                   # 001–005 с нуля
npm run migrate                   # «database is up to date» — идемпотентно
npm run seed                      # якорь 22.11.2026
npm run build                     # пять входов Vite в public/assets
npm start                         # http://localhost:3000, /health → 200
```

Проверка чистого пути в отдельной оболочке: `bash -lc 'set -a; . ./.env; set +a; psql "$DATABASE_URL" -c
"select current_database(), (select count(*) from channels);"'` печатает `metrika_dev | 8`.

```bash
# 2. Полный набор тестов — до и после сборки
npm test                          # с public/assets: 80 файлов, 864 теста
mv public/assets /tmp/assets-backup
npm test                          # без сборки: 854 passed, 10 skipped (build-output)
rm -rf public/assets && mv /tmp/assets-backup public/assets
```

`npm test` не печатает предупреждений. Единственное предупреждение прогона — сообщение Vite
`Some chunks are larger than 500 kB after minification` при `npm run build` (общий чанк React + Recharts:
641,52 kB minified / 193,47 kB gzip). Это известный косметический пункт из `IMPROVEMENTS.md`, а не ошибка сборки:
входы и страницы укладываются в бюджеты 210/250 KB gzip, проверяемые `build-output.test.js`.

### Скриншоты: наблюдатель

```bash
agent-browser --session m4 set viewport 1440 1000
agent-browser --session m4 open http://localhost:3000/login
agent-browser --session m4 fill 'input[name=email]' "viewer@metrika.by"
agent-browser --session m4 fill 'input[name=password]' "Metrika2026!"
agent-browser --session m4 find role button click --name "Войти"
agent-browser --session m4 wait --url "**/app/dashboard**"

# Десктоп, по одному снимку на экран
agent-browser --session m4 open http://localhost:3000/app/dashboard
agent-browser --session m4 wait --text "CAC по неделям"
agent-browser --session m4 screenshot docs/screenshots/m4/dashboard.png

agent-browser --session m4 open http://localhost:3000/app/channels
agent-browser --session m4 wait --text "Место"
agent-browser --session m4 screenshot docs/screenshots/m4/channels.png

agent-browser --session m4 open http://localhost:3000/app/channels/1
agent-browser --session m4 wait --text "Метрики канала"
agent-browser --session m4 screenshot docs/screenshots/m4/channel.png

agent-browser --session m4 open http://localhost:3000/app/cohorts
agent-browser --session m4 wait --text "Когорта"
agent-browser --session m4 screenshot docs/screenshots/m4/cohorts.png

agent-browser --session m4 open http://localhost:3000/app/attribution
agent-browser --session m4 wait --text "Выручка по моделям"
agent-browser --session m4 screenshot docs/screenshots/m4/attribution.png

# Пустое состояние: несуществующий id канала сужает все пять виджетов до нуля.
# --full обязателен: снимок должен включать раскрытую таблицу ниже сгиба.
agent-browser --session m4 open "http://localhost:3000/app/dashboard?days=30&channelIds=999999"
agent-browser --session m4 wait --text "Открыть таблицу данных"
agent-browser --session m4 find text "Открыть таблицу данных" click --exact
agent-browser --session m4 wait 500
# Пауза нужна, чтобы React успел отрисовать строки таблицы до full-page снимка.
agent-browser --session m4 screenshot docs/screenshots/m4/dashboard-empty.png --full

# Клавиатурный фокус на summary первой таблицы-дубля
agent-browser --session m4 open http://localhost:3000/app/dashboard
agent-browser --session m4 wait --text "CAC по неделям"
agent-browser --session m4 focus "figure details > summary"
agent-browser --session m4 screenshot docs/screenshots/m4/focus.png

# Мобильные снимки (viewport 390×844, не full page)
agent-browser --session m4 set viewport 390 844
agent-browser --session m4 open http://localhost:3000/app/dashboard
agent-browser --session m4 wait --text "CAC по неделям"
agent-browser --session m4 screenshot docs/screenshots/m4/mobile-dashboard.png

agent-browser --session m4 open http://localhost:3000/app/channels
agent-browser --session m4 wait --text "Место"
agent-browser --session m4 screenshot docs/screenshots/m4/mobile-channels.png

agent-browser --session m4 open http://localhost:3000/app/cohorts
agent-browser --session m4 wait --text "Когорта"
agent-browser --session m4 screenshot docs/screenshots/m4/mobile-cohorts.png
```

### Скриншоты: аналитик и M2-форма

```bash
agent-browser --session m4a set viewport 1440 1000
agent-browser --session m4a open http://localhost:3000/login
agent-browser --session m4a fill 'input[name=email]' "analyst@metrika.by"
agent-browser --session m4a fill 'input[name=password]' "Metrika2026!"
agent-browser --session m4a find role button click --name "Войти"
agent-browser --session m4a wait --url "**/app/dashboard**"

# Правка цели канала: значение меняется и возвращается обратно
agent-browser --session m4a open http://localhost:3000/app/channels/1
agent-browser --session m4a wait --text "Метрики канала"
agent-browser --session m4a fill 'input[name=targetCacByn]' "46,50"
agent-browser --session m4a find role button click --name "Сохранить"
# в таблице целей: «Целевой CAC 46,50 BYN 43,71 BYN В цели»
agent-browser --session m4a fill 'input[name=targetCacByn]' "45,00"
agent-browser --session m4a find role button click --name "Сохранить"

# Защита архива: у Instagram четыре активные кампании
agent-browser --session m4a find role button click --name "Архивировать канал"
# ожидаемо: «Изменение не применено. Нельзя архивировать канал с активными кампаниями…»,
# URL /app/channels/1/archive, форма периода всё ещё ведёт на /app/channels/1
agent-browser --session m4a wait 500
# Chromium иногда отменяет следующий open, пока POST-ответ страницы-заглушки ещё «оседает»
# (net::ERR_ABORTED); короткая пауза делает блок воспроизводимым.

# Пустой временный канал: создать, проверить пустые состояния, архивировать и вернуть
agent-browser --session m4a open http://localhost:3000/app/channels
agent-browser --session m4a wait --text "Новый канал"
agent-browser --session m4a fill 'input[name=code]' "m4_archive_e2e"
agent-browser --session m4a fill 'input[name=name]' "M4 архив"
agent-browser --session m4a select 'select[name=kind]' "paid"
agent-browser --session m4a fill 'input[name=targetCacByn]' "50,00"
agent-browser --session m4a fill 'input[name=targetRomiPct]' "100"
agent-browser --session m4a find role button click --name "Добавить канал"
agent-browser --session m4a wait --text "m4_archive_e2e"
agent-browser --session m4a find role link click --name "M4 архив"
agent-browser --session m4a wait --text "Метрики канала"
agent-browser --session m4a find role button click --name "Архивировать канал"
# ожидаемо: статус «В архиве», баннер, кнопка «Вернуть из архива»
agent-browser --session m4a find role button click --name "Вернуть из архива"

# Вернуть демо-стенд к детерминированному состоянию (канал m4_archive_e2e, аудит и правки исчезнут)
npm run seed
```

Сид: 8 каналов, 32 кампании, 4 000 клиентов, 9 436 заказов, 14 062 касания, 12 691 строка статистики, 4 цели;
расход 151 404,24 BYN, выручка 1 134 186,98 BYN. Финальный `npm run seed` возвращает базу к этому состоянию и
разлогинивает обе сессии; снимки и журнал остаются доказательством прогона.

Строгий манифест проверяется отдельно: `tests/integration/assets-strict.test.js` запускает дочерний процесс с
`NODE_ENV=production`, временно убирает настоящий манифест и утверждает, что `createApp` отказывается стартовать
(`AssetManifestError` с путём и `npm run build`), а второй кейс — что production-читатель не перечитывает
перезаписанный файл. Обычный `npm test` этого не проверяет: в тестовом режиме манифест необязателен.

## Что проверено

### Дашборд

- По умолчанию: 4 KPI (расход 11 419,58 BYN, 261 новый клиент, CAC 43,75 BYN, ROMI +714,2%), вердикт «В норме»,
  пять фигур и пять таблиц-дублей, семь SVG Recharts (пять графиков + два спарклайна), подписи «12 недель».
- `?days=90` → расход 34 095,08 BYN, 854 клиента, CAC 39,92 BYN; `?days=180` → 65 154,75 BYN, 1 687 клиентов.
- `?from=2026-09-01&to=2026-09-30` → в topbar «Период: 01.09.2026 — 30.09.2026» и ссылка сброса на `?days=30`.
- Фильтр каналов: один канал (`channelIds=2`) → «Выбрано 1 из 8», расход 2 968,69 BYN, все подписи «1 канал»;
  два канала (`channelIds=2&channelIds=1`) → 5 897,49 BYN и «2 канала»; «Сбросить» возвращает все восемь.
- Scatter: наведение на точку показывает «Блогеры · CAC 49,74 BYN · LTV12 150,90 BYN · Новые клиенты 18»;
  линейный график — «31.08.2026 · CAC по неделям · 47,56 BYN».
- Пустое состояние: `?channelIds=999999` → расход 0,00, клиенты 0, CAC/ROMI «—», пять кнопок
  «Открыть таблицу данных», пять пустых объяснений. Кнопка открывает `<details>` и переводит фокус на
  `<summary>`; следующий `Tab` попадает в `role="region"` таблицы, а не в SVG.

### Каналы

- Таблица 8 строк и 12 колонок, сортировка по CAC (`sort=cac&dir=asc`) сохраняет `days=90&status=active&kind=paid`;
  значения идут 41,13 → 55,98 BYN. Сортировка по выручке — 58 657,65 → 17 319,00 BYN.
- Веса `wCac=100&wRomi=0&wLtvCac=0&wNewCustomers=0` меняют рейтинг: Telegram Ads падает со 2-го на 5-е место,
  Блогеры поднимаются на 2-е; счёт 100,0 / 56,7 / 52,5 / 26,0 / 10,0 / 0,0, у бесплатных Email/SEO — «—».
- `?status=bogus` показывает все 8 строк и переключает селект на «Все»; `?status=archived` в сиде даёт 0 строк;
  `?kind=earned` — одну.
- Строка канала ведёт в `/app/channels/1`; «Экспорт CSV» (`/app/export/channels.csv?status=active&kind=paid`)
  отвечает 200, `text/csv`, `attachment; filename="metrika-channels-2026-11-22.csv"`, первая строка с BOM
  (`ef bb bf`) и заголовком `code;name;kind;is_active;target_cac_byn;target_romi_pct;campaigns_count`.

### Паспорт канала

- Instagram: три фигуры (CAC, ROMI, расход/выручка), воронка из пяти шагов, матрица удержания 14 когорт × 12
  месяцев, две таблицы кампаний, цели «Целевой CAC 45,00 / 43,71 — В цели» и «Целевой ROMI 120,0% / +623,5% — В цели».
- Аналитик меняет целевой CAC 45,00 → 46,50, сохраняет и возвращает обратно; значение в таблице целей и в форме
  совпадает, CSRF-токен присутствует.
- Защита архива: «Архивировать канал» на Instagram возвращает «Изменение не применено. Нельзя архивировать канал
  с активными кампаниями…», URL остаётся `/app/channels/1/archive`, период-форма по-прежнему ведёт на
  `/app/channels/1`.
- Временный канал `m4_archive_e2e` без кампаний: все пустые состояния честные (CAC/ROMI/расход-выручка, воронка,
  когорты, кампании), цели показывают «— · Нет данных для сравнения»; архивирование даёт статус «В архиве»,
  баннер и кнопку «Вернуть из архива»; возврат снова делает канал активным.
- Мобильная ширина: страница без горизонтального переполнения (390 px), графики и матрица прокручиваются внутри
  своих контейнеров.

### Когорты

- `?horizon=3` — колонки 0…2 и LTV3; `?horizon=6` — 0…5 и LTV6; по умолчанию 12 месяцев и LTV12, 14 когорт.
- Неполные когорты помечены «неполная» (24 ячейки на горизонте 12), будущие ячейки — «—» (66), ноль остаётся
  измеримым нулём (`0,0%`).
- `?channelId=1` сужает матрицу, ссылки горизонта сохраняют `channelId=1`; topbar без селекта `days`.
- Клавиатура: `.matrix-wrap` — `role="region"`, `tabindex="0"`, `aria-label`; `focus` + `ArrowRight` прокручивает
  `scrollLeft` 0 → 40 при ширине 322 против 1088; страница при этом не расширяется.

### Атрибуция

- По умолчанию last-touch: три плитки итогов (по 92 978,95 BYN и ROMI +714,2% у каждой модели), grouped bars по
  трём моделям, дельта-таблица «линейная − последнее касание» с типографским минусом (`−2,02`, `−<0,1%`).
- Переключение на `?model=linear` меняет выбранную модель и подпись сводки; итоги по моделям совпадают по
  математике, распределение по каналам — нет.
- `?model=bogus` и `?days=15` на странице отвечают 400 `text/plain` с русским сообщением — это зафиксированная
  асимметрия «страница терпима к фильтрам списка, но строга к периоду/модели», а не 500.

#### Пометка о неатрибутированной выручке: ограничение модели, а не пропуск E2E

Пометка `unattributedNote` появляется, когда `totalAttributedCents < totalRevenueCents`, то есть когда
`attributeRevenue` пропустил заказ. Сервис пропускает заказ только при `firstChannelId === null` и отсутствии
касаний в окне (`src/services/metrics/attribution.service.js`, ветка `if (order.firstChannelId === null) continue;`).
В базе это состояние недостижимо:

1. `customers.first_channel_id` объявлен `BIGINT NOT NULL` (`db/migrations/001_init.sql`), а
   `attribution.repo.js` всегда делает `JOIN customers c` и берёт `c.first_channel_id` как fallback.
2. Поэтому заказ без касаний всё равно атрибутируется каналу привлечения. Проверено интеграционным тестом
   `tests/integration/attribution-screen.test.js` → «cannot leave revenue unattributed because every customer has an
   acquisition channel»: он вставляет клиента и заказ без касаний, ждёт рост итога ровно на 10 000 копеек и
   `unattributedNote: null`, а также утверждает `is_nullable = 'NO'` и ноль клиентов с `NULL` в БД.
3. На сиде все 92 978,95 BYN периода атрибутированы (`unattributedNote: null`); SQL-проверка
   `SELECT count(*) FROM customers WHERE first_channel_id IS NULL` возвращает 0.

Следовательно, видимую пометку нельзя получить на текущих инвариантах без снятия `NOT NULL` (то есть без изменения
схемы), поэтому снимка для неё нет. Это зафиксировано как ограничение спецификации в `IMPROVEMENTS.md`, а не как
покрытый E2E сценарий. Ветка отрисовки проверена юнит-тестом `screen-models.test.js` и островным тестом
`attribution-island.test.js`.

### Доступность, консоль, API, мобильные ширины

- 45 нажатий `Tab` с дашборда: первым получает фокус skip-link «Перейти к содержанию», с «Применить» фокус идёт
  по пяти `<summary>` «Показать таблицу», затем цикл повторяется. Ни одной остановки внутри `<g>`, `<svg>` или
  `[aria-hidden]`; всплывающие подсказки после focus-guard работают.
- `console` очищался на каждом экране: ни одного сообщения или ошибки страницы на всех пяти.
- `/api/v1/dashboard?days=30`: 200, `application/json`, `Cache-Control: no-store`, ключи `page/period/filter/
  channelOptions/channels/kpis/verdict/charts/labels`, `filter.channelIds = null`, `bigint` в JSON отсутствует.
- Горизонтальное переполнение страницы на `390×844`: 0 px на дашборде, каналах, паспорте, когортах и атрибуции.
  Внутренние области прокрутки: таблица каналов 1125/322, матрица когорт 1088/322, таблицы графиков — свои
  `.table-wrap`.
- `1280×900`, каналы: страница 0 px, таблица прокручивается внутри карточки (1161 против 916) — известный
  компромисс из `IMPROVEMENTS.md`.

## Снимки

Все десктопные снимки, кроме `dashboard-empty.png`, — **viewport 1440×1000**, а не вся страница; нижние секции
на них не видны и описаны в тексте выше. Мобильные — **viewport 390×844**. Только `dashboard-empty.png` снят с
флагом `--full`.

| Файл | Разрешение | Что реально видно |
|---|---|---|
| `dashboard.png` | 1440×1000 | Верх дашборда: фильтр каналов, 4 KPI, вердикт и начало CAC-графика; остальные четыре графика ниже сгиба |
| `mobile-dashboard.png` | 390×844 | Мобильный верх дашборда: свёрнутое меню «Разделы», topbar, фильтр и первые две KPI-плитки |
| `channels.png` | 1440×1000 | Верх рейтинга: шапка и первые четыре строки (Instagram…Блогеры); колонка спарклайнов видна только узкой полосой у правого края, остальные строки ниже сгиба |
| `mobile-channels.png` | 390×844 | Мобильный верх каналов: заголовок, фильтры статуса/типа, «Экспорт CSV» и карточка «Веса рейтинга»; таблица рейтинга ниже, в снимок не попала |
| `channel.png` | 1440×1000 | Верх паспорта Instagram: topbar, карточки CAC/LTV/ROMI/Payback/LTV:CAC/расход/выручка и таблица целей; недельные графики, воронка, удержание и кампании ниже сгиба |
| `cohorts.png` | 1440×1000 | Верх когорт: переключатель горизонта, шапка heatmap и 11 строк матрицы; кривая LTV ниже сгиба |
| `mobile-cohorts.png` | 390×844 | Мобильные когорты: заголовок, горизонт 12 месяцев и срез матрицы (Когорта, Клиенты, 0, 1) |
| `attribution.png` | 1440×1000 | Верх атрибуции: переключатель моделей, три плитки итогов, сводка и начало grouped bars |
| `dashboard-empty.png` | 1440×2922 (full page) | Пустой дашборд с раскрытой первой таблицей данных; снят с `--full`, поэтому видны все пять виджетов |
| `focus.png` | 1440×1000 | Viewport после `focus` на `<summary>`: внизу видна рамка фокуса «Показать таблицу» |

Полный набор подтверждён на свежем процессе `npm start` после `npm run build`: пять экранов отдают свои острова
(5 / 2 / 3 / 1 / 1 фигур, 7 / 10 / 5 / 1 / 1 SVG), консоль пуста, страница не переполняется. Серверный журнал за
прогон не содержит записей уровня `warn` или `error`.
