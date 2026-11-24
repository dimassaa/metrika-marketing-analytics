# Производительность «Метрики»

Измерения на демонстрационном стенде, а не оценки «на глаз». Всё, что ниже, воспроизводится командами из раздела
«Как повторить»: планы снимает `scripts/explain-queries.js`, размеры бандлов считаются по Vite-манифесту, лимиты
запросов закреплены тестом `tests/integration/page-queries.test.js`.

## 1. Стенд измерения

| Компонент | Значение |
|---|---|
| PostgreSQL | 18.6 (локальный native-стенд) |
| Node.js | 26.13.0 (`engines.node >= 24`) |
| Данные | детерминированный сид «Зёрна», data anchor `2026-11-22` |
| Объём | каналы 8, кампании 32, `daily_stats` 12 691, клиенты 4 000, заказы 9 436, касания 14 062 |
| Режим | `BEGIN READ ONLY`, `statement_timeout = 30s`, один клиент, без прогрева кэша |

Планы снимаются на тех же репозиториях, что и страницы: скрипт подставляет `db`-прокси, который переписывает
одиночный `SELECT`/`WITH … SELECT` в `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` с теми же параметрами. SQL в скрипте
не копируется, поэтому план не может разойтись с запросом страницы. Любой не-`SELECT` (запись, DDL, несколько
выражений, `FOR UPDATE`) отклоняется до отправки в PostgreSQL; транзакция дополнительно read-only.

### Как повторить

```bash
npm run seed                                  # если БД ещё пустая
node scripts/explain-queries.js               # таблица по всем сценариям
node scripts/explain-queries.js --query cohorts
node scripts/explain-queries.js --json > /tmp/metrika-plans.json
```

`--query` принимает `dashboard`, `channels`, `cohorts`, `attribution`, `passport` или `all`; `--json` печатает полные
планы и исходный SQL. Скрипт использует `DATABASE_URL`, ничего не пишет и не требует прав суперпользователя.

## 2. Планы тяжёлых путей

Сценарии повторяют fan-out сервисов: `dashboard` — health report и недельный ряд; `channels` — health + измерение +
спарклайны; `cohorts` — размеры, маржа и измерение; `attribution` — заказы, касания, расход и измерение; `passport` —
карточка канала, воронка и кампании. Повтор одного и того же SQL внутри сценария показан в колонке «повторов».
`rows` — `Actual Rows` верхнего узла (строки результата, а не прочитанные страницы); миллисекунды — `Execution Time`
одного прогона, поэтому соседние значения вроде 0,4 и 0,6 — шум, а не разница планов.

| Запрос | Верхний узел | Доступ | rows | ms | Решение |
|---|---|---|---:|---:|---|
| CAC inputs | Sort | Bitmap Heap Scan `daily_stats` (`daily_stats_date_idx`); Index Only Scan `customers` (`customers_channel_first_order_idx`); Seq Scan `campaigns`, `channels` | 8 | 0,4–0,6 | оставить |
| cohort sizes | Aggregate | Seq Scan `customers`; Seq Scan `channels` | 112 | 2,7 | оставить |
| cohort margins | Aggregate | Seq Scan `orders`; Seq Scan `customers` | 695 | 21,0 | индекс отклонён, см. §4 |
| cohort channel dimension | Index Scan | `channels_code_key` | 8 | 0,02 | оставить |
| attribution orders | Sort | Bitmap Heap Scan `orders` (`orders_time_idx`); Seq Scan `customers` | 765 | 0,8 | оставить |
| attribution touchpoints | Sort | Bitmap Heap Scan `touchpoints` (`touchpoints_time_idx`) + `orders` (`orders_time_idx`) | 1 487 | 1,1 | оставить |
| channel spend | Sort | Bitmap Heap Scan `daily_stats` (`daily_stats_date_idx`); Seq Scan `campaigns`, `channels` | 8 | 0,35 | оставить |
| channel dimension | Sort | Seq Scan `channels`; Seq Scan `campaigns` | 8 | 0,06 | оставить |
| weekly CAC series | Sort | Index Only Scan `customers` (`customers_first_order_idx`); Bitmap Heap Scan `daily_stats` (`daily_stats_date_idx`) | 12 | 1,4 | оставить |
| weekly CAC sparklines | Sort | Bitmap Heap Scan `daily_stats` (`daily_stats_date_idx`); Index Only Scan `customers` (`customers_channel_first_order_idx`) | 96 | 1,5 | оставить |
| channel card lookup | Aggregate | Index Scan `channels_pkey`; Seq Scan `campaigns` | 1 | 0,02 | оставить |
| channel funnel | Nested Loop | Bitmap Heap Scan `daily_stats` (`daily_stats_date_idx`), `orders` (`orders_time_idx`), `customers` (`customers_channel_first_order_idx`) | 1 | 0,45 | оставить |
| channel campaigns | Limit | Index Scan `channels_pkey`; Seq Scan `campaigns`, `daily_stats` | 4 | 1,3 | оставить |
| campaign CAC inputs | Sort | Bitmap Heap Scan `customers` (`customers_first_order_idx`), `daily_stats` (`daily_stats_date_idx`); Seq Scan `campaigns` | 4 | 0,24 | оставить |

Seq Scan на `channels` (8 строк), `campaigns` (32 строки) и `customers` внутри агрегата по всем каналам — это
ожидаемый выбор планировщика, а не забытый индекс: таблицы измерения малы, а предикат не сужает их до нескольких строк.
Все оконные чтения фактов идут по существующим индексам `daily_stats_date_idx`, `orders_time_idx`,
`touchpoints_time_idx`, `customers_first_order_idx` и `customers_channel_first_order_idx` (миграции 001 и 004).

Самая дорогая строка — `cohort margins` ≈ 21 мс. Это один агрегат по всей истории клиентов с `count(DISTINCT …)`;
он остаётся одним запросом независимо от числа когорт, поэтому N+1 здесь нет.

## 3. Бюджеты запросов и N+1

Страница вызывает несколько сервисов, и без кэша чтения один и тот же список каналов мог бы читаться трижды. Кэш
`src/lib/request-cache.js` живёт один GET/HEAD-запрос; тест `tests/integration/page-queries.test.js` падает и на
превышении потолка, и на повторе statement с теми же параметрами внутри запроса.

| Маршрут | Потолок запросов |
|---|---:|
| `/app/dashboard` | 18 |
| `/app/channels` | 16 |
| `/app/channels/1` | 27 |
| `/app/cohorts` | 9 |
| `/app/attribution` | 8 |
| `/app/alerts` | 32 (первый GET пересчитывает окна) |
| `/app/scenarios` | 12 |
| `/api/v1/alerts` | 12 |
| `/api/v1/scenarios` | 12 |

Потолки не растут с числом каналов: агрегаты группируют в SQL, а не циклятся по строкам. Запись (`import`) в эти
бюджеты не входит и остаётся построчной по контракту задачи M2.

`/app/channels/1` — **27, а не 24**: прежняя цифра не учитывала `BEGIN`/`COMMIT` двух LTV-снапшотов. Измеренный
путь — 17 обычных statement плюс 2 × (`BEGIN` + три чтения + `COMMIT`) = 27; потолок закреплён
`tests/integration/page-queries.test.js` (11 тестов).

## 4. Индексы: не добавлены

Новая миграция `007` не нужна, кандидаты рассмотрены и отклонены:

- **`orders (customer_id, occurred_at)` уже существует** (`orders_customer_idx`, миграция 001). Планировщик всё равно
  выбирает Seq Scan для `cohort margins`, потому что диапазон когорт по умолчанию начинается с первого клиента:
  в соединение попадают все 4 000 клиентов и почти все 9 436 заказов. 4 000 index-lookup дороже одного
  последовательного чтения. Дублирующий индекс не изменил бы план, только запись.
- **`customers (first_order_at)` и `customers (first_channel_id, first_order_at)` уже покрывают** компанейский и
  канальный CAC; оба пути закреплены `tests/integration/metrics.performance.test.js`.
- **`touchpoints (customer_id, occurred_at)`** не даёт выигрыша на измеренном плане: окно уже сужается
  `touchpoints_time_idx`, а выборка клиентов приходит из подзапроса. На 14 тыс. касаний добавление индекса ухудшило бы
  запись без доказанного выигрыша. Пересмотреть при росте `touchpoints` на порядок и появлении плана с высоким
  `Rows Removed by Filter`.

Правило на будущее: индекс добавляется только при Seq Scan по растущей таблице и подтверждённом выигрыше на
реалистичном объёме; «на всякий случай» — нет.

## 5. Размеры бандлов

`npm run build`, gzip level 9. Вход — файл страницы, «страница» — вход плюс все импортируемые чанки (как в
`tests/integration/build-output.test.js`). Бюджеты: вход ≤ 210 KB, страница ≤ 250 KB gzip.

| Вход | Файл | raw, B | вход gzip, B | страница gzip, B |
|---|---|---:|---:|---:|
| dashboard | `dashboard-mLDo1IPl.js` | 7 351 | 2 547 | 221 737 |
| channels | `channels-CtgQHIBp.js` | 10 791 | 3 819 | 211 626 |
| channel passport | `channel-BmFswhkr.js` | 12 933 | 4 297 | 218 131 |
| cohorts | `cohorts-CdFoLmFJ.js` | 6 251 | 2 388 | 200 958 |
| attribution | `attribution-BPEAjPI_.js` | 6 751 | 2 615 | 208 678 |
| alerts | `alerts-BjJxW8tu.js` | 2 643 | 1 351 | 200 361 |
| scenarios | `scenarios-CQh-nZJH.js` | 15 618 | 5 134 | 222 675 |

Общие чанки:

| Чанк | raw, B | gzip, B |
|---|---:|---:|
| `chunks/ChartTooltip-aqaNQ0-l.js` (React + Recharts) | 642 056 | 191 467 |
| `chunks/BarChart-Df_jjEGN.js` | 27 352 | 9 439 |
| `chunks/Line-evtuY6_a.js` | 20 736 | 6 502 |
| `chunks/Scatter-6FvusTe7.js` | 14 629 | 5 356 |
| `chunks/Legend-DH-ygHn8.js` | 13 098 | 4 516 |
| `chunks/SpendRevenueBars-DvjLhH1r.js` | 1 164 | 691 |
| `chunks/CacRomiLines-DjTncJox.js` | 976 | 559 |
| `chunks/metrics-labels-DAlDOy1_.js` | 571 | 380 |
| `chunks/Kpi-DfZamzsn.js` | 422 | 261 |
| `chunks/LineChart-oikQb6u0.js` | 272 | 221 |
| `chunks/HealthBadge-oo31xU77.js` | 192 | 178 |

Страницы укладываются в бюджет с запасом 33–54 KB. Почти весь вес — общий React + Recharts чанк; его дальнейшая
оптимизация записана в `IMPROVEMENTS.md` и не входит в SEO-задачу. Приложение отдаёт эти файлы с `immutable` на год,
поэтому повторные визиты их не скачивают.

## 6. Политика кэша

| Путь | `Cache-Control` | Почему |
|---|---|---|
| `/assets/*` (хешированные острова) | `public, max-age=31536000, immutable` | имя файла меняется вместе с содержимым |
| `/css/app.css`, `/fonts/*`, `/img/*` | `public, max-age=0` + `ETag` | имя не хешировано, нужен 304 после деплоя |
| `/` и `/login` (HTML) | без долгого TTL | документ называет актуальный хеш бандла |
| `/app/*` | `no-store`, `X-Robots-Tag: noindex` | приватные данные и сессия |
| `/api/*` | `no-store`, `X-Robots-Tag: noindex` | ответ зависит от пользователя |
| `/health` | `no-store` | состояние стенда нельзя кэшировать |

Правило для reverse proxy: не добавлять `expires`/`immutable` к HTML и не переопределять `no-store` на `/app` и
`/api`. Регрессионный лок — `tests/integration/cache-headers.test.js`; он монтирует временную директорию с
хешированной фикстурой, поэтому проверяет `immutable` и на чистом клоне без `npm run build`.

## 7. Вывод

- Все пять сценариев укладываются в однозначные миллисекунды; самый дорогой запрос — 21 мс на 9,4 тыс. заказов.
- Ни один экран не делает запрос на строку результата; бюджеты и запрет дублей закреплены тестом.
- Новые индексы не добавлены: существующие покрывают все оконные чтения, а Seq Scan приходится на таблицы измерения
  или на агрегат, читающий почти всю историю by design.
- Бандлы в бюджете; общий React + Recharts чанк — известное ограничение, вынесенное в `IMPROVEMENTS.md`.
