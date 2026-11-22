# M3 «Движок метрик» — план реализации

> **Для агентов:** обязательный навык — `superpowers:subagent-driven-development` (рекомендуется) или
> `superpowers:executing-plans`. Задачи выполнять по порядку, шаги отмечать `- [x]`, коммит — в конце задачи.
>
> **Модель исполнителя и ревьюера:** `opencode-go/deepseek-v4.1-flash` (`AGENTS.md` §3). Другие модели не выбирать,
> даже если кажется, что они подходят лучше.

**Цель:** реализовать проверяемый движок метрик поверх данных M2: CAC по каналу/кампании/blended, когортный LTV
с горизонтами 3/6/12, три модели атрибуции с копеечно точным делением, ROMI/payback/LTV:CAC и health-статус,
рейтинг каналов с настраиваемыми весами, а также aggregation view-model для экранов M4 — дашборд, карточка канала
и цели. M3 не содержит HTTP-слоя: сервисы принимают `db`-репозитории и примитивы, возвращают view-model для M4.

**Архитектура:** `repositories → services/metrics → view-model`; Express, EJS и React в M3 не участвуют.
Сервисы не знают про `req`/`res`, не читают системные часы для периодов и не форматируют HTML. Все периоды
приходят явно (`from`, `to`), все горизонты считаются от `data anchor`, который передаёт вызывающий код
(M4 — из `getDataAnchor()`, тесты — фиксированной датой). Репозитории — только параметризованный SQL и маппинг,
деньги — `bigint` копеек до границы view-model.

**Стек:** Node 24 LTS, ESM, PostgreSQL 18 (`pg`), Vitest, существующие `money`, `dates`, `format`, `ids`.
Новых зависимостей нет.

**Спеки:** `docs/superpowers/specs/2026-11-21-metrics-spec.md` (§0–§5 — истина по формулам),
`docs/superpowers/specs/2026-11-21-marketing-analytics-design.md` (§6 BO-01…BO-06, BO-10, BO-13; §8, §11–§12),
`docs/superpowers/specs/2026-11-21-assignment-traceability.md`.

**Граница этапа:** M3 заканчивается на view-model и не подключает экраны. **M5: алерты, сценарии, оптимизация
бюджета — отдельный план.**

## Global Constraints

- Только JavaScript, ESM, без TypeScript; импорты с `.js`.
- Деньги — целые копейки. Внутри сервисов — `bigint`; `Number()` для денег запрещён. На границе view-model деньги
  отдаются **десятичной строкой копеек** (`'5000'`), потому что `JSON.stringify(BigInt)` бросает, а M4 передаёт
  view-model в `data-props`. Форматирование — только `formatCentsToByn`/`formatPercent`/`formatInteger`/
  `formatMonths`/`formatRatio`.
- Все SQL-суммы по `bigint` возвращаются как `sum(...)::bigint::text`; `coalesce(sum(...), 0)::bigint::text` при
  возможном NULL. `numeric`-строку (`'5000.00'`) в `centsFromDb` не передавать — она бросит `TypeError`.
  Идентификаторы из запросов и форм — только через `src/lib/ids.js` (`parseBigIntId`, `MAX_BIGINT_ID`); новых
  regex для id не писать.
- `null` — единственное представление «нет данных». `NaN`, `Infinity`, `-Infinity` не покидают сервис; каждое
  деление идёт через `src/lib/metrics-math.js`, а тесты проверяют `Number.isFinite` для всех чисел.
- Проценты и коэффициенты в view-model — `number`, округлённые только для показа (2 знака у процентов, 3 у
  коэффициентов). **Решения health принимаются до округления** по целым копейкам и cross-multiplication, иначе
  `12.004` месяца превращается в «healthy». Деньги округляются half-up только при возврате.
- Все периоды — календарные даты Minsk `YYYY-MM-DD`, `[from, to]` включительно. События — `timestamptz` UTC.
  Границы дней — `minskDayStart`/`minskDayEnd`; месяцы когорт — `AT TIME ZONE 'Europe/Minsk'`.
- `data anchor` — `MAX(daily_stats.stat_date)` через `referenceRepository.getDataAnchor()`; системные часы для
  периодов и горизонтов не используются. Тесты фиксируют anchor явно. `resolvePeriod` в `src/lib/periods.js` —
  единственное место расчёта 30/90/180 дней; M2-экспорт переиспользует его.
- Пороги, веса, горизонты, окна и сетки — только `src/config/metrics.js`. В сервисах нет литералов `1.2`, `3`,
  `12`, `30`, `0.30`; количество недель для дашборда — тоже из конфига.
- Один SQL-запрос на агрегат; N+1 запрещены. Списки каналов/кампаний агрегируются CTE или scalar subquery,
  а не запросом на строку. Каждый вызов сервиса имеет явный бюджет запросов (проверяется в T7).
- SQL только параметризованный. `audit_log` M3 не пишет: движок не меняет состояние.
- M3 не добавляет `src/routes`, `src/controllers`, `src/views`, `client/`, `public/css`. Если M4 нужен маленький
  API — он добавляется в M4, не здесь.
- RBAC: M3-сервисы прав не проверяют, это делает контроллер M4. Коды прав уже есть: `dashboard:view`,
  `channels:view`, `cohorts:view`, `attribution:view`, `goals:view`, `export`.
- Коммит в конце каждой задачи от имени владельца репозитория; формат `type: brief description`.

### Фактические интерфейсы M2, которые потребляет M3

```js
// src/lib/money.js
centsFromDb(value)      // string|number|bigint|null -> bigint|null; нецелое/мусор -> TypeError
parseBynToCents(input)  // '1 234,56'|'1234.56'|'50' -> bigint; отрицательное/3 знака -> ValidationError

// src/lib/format.js
formatCentsToByn(value)          // bigint|string|null -> '1 234,56' | '—'
formatPercent(value, { signed }) // '−8,1%' / '+12,4%'; null -> '—'
formatInteger(value)             // '12 345'; null -> '—'

// src/lib/dates.js
minskToday(now?)      // 'YYYY-MM-DD'
minskYesterday(now?)  // 'YYYY-MM-DD'
toDateOnly(date)      // Date|string|number -> 'YYYY-MM-DD' Minsk
addDays(date, n)      // 'YYYY-MM-DD'
startOfMonth(date)    // 'YYYY-MM-01'
isoWeekStart(date)    // Monday 'YYYY-MM-DD'
minskDayStart(date)   // Date 00:00:00.000 Minsk
minskDayEnd(date)     // Date 23:59:59.999 Minsk
formatDateRu(date)    // '20.11.2026'

// src/repositories/reference.repo.js
createReferenceRepository(db).getDataAnchor() // Promise<'YYYY-MM-DD'>; fallback minskToday()

// Существующие фабрики, переиспользуются без переименования
createChannelsRepository(db).listChannels({ onlyActive, kind }) // id, code, name, targetCacCents, targetRomiPct
createChannelsRepository(db).findChannelById(id)
createCampaignsRepository(db).listCampaigns({ channelId, status, search })
createGoalsRepository(db).listGoals({ channelId, metric })      // M4 сравнит план/факт
createGoalsRepository(db).findGoalById(id)

// tests/helpers/db.js
getTestPool(), resetTestDatabase(), closeTestPool()
// db/seed/seed.js
seed({ anchorDate }) // детерминированный сид; anchorDate фиксируется в тестах
```

`db` — пул или клиент с `query(text, params)`. Репозитории всегда фабрики `createXRepository(db)`, сервисы —
`createXService({ ... })`. Идентификаторы из `pg` — строки, деньги — только через `centsFromDb`.

### Решения, обязательные для M3

1. **CAC** — first-touch: новые клиенты по `customers.first_channel_id`/`first_campaign_id` и
   `first_order_at ∈ [minskDayStart(from), minskDayEnd(to)]`. Расход — `daily_stats.spend_cents` кампаний канала.
   Blended — суммы всех расходов / всех новых клиентов; смешивать расход одного канала с клиентами другого
   запрещено. Канал/кампания без строк статистики даёт `spendCents = 0n`, а не `undefined`.
2. **LTV** — margin-based: `orders.margin_cents`, не выручка. Когорта — месяц `first_order_at` в Minsk. В LTV(h)
   входят только `monthOffset < h`; в матрице ячейка `k` накопительно суммирует `monthOffset <= k`. В средние
   и в LTV:CAC попадают только завершённые когорты (`cohortStart + h месяцев <= anchor`); неполные показываются
   отдельно с `isComplete: false`.
3. **Канальный LTV** — не выводить начало окна из `anchor - horizon`. Репозиторий получает необязательный
   `fromCohortMonth`; сервис передаёт `null` и `toCohortMonth = startOfMonth(anchor)`, поэтому старые завершённые
   когорты учитываются. Верхняя граница месяца когорты — `((cohort_month + interval '1 month')::timestamp
   AT TIME ZONE 'Europe/Minsk')`, нижняя — `cohort_month::timestamp AT TIME ZONE 'Europe/Minsk'`.
4. **ROMI** — revenue-based: атрибутированная выручка минус расход. Это не маржа; LTV и ROMI нельзя складывать
   или выводить один из другого.
5. **Атрибуция** — окно 30 дней включительно; при отсутствии касаний в окне — `customers.first_channel_id`.
   `last_touch` по умолчанию. Доли линейной модели округляются так, чтобы `Σ attributed === revenue` каждой
   заявки, остаток — первым касаниям по времени; tie-break — `touchpoint.id`, сравниваемый как `BigInt`, а не
   лексикографически (`'10'` иначе окажется раньше `'9'`).
6. **Деления**: `new_customers = 0 → CAC null`; `spend = 0 → ROMI null` (не бесконечность); `LTV/CAC = null` если
   любой операнд null или знаменатель 0; `monthly_margin = 0 → payback null`; `old = 0 → Δ% null`.
   `NaN`/`Infinity` запрещены.
7. **Health** — `no_data` если хотя бы один из CAC/LTV12/ROMI/payback/ratio null; затем приоритет
   `risk → watch → healthy`. Решение принимается по целым копейкам: `romi < 0` ⇔ `revenue < spend`;
   `ratio < 1` ⇔ `ltv < cac`; `ratio < 3` ⇔ `ltv < 3*cac`; `payback > 12` ⇔
   `cac * H > 12 * ltv`; `payback > 18` ⇔ `cac * H > 18 * ltv`, где `H = BigInt(METRICS_CONFIG.ltv.monthsPerYear)`.
   Пороги из конфига, но сравнение — в `bigint`. `payback 12.004` — `watch`,
   `ratio 2.9996` — `watch`, `ROMI −0.004%` — `risk`. Округление — только в view-model.
8. **Бесплатные каналы** (email, SEO): `spend = 0`, клиенты есть → CAC `0n`, статус `free`, но ROMI `null` →
   health `no_data` по букве спеки §3.4. Это фиксируется в отчёте задачи и `IMPROVEMENTS.md`; менять правило
   без решения владельца нельзя.
9. **Data anchor и периоды** — explicit-параметр сервисов; `getDataAnchor()` вызывает M4 и тесты.
   `resolvePeriod({ anchor, from = null, to = null, days = 30 })` — единственное место расчёта периода,
   `days` включительно; явный `to` сохраняется, но `to > anchor` зажимается до anchor; `from > to` —
   `ValidationError`.
10. **Рейтинг** — нормализация только по каналам с `channelId != null`, прошедшим health; строка `blended`
    исключается, `no_data` исключается и не влияет на min/max. `max == min → norm = 1`; CAC инвертируется
    в **scored value** `cacScore = 1 - norm`, и в `contribution` идёт именно `cacScore`, а не `norm`. Веса
    нормируются к 1, отрицательные и нулевая сумма — `ValidationError`.
11. **Цели (`goals.target_value`)** — если M4 сравнивает план/факт по `cac`, значение читается через
    `parseBynToCents`, не через `Number()` (исключение зафиксировано в `IMPROVEMENTS.md`). Для `romi`,
    `ltv_cac`, `payback`, `new_customers` — число с единицей измерения из view-model, без `formatPercent`
    для месяцев.
12. **Форматы** — `formatMonths(value)` (месяцы, без хвостовых нулей) и `formatRatio(value, { decimals = 3 })`
    (коэффициент) живут в `src/lib/format.js`; `formatPercent` — только для процентов. View-model называет поля
    `paybackLabel`/`ratioLabel`/`targetLabel`, чтобы M4 не форматировал повторно.

## Review Focus

1. **Деление на ноль (zero divisors).** CAC при 0 клиентов, ROMI при 0 расходов, payback при 0 марже, Δ% при
   `old = 0`, нормализация при `max == min`. Проверяется в `tests/unit/metrics-math.test.js`,
   `tests/unit/cac.test.js`, `tests/unit/romi.test.js`, `tests/unit/ranking.test.js`; каждый результат —
   `null`, не `NaN`/`Infinity`.
2. **Незавершённые когорты (incomplete cohorts).** Когорта, у которой прошло меньше `h` месяцев, не попадает в
   средний LTV канала и в LTV:CAC, но видна в матрице с `isComplete: false`. LTV(h) суммирует только
   `monthOffset < h`; накопительная матрица — `<= k`. Проверяется в `tests/unit/ltv.test.js` (граница ровно
   `h` месяцев, маржа на offset 3 даёт LTV3 ≠ LTV12, две завершённые когорты с разной маржой) и в
   `tests/integration/metrics.services.test.js` (LTV12 канала не меняется от добавления свежей когорты).
3. **Утечка копеек в атрибуции (attribution cent leakage).** Линейное деление 10 000 c на 3 касания даёт
   3334/3333/3333, а не 3333.33; сумма по каждому заказу и по всей модели равна выручке. Проверяется в
   `tests/unit/attribution.test.js` (свойство на 200 детерминированных заказах, tie-break `'9'`/`'10'`) и в
   `tests/integration/metrics.services.test.js` (Σ revenue по каналам = Σ orders за период).
4. **Граница часового пояса (timezone boundary).** Заказ в `00:30` и `03:30` Minsk 1-го числа относится к новой
   когорте, а не к предыдущей; верхняя граница месяца — `((cohort_month + interval '1 month')::timestamp
   AT TIME ZONE 'Europe/Minsk')`. Периоды заказов и касаний строятся через `minskDayStart`/`minskDayEnd`, а не
   через `from::timestamp`. Проверяется в `tests/unit/ltv.test.js`, `tests/unit/attribution.test.js`,
   `tests/unit/dashboard.test.js` (недельные bucket'ы Mon–Sun) и `tests/integration/metrics.services.test.js`
   (заказ/касание на границе дня).

---

## Карта файлов M3

```
src/config/metrics.js                  src/lib/{metrics-math,periods}.js
src/repositories/{metrics,cohorts,attribution}.repo.js
src/services/metrics/{cac,ltv,attribution,romi,ranking,dashboard,channel-passport,goals-progress}.service.js
Modify: src/lib/{format,dates}.js; src/services/{export,goals}.service.js
db/migrations/004_m3_metrics_indexes.sql
tests/unit/{metrics-math,periods,format,dates,cac,ltv,attribution,romi,ranking,dashboard,channel-passport,goals-progress}.test.js
tests/integration/{metrics.services,metrics.performance}.test.js
tests/helpers/queryCounter.js, tests/fixtures/m3-golden.json
```

---

### Task 1: Математическое ядро, общий period resolver и CAC (BO-01; метрик-спека §0–§1)

**Files:**
- Create: `src/config/metrics.js`, `src/lib/metrics-math.js`, `src/lib/periods.js`,
  `src/repositories/metrics.repo.js`, `src/services/metrics/cac.service.js`
- Modify: `src/lib/format.js` (`formatMonths`, `formatRatio`), `src/services/export.service.js` (перейти на общий
  `resolvePeriod`), `src/services/goals.service.js` (импортировать `formatMonths`/`formatRatio`, удалить копии)
- Test: `tests/unit/metrics-math.test.js`, `tests/unit/periods.test.js`, `tests/unit/format.test.js`,
  `tests/unit/cac.test.js`; обновить `tests/integration/export.test.js` для зажима `to > anchor`

**Interfaces:**
- Consumes: `db`, `centsFromDb`, `formatCentsToByn`, `getDataAnchor`, `addDays`, `toDateOnly`,
  `minskDayStart`, `minskDayEnd`, `parseBigIntId`, `ValidationError`.
- Produces:
  - `METRICS_CONFIG` (frozen): `ltv.horizons [3,6,12]`, `ltv.defaultHorizon 12`, `ltv.monthsPerYear 12`,
    `attribution.{windowDays:30,models,defaultModel:'last_touch'}`, `health.{healthyRatio:3,watchRatio:1,
    healthyPaybackMax:12,watchPaybackMax:18,romiRiskBelow:0}`,
    `ranking.weights.{cac:.30,romi:.30,ltvCac:.25,newCustomers:.15}`,
    `periods.{defaultDays:30,options:[30,90,180]}`, `dashboard.{weeks:12}`.
  - `src/lib/metrics-math.js`:
    `centsToApi(cents: bigint|null): string|null` (decimal string of kopecks),
    `centsToBynDecimal(cents: bigint|null): string|null` (`'50.00'`, точка, для `NUMERIC`),
    `centsRatio(numerator: bigint, denominator: bigint, decimals=2): number|null` (ratio),
    `centsPercent(numerator: bigint, denominator: bigint, decimals=2): number|null` (percent),
    `normalizeBigInt(value: bigint, min: bigint, max: bigint): number`,
    `normalizeNumber(value: number, min: number, max: number): number`,
    `percentChange(current: number, previous: number): number|null`,
    `roundNumber(value: number, decimals: number): number|null`,
    `roundHalfUp(value: number): bigint`, `assertFinite(value, name): number`,
    `assertFiniteOrNull(value, name): number|null`.
  - `src/lib/periods.js`: `DEFAULT_PERIOD_DAYS = 30`;
    `resolvePeriod({ anchor, from = null, to = null, days = DEFAULT_PERIOD_DAYS }) ->
    { from, to, days }`. `days` — число календарных дней включительно; `resolvedTo = to ? min(to, anchor) :
    anchor`; `resolvedFrom = from ?? addDays(resolvedTo, -(days - 1))`; `from > to` — `ValidationError`;
    отсутствующий anchor — `ValidationError`; `days` — положительное целое.
  - `src/lib/format.js` добавляет:
    `formatMonths(value: number|string|null): string` (`12`, `12,5`, `—`),
    `formatRatio(value: number|string|null, { decimals = 3 } = {}): string` (`2,999`, `2,50` при
    `decimals: 2`, `—`).
  - `metricsRepo = createMetricsRepository(db)`:
    `listChannelCacInputs({ from, to }) -> Array<{channelId, channelCode, channelName, spendCents: bigint,
    newCustomers: number}>`; `listCampaignCacInputs({ from, to, channelId=null }) -> Array<{campaignId,
    channelId, campaignCode, campaignName, spendCents, newCustomers}>`; `totals({ from, to }) ->
    { spendCents: bigint, newCustomers: number }`; `listChannelSpend({ from, to })`.
  - `computeCac({ spendCents, newCustomers }) -> { cacCents: bigint|null, status: 'ok'|'free'|'no_data' }`.
  - `createCacService({ metricsRepository }) -> { getCacReport({ from, to, groupBy='channel' }) }`;
    view-model: `{ period, blended: {spendCents:'...', newCustomers, cacCents:'...'|null, cacLabel, status},
    rows: [{ key, channelId?, campaignId?, label, spendCents:'...', newCustomers, cacCents:'...'|null,
    cacLabel, status }] }`.

- [ ] **Step 1: Написать падающие тесты математики, периодов, форматов и CAC**

`tests/unit/metrics-math.test.js`: `centsRatio(500000n, 10000n, 2) === 50`; `centsRatio(1n, 3n, 2) === 0.33`;
`centsRatio(-1n, 3n, 2) === -0.33`; `centsRatio(1n, 0n) === null`; `centsPercent(50000n, 100000n) === 50`;
`centsToBynDecimal(5000n) === '50.00'`; `normalizeBigInt(5n, 5n, 5n) === 1`;
`normalizeBigInt(5n, 5n, 15n) === 0`; `normalizeNumber(7, 5, 15) === 0.2`;
`percentChange(120, 0) === null`; `percentChange(80, 100) === -20`; `centsToApi(null) === null`;
`roundHalfUp(2.5) === 3n`; `roundNumber(2.9996, 3) === 3`; `assertFinite(NaN)` бросает `TypeError`.

`tests/unit/periods.test.js`: `resolvePeriod({ anchor: '2026-11-22' })` →
`{ from: '2026-10-24', to: '2026-11-22', days: 30 }`; `days: 90` и `days: 180` дают ровно 90/180 включительных
дней (`addDays(from, days - 1) === to`); явные `from`/`to` сохраняются; `to: '2026-12-01'` при anchor
`'2026-11-22'` зажимается до `'2026-11-22'`; `from: '2026-11-23'` → `ValidationError`; отсутствующий anchor →
`ValidationError`; `days: 0` → `ValidationError`. Тот же модуль используется `export.service`, поэтому
`tests/integration/export.test.js` проверяет, что `?to=` в будущем больше не выходит за anchor.

`tests/unit/format.test.js`: `formatMonths(12) === '12'`; `formatMonths(12.5) === '12,5'`;
`formatMonths('12.50') === '12,5'`; `formatMonths(null) === '—'`; `formatRatio(2.9996) === '3,000'`;
`formatRatio(2.5, { decimals: 2 }) === '2,50'`; `formatRatio(null) === '—'`; `formatPercent` не используется для
месяцев и коэффициентов.

`tests/unit/cac.test.js`: 4 200,00 BYN / 84 = 50,00 BYN (`420000n`, `84` → `5000n`, `ok`);
`newCustomers: 0` → `{cacCents: null, status: 'no_data'}`; `spendCents: 0n, newCustomers: 5` →
`{cacCents: 0n, status: 'free'}`; оба нуля → `no_data`; blended 900 000 c / 180 = 5 000 c; кампания не смешивает
клиентов другого канала; канал без строк `daily_stats` → `spendCents: 0n`, не `null`; ни в одном поле нет
`NaN`/`Infinity`.

- [ ] **Step 2: Запустить тесты и убедиться в падении**

Run: `npx vitest run tests/unit/metrics-math.test.js tests/unit/periods.test.js tests/unit/format.test.js tests/unit/cac.test.js`
Expected: FAIL — модули отсутствуют.

- [ ] **Step 3: Реализовать конфиг, математику, периоды, репозиторий и сервис**

`centsRatio` считать в `bigint` от модуля числителя: `(|num| * 10n**BigInt(decimals) * 2n + den) / (2n * den)`
с восстановлением знака — half-up away from zero без float. `centsPercent` — тот же расчёт с `num * 100n`;
`centsToBynDecimal` — целая часть и две цифры копеек через точку. `normalizeBigInt`/`normalizeNumber` — тот же
приём; `max == min` возвращает `1`. `roundNumber` — только для view-model, не для health.

`resolvePeriod` реализовать ровно по контракту: `days` включительно, явный `to` не терять, но зажимать по
anchor; `from` без `to` идёт до anchor. M2-экспорт удаляет локальный `resolvePeriod` и `DEFAULT_PERIOD_DAYS`,
импортирует общий; поведение `?from=` без `?to=` сохраняется.

`formatMonths`/`formatRatio` перенести в `src/lib/format.js`; `goals.service.js` импортирует их вместо локальных
копий. `formatRatio` принимает `decimals`, по умолчанию 3; `goals` передаёт `{ decimals: 2 }`.

В `listChannelCacInputs` не соединять `daily_stats` и `customers` одним JOIN (будет декартово произведение):
два CTE — `spend` и `customers` — `FULL JOIN channels` либо `LEFT JOIN` на каждый CTE. Период:
`ds.stat_date BETWEEN $1::date AND $2::date`; клиенты: `first_order_at >= minskDayStart(from)` и
`<= minskDayEnd(to)`. Расход во всех трёх запросах — channel, campaign и totals:
`coalesce(sum(ds.spend_cents), 0)::bigint::text`; клиенты: `count(*)::int`.
`channelId` фильтра — `parseBigIntId` до SQL; иначе `ValidationError`. Сервис переводит `bigint` в строки через
`centsToApi`; `cacLabel` — `formatCentsToByn`. `status` free — только при `spendCents === 0n` и
`newCustomers > 0`.

- [ ] **Step 4: Прогнать тесты и закоммитить**

Run: `npx vitest run tests/unit/metrics-math.test.js tests/unit/periods.test.js tests/unit/format.test.js tests/unit/cac.test.js tests/integration/export.test.js`
Expected: PASS.

Commit: `feat: add metrics math, shared period resolver and cac engine`

---

### Task 2: Когорты и LTV (BO-02, BO-06; метрик-спека §2, §5)

**Files:**
- Create: `src/repositories/cohorts.repo.js`, `src/services/metrics/ltv.service.js`
- Modify: `src/lib/dates.js` (`addMonths`)
- Test: `tests/unit/ltv.test.js`, `tests/unit/dates.test.js` (дополнить `addMonths`)

**Interfaces:**
- Consumes: `db`, `centsFromDb`, `startOfMonth`, `addMonths`, `minskDayStart`, `getDataAnchor`,
  `METRICS_CONFIG`.
- Produces:
  - `addMonths(date: string, months: number): string` — календарный сдвиг; конец месяца clamp-ится
    (`2026-01-31 + 1 → 2026-02-28`).
  - `cohortsRepo = createCohortsRepository(db)`:
    `listCohortSizes({ fromCohortMonth = null, toCohortMonth, channelId = null }) -> Array<{cohortMonth,
    channelId, channelCode, cohortSize}>`; `listCohortMonthlyMargins({ fromCohortMonth = null, toCohortMonth,
    channelId = null }) -> Array<{cohortMonth, channelId, monthOffset, marginCents: bigint,
    activeCustomers: number}>`.
    `fromCohortMonth = null` означает «без нижней границы»; условие `($1::date IS NULL OR cohort_month >=
    $1::date)`.
  - `computeCohortLtv({ cohort, marginsByOffset, horizonMonths, anchor }) -> { ltvCents: bigint|null,
    isComplete, monthsObserved }`. `ltvCents` — сумма только `monthOffset < horizonMonths`; `isComplete` —
    `addMonths(cohortMonth, horizonMonths) <= anchor`.
  - `createLtvService({ cohortsRepository }) -> { getCohortMatrix({ anchor, horizonMonths=12,
    fromCohortMonth = null, toCohortMonth, channelId=null }), getChannelLtv({ anchor, horizonMonths=12 }) ->
    { rows: [...], blended: {ltvCents, customerCount, cohortCount, status} } }`.
    `getChannelLtv` не вычисляет `from = anchor - horizon`: передаёт `fromCohortMonth = null`,
    `toCohortMonth = startOfMonth(anchor)`.
    View-model: `{ horizonMonths, anchor, cohorts:[{cohortMonth, cohortLabel, cohortSize, ltvCents:'...'|null,
    ltvLabel, isComplete, monthsObserved, cells:[{monthOffset, retentionPct:number|null,
    cumLtvCents:'...'|null}]}], channelLtv:[{channelId, channelCode, ltvCents:'...'|null, customerCount,
    cohortCount, status:'ok'|'insufficient_history'}], excludedIncomplete: [...] }`.

- [ ] **Step 1: Написать падающие тесты LTV и `addMonths`**

`tests/unit/dates.test.js`: `addMonths('2026-01-31', 1) === '2026-02-28'`; `addMonths('2026-01-01', 12) ===
'2027-01-01'`; `addMonths('2026-11-30', -2) === '2026-09-30'`.

`tests/unit/ltv.test.js` (ручные фикстуры, без БД):
- когорта 2026-01, 120 клиентов, суммарная маржа 1 440 000 c (1 140 000 c на offsets 0–2 и 300 000 c на
  offset 3), anchor 2027-01-20, h=12 → `ltvCents === 12000n`, `isComplete === true`;
- при h=3 сумма 1 140 000 c → `LTV3 === 9500n`, `LTV3 ≠ LTV12`; offset 3 не входит в LTV3, но входит в LTV12;
  матрица `cumLtv` на `k = 3` включает offset 3;
- anchor 2026-12-31 при h=12 → `isComplete === false`, когорта не входит в `getChannelLtv`;
- `N = 0` → когорта отсутствует; ровно `anchor === cohortStart + 12 месяцев` → `isComplete === true`;
- две завершённые когорты с разной маржой (2025-06: 600 000 c / 100 = 6 000 c; 2026-01: 1 440 000 c / 120 =
  12 000 c) → канальный LTV = взвешенное среднее, а не только последняя когорта; `fromCohortMonth = null`
  обязателен, иначе старая когорта теряется;
- пустая история → `ltvCents: null`, `status: 'insufficient_history'`; горизонты 3/6/12 независимы;
  retention 1-го месяца = 60/120*100 = 50; нет `NaN`.

- [ ] **Step 2: Запустить и убедиться в падении**

Run: `npx vitest run tests/unit/dates.test.js tests/unit/ltv.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать `addMonths`, репозиторий и сервис**

SQL-когорты одним CTE:
```sql
WITH cohort AS (
  SELECT c.id, c.first_channel_id,
         date_trunc('month', c.first_order_at AT TIME ZONE 'Europe/Minsk')::date AS cohort_month
    FROM customers c
   WHERE c.first_order_at IS NOT NULL
     AND ($1::date IS NULL OR
          date_trunc('month', c.first_order_at AT TIME ZONE 'Europe/Minsk')::date >= $1::date)
     AND date_trunc('month', c.first_order_at AT TIME ZONE 'Europe/Minsk')::date <= $2::date
)
SELECT cohort_month, first_channel_id, count(*)::int AS cohort_size
  FROM cohort GROUP BY 1, 2;
-- второй CTE: GROUP BY cohort_month, first_channel_id, monthOffset;
-- count(DISTINCT o.customer_id)::int AS active_customers,
-- sum(o.margin_cents)::bigint::text AS margin_cents
```
`monthOffset` считать как `(date_part('year', o.occurred_at AT TIME ZONE 'Europe/Minsk') -
date_part('year', cohort_month)) * 12 + (date_part('month', ...) - date_part('month', cohort_month))`.
Заказы ограничить **обеими** границами месяца в Minsk:
```sql
o.occurred_at >= (cohort_month::timestamp AT TIME ZONE 'Europe/Minsk')
AND o.occurred_at < ((cohort_month + interval '1 month')::timestamp AT TIME ZONE 'Europe/Minsk')
```
Верхняя граница — именно `timestamptz`-выражение, не `cohort_month + interval '1 month'` (иначе `00:30` Minsk
1-го числа уедет в прошлую когорту). Тест: заказы `2026-02-01T00:30+03:00` и `2026-02-01T03:30+03:00` входят в
когорту `2026-02`, не в `2026-01`; заказ `2026-01-31T23:59+03:00` — в `2026-01`.

Репозиторий делает два запроса (размеры и margin), сервис складывает их в память — без запроса на когорту.
Канальный LTV — `Σ margin / Σ N` по завершённым; неполные — только в матрице.
`retentionPct = activeCustomers / N * 100`, `cumLtv` — из тех же `marginsByOffset` по `monthOffset <= k`;
пустая ячейка — `null`, не 0. `sum(...)::bigint::text`, затем `centsFromDb`.

- [ ] **Step 4: Прогнать тесты и закоммитить**

Run: `npx vitest run tests/unit/dates.test.js tests/unit/ltv.test.js`
Expected: PASS.

Commit: `feat: add cohort ltv with completed and incomplete horizons`

---

### Task 3: Атрибуция first/last/linear (BO-03, BO-05; метрик-спека §3.1)

**Files:**
- Create: `src/repositories/attribution.repo.js`, `src/services/metrics/attribution.service.js`
- Test: `tests/unit/attribution.test.js`

**Interfaces:**
- Consumes: `db`, `centsFromDb`, `minskDayStart`, `minskDayEnd`, `addDays`, `isoWeekStart`, `toDateOnly`,
  `METRICS_CONFIG`, `metricsRepository.listChannelSpend`, `channelsRepository.listChannels`, `parseBigIntId`.
- Produces:
  - `attributionRepo = createAttributionRepository(db)`:
    `listOrdersInPeriod({ from, to }) -> Array<{orderId, customerId, firstChannelId, occurredAt: Date,
    revenueCents: bigint}>`; `listTouchpointsForOrders({ from, to }) -> Array<{touchpointId, customerId,
    channelId, occurredAt: Date}>`.
    `listOrdersInPeriod` фильтрует `o.occurred_at >= minskDayStart(from) AND o.occurred_at <=
    minskDayEnd(to)` — явно, не `$1::timestamp`.
  - `attributeOrders({ orders, touchpoints, model, windowDays = METRICS_CONFIG.attribution.windowDays }) ->
    Array<{orderId, channelId, amountCents: bigint}>`.
  - `createAttributionService({ attributionRepository, metricsRepository, channelsRepository }) ->
    { getAttributionReport({ from, to, models=['last_touch','first_touch','linear'] }),
    getAttributionSeries({ from, to, model='last_touch', channelId=null }) }`.
    View-model отчёта: `{ period, models: { [model]: { revenueByChannel:[{channelId, channelCode,
    revenueCents:'...', romiPct:number|null}], totalRevenueCents:'...', totalAttributedCents:'...' } },
    comparison:[{channelId, channelCode, lastTouchCents:'...', firstTouchCents:'...', linearCents:'...',
    deltaVsDefaultCents:'...', deltaVsDefaultPct:number|null}] }`. `totalAttributedCents` — контроль инварианта
    и поле golden numbers. `getAttributionSeries` — `Array<{weekStart, revenueCents:'...'}>` по неделям
    Mon–Sun для дашборда и карточки канала; пустая неделя не выдумывается, потребитель подставляет `0n`.

- [ ] **Step 1: Написать падающие тесты атрибуции**

`tests/unit/attribution.test.js`: заказ 10 000 c, 3 касания → `3334n/3333n/3333n`; 10 001 c, 2 касания →
`5001n/5000n`; первый/последний — вся сумма одному каналу; нет касаний → `firstChannelId`; касание ровно за
30 дней включено, за 30 дней + 1 мс — нет; касание другого клиента не участвует; заказ с 0 c не создаёт
отрицательных долей; tie-break касаний `'10'` и `'9'` с одинаковым временем сортирует как `BigInt`, а не
строкой (id 9 раньше id 10); на 200 детерминированных заказах сумма `amountCents` по каждому `orderId` равна
`revenueCents` и по модели равна общей выручке; `totalAttributedCents === totalRevenueCents`; `spend = 0` →
ROMI `null`; `getAttributionSeries` по неделям суммируется в `totalAttributedCents`, `weekStart` — понедельник,
фильтр `channelId` не теряет копейки; ни одного `NaN`.

- [ ] **Step 2: Запустить и убедиться в падении**

Run: `npx vitest run tests/unit/attribution.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать репозиторий и сервис**

`listOrdersInPeriod` возвращает `o.id::text`, `o.customer_id::text`, `c.first_channel_id::text`,
`o.occurred_at`, `o.revenue_cents::bigint::text`, с явными `minskDayStart(from)`/`minskDayEnd(to)`.
`listTouchpointsForOrders` — один запрос с
`t.occurred_at BETWEEN minskDayStart(addDays(from, -METRICS_CONFIG.attribution.windowDays)) AND minskDayEnd(to)` и
`EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = t.customer_id AND o.occurred_at >= minskDayStart($1)
AND o.occurred_at <= minskDayEnd($2))`; это использует `orders_customer_idx` и не тянет касания клиентов без
заказов. Сдвиг начала окна — из `METRICS_CONFIG.attribution.windowDays`, не литерал.

В сервисе касания сгруппировать по `customerId`, для каждого заказа отфильтровать
`[orderAt - windowDays*DAY_MS, orderAt]`, отсортировать `(occurredAt, BigInt(touchpointId))`.
Linear: `base = revenue / BigInt(n)`, `remainder = revenue % BigInt(n)`, первые `Number(remainder)` касаний
получают `base + 1n`. Агрегировать по каналу; `totalRevenueCents` — сумма заказов, `totalAttributedCents` —
сумма распределённых долей (инвариант). Сравнение — относительно `last_touch`; `deltaVsDefaultPct` через
`percentChange`. `getAttributionSeries` переиспользует те же `orders`/`touchpoints` и `attributeOrders`, затем
группирует `orderId -> weekStart = isoWeekStart(toDateOnly(occurredAt))` и суммирует доли; фильтр `channelId`
применяется после распределения, поэтому сумма ряда равна сумме по каналу. Все суммы из SQL — `::bigint::text`.

- [ ] **Step 4: Прогнать тесты и закоммитить**

Run: `npx vitest run tests/unit/attribution.test.js`
Expected: PASS.

Commit: `feat: add cent-exact first last and linear attribution`

---

### Task 4: ROMI, payback, LTV:CAC и health (BO-03; метрик-спека §3.2–§3.4)

**Files:**
- Create: `src/services/metrics/romi.service.js`
- Test: `tests/unit/romi.test.js`

**Interfaces:**
- Consumes: outputs T1–T3, `METRICS_CONFIG`, `centsRatio`, `centsPercent`, `roundNumber`, `formatMonths`,
  `formatRatio`, `assertFiniteOrNull`, `channelsRepository.listChannels`.
- Produces:
  - `computeRomi({ revenueCents, spendCents }) -> number|null` — процент с запасом точности (4 знака), чтобы
    `−0.004%` не стал нулём; `computePayback({ cacCents, ltv12Cents }) -> number|null` — месяцы с запасом
    точности (6 знаков); `computeLtvCac({ ltv12Cents, cacCents }) -> number|null` — коэффициент с запасом
    точности (6 знаков). Health эти округлённые значения не использует;
    `deriveHealth({ cacCents, ltv12Cents, revenueCents, spendCents }) ->
    'healthy'|'watch'|'risk'|'no_data'`.
  - `createChannelHealthService({ cacService, ltvService, attributionService, channelsRepository }) ->
    { getChannelHealthReport({ from, to, anchor, attributionModel='last_touch' }) }`.
    Row: `{channelId, code, name, spendCents:'...', revenueCents:'...', newCustomers, cacCents:'...'|null,
    cacLabel, ltv12Cents:'...'|null, ltvLabel, romiPct:number|null, romiLabel, paybackMonths:number|null,
    paybackLabel, ltvCacRatio:number|null, ratioLabel, status, statusLabel}`; `blended` — та же форма.
    `paybackLabel` — `formatMonths` + «мес.», `ratioLabel` — `formatRatio`, `romiLabel` — `formatPercent`.

- [ ] **Step 1: Написать падающие тесты формул и порогов**

`tests/unit/romi.test.js`: `(150000-100000)/100000*100 === 50`; `spend 0 → null`; `revenue 0, spend 100000 →
-100`; payback `CAC 5000, LTV12 12000 → 5`; LTV null / CAC null / monthly 0 → null; ratio `36000/10000 → 3.6`;
`payback 12.004` (CAC 12 004 c, LTV12 12 000 c) → `watch`, не healthy; `ratio 2.9996` (LTV 29 996 c, CAC
10 000 c) → `watch`; `ratio 3.0` и `payback 12` → `healthy`; `ratio 1.0` → `watch`; `ratio 0.999` → `risk`;
`payback 18` → `watch`, `18.0001` → `risk`; ROMI `−0.004%` (revenue 99 996 c, spend 100 000 c) → `risk`;
любой null или `spend = 0` → `no_data`; приоритет `no_data → risk → watch → healthy`;
`statusLabel`: «В норме»/«Наблюдать»/«Риск»/«Мало данных»; в view-model `romiPct` — 2 знака,
`ltvCacRatio` — 3, а health-статус на границах остаётся `watch`/`risk`; `paybackLabel` использует
`formatMonths`, не `formatPercent`; нет `NaN`.

- [ ] **Step 2: Запустить и убедиться в падении**

Run: `npx vitest run tests/unit/romi.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать формулы и сборку health-отчёта**

ROMI считать через `centsPercent(revenue - spend, spend, 4)`; payback — `centsRatio(cacCents * H, ltv12Cents,
6)`, где `H = BigInt(METRICS_CONFIG.ltv.monthsPerYear)`; ratio — `centsRatio(ltv12Cents, cacCents, 6)`. Это
запас точности, а не округление для показа: `12.004` и `2.9996` сохраняются. Округление до 2/3 знаков — только
при сборке view-model через `roundNumber`; `status` считается **до** него.

`deriveHealth` не делит и не сравнивает округлённые числа. Сначала `no_data`, если `cacCents`, `ltv12Cents`,
`revenueCents` или `spendCents` null, либо `spendCents === 0n` (ROMI не определён). Затем `risk`, если
`revenueCents < spendCents` (ROMI < 0), либо `cacCents > 0n && ltv12Cents < cacCents` (ratio < 1), либо
`cacCents * H > BigInt(METRICS_CONFIG.health.watchPaybackMax) * ltv12Cents` (payback > 18). Затем `watch`,
если `cacCents > 0n && ltv12Cents < BigInt(METRICS_CONFIG.health.healthyRatio) * cacCents` (ratio < 3), либо
`cacCents * H > BigInt(METRICS_CONFIG.health.healthyPaybackMax) * ltv12Cents` (payback > 12). Иначе
`healthy`. Так `12.004` месяца и `2.9996` не проскакивают в healthy из-за округления.

Строки view-model T1/T2/T3 возвращать в `bigint` через `centsFromDb`, не `Number()`. `spend = 0` и
`newCustomers = 0` не дают Infinity. Бесплатный канал: CAC `0n`, ROMI null → `no_data` (см. решение 7). Сервис
вызывает T1/T2/T3 по одному разу и соединяет по `channelId`; отсутствующий канал в T3 получает `0n` выручки,
но не маскирует `null` LTV. `blended` не участвует в рейтинге, но в health-отчёте присутствует.

- [ ] **Step 4: Прогнать тесты и закоммитить**

Run: `npx vitest run tests/unit/romi.test.js`
Expected: PASS.

Commit: `feat: add romi payback and channel health status`

---

### Task 5: Рейтинг каналов с весами (BO-04; метрик-спека §4)

**Files:**
- Create: `src/services/metrics/ranking.service.js`
- Test: `tests/unit/ranking.test.js`

**Interfaces:**
- Consumes: `getChannelHealthReport`, `METRICS_CONFIG.ranking.weights`, `normalizeBigInt`,
  `normalizeNumber`, `ValidationError`.
- Produces:
  - `normalizeWeights(weights) -> {cac, romi, ltvCac, newCustomers}` (sum = 1).
  - `computeRanking({ channels, weights }) -> { weights, ranked:[{channelId, code, name, score:number,
    rank:number, contributions:[{criterion, weight, rawValue, normalized:number, contribution:number}]}],
    excluded:[{channelId, code, reason:'no_data'|'missing_criterion'|'blended'}] }`.
  - `createRankingService({ healthService }) -> { getRankingReport({ from, to, anchor, weights }) }`.

- [ ] **Step 1: Написать падающие тесты рейтинга**

`tests/unit/ranking.test.js`: веса по умолчанию суммируются в 1; `weights: {cac:-0.1,...}` → `ValidationError`;
все нули → `ValidationError`; `{cac:2,romi:2,ltvCac:1,newCustomers:1}` нормируются в
`0.333/0.333/0.167/0.167`; два канала с одинаковым CAC и `max == min` → `normalized === 1`, `cacScore === 0`;
два канала с CAC 100 и 200 (при равных остальных) → дешёвый получает `cacScore 1`, дорогой `0`, дешёвый
раньше; строка `blended` без `channelId` попадает в `excluded` с `reason: 'blended'` и не влияет на min/max;
`no_data` исключён и не влияет на min/max; один канал → score считается, rank 1; `Σ contributions === score`
с точностью 0.01; равные score сортируются по `code`; пустой список → `ranked: []`, без исключения; нет `NaN`.

- [ ] **Step 2: Запустить и убедиться в падении**

Run: `npx vitest run tests/unit/ranking.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать нормализацию и сборку рейтинга**

Сначала отфильтровать `channelId != null` и `status !== 'no_data'`; по каждому критерию взять min/max только по
оставшимся. CAC: `norm = normalizeBigInt(centsFromDb(cacCents), min, max)`, **scored value**
`cacScore = 1 - norm`; ROMI/ratio/новые клиенты — `scored = normalizeNumber`. В `contribution` и в `score` идёт
`scored`, не `norm`; иначе рейтинг вознаграждает дорогой канал. `contribution = 100 * weight * scored`;
`score = sum(contributions)`, округлить до 2 для view-model. В `contributions[].normalized` для CAC лежит
именно `cacScore`, чтобы стек-бар объяснял contribution; `rawValue` — строка копеек или число; `0` не подменять
на null. Если критерий у канала null (не должно случаться после health, кроме free-каналов, которые уже
`no_data`), канал исключается с `reason: 'missing_criterion'`, а не получает 0.

- [ ] **Step 4: Прогнать тесты и закоммитить**

Run: `npx vitest run tests/unit/ranking.test.js`
Expected: PASS.

Commit: `feat: add explainable channel ranking with configurable weights`

---

### Task 6: Aggregation view-model для M4 — дашборд, карточка канала, цели (BO-10, BO-13; дизайн §8)

**Files:**
- Create: `src/services/metrics/dashboard.service.js`,
  `src/services/metrics/channel-passport.service.js`, `src/services/metrics/goals-progress.service.js`
- Modify: `src/repositories/metrics.repo.js` (`listWeeklySeries`, `getChannelFunnel`)
- Test: `tests/unit/dashboard.test.js`, `tests/unit/channel-passport.test.js`,
  `tests/unit/goals-progress.test.js`

**Interfaces:**
- Consumes: `healthService.getChannelHealthReport`, `attributionService.getAttributionSeries`, `metricsRepository`,
  `channelsRepository`, `campaignsRepository.listCampaigns`, `goalsRepository.listGoals`, `resolvePeriod`, `addDays`,
  `isoWeekStart`, `METRICS_CONFIG`, `parseBynToCents`, `formatCentsToByn`, `formatPercent`, `formatInteger`,
  `formatDateRu`, `formatMonths`, `formatRatio`, `computeCac`, `computeRomi`, `centsToApi`, `roundNumber`,
  `NotFoundError`.
- Produces:
  - `metricsRepo.listWeeklySeries({ from, to, channelIds = null }) -> Array<{weekStart, spendCents: bigint,
    newCustomers: number}>` — только полные недели Mon–Sun, попавшие в `[from, to]`; `weekStart` —
    `date_trunc('week', stat_date)::date`; новые клиенты — `first_order_at` в
    `[minskDayStart(weekStart), minskDayEnd(weekStart + 6)]`.
  - `metricsRepo.getChannelFunnel({ from, to, channelId }) -> { impressions, clicks, leads, newCustomers,
    orders }` — целые числа, `channelId` уже проверен `parseBigIntId`.
  - `createDashboardService({ healthService, metricsRepository, attributionService }) ->
    { getDashboardSummary({ anchor, from, to, weeks = METRICS_CONFIG.dashboard.weeks }) }`. View-model:
    `{ period: { from, to, days, anchor },
       kpis: { spendCents:'...', spendLabel, newCustomers, newCustomersLabel, cacCents:'...'|null, cacLabel,
               romiPct:number|null, romiLabel },
       weeklySeries: [{ weekStart, weekLabel, spendCents:'...', newCustomers, cacCents:'...'|null,
                        romiPct:number|null }],
       verdict: { status:'healthy'|'watch'|'risk'|'no_data', label, reason } }`.
    KPI и verdict берутся из `blended` строки одного `getChannelHealthReport`; `reason` — короткая русская
    фраза по статусу, без новых порогов. KPI считаются за `[from, to]`, а `weeklySeries` покрывает последние
    `weeks` полных ISO-недель, заканчивающихся не позже `to`; неполная неделя отбрасывается.
  - `createChannelPassportService({ healthService, metricsRepository, attributionService, channelsRepository,
    campaignsRepository }) -> { getChannelPassport({ anchor, channelId, from, to }) }`. View-model:
    `{ channel: { id, code, name, kind, targetCacCents:'...'|null, targetRomiPct:number|null },
       period, health: { ...healthRow }, series: [{ weekStart, weekLabel, spendCents:'...', newCustomers,
       cacCents:'...'|null, romiPct:number|null }],
       funnel: { impressions, clicks, leads, newCustomers, orders },
       campaigns: [{ id, code, name, status, spendCents:'...', newCustomers, cacCents:'...'|null }] }`.
    Неизвестный `channelId` → `NotFoundError`; `channelId` проверяется `parseBigIntId` до SQL.
  - `createGoalsProgressService({ goalsRepository, healthService }) -> { getGoalsProgress({ anchor, from, to,
    metric = null }) }`. Один вызов `getChannelHealthReport` на весь список целей, без N+1. View-model:
    `{ period, rows: [{ goalId, metric, metricLabel, channelId, channelLabel,
       goalPeriod: { from, to }, factPeriod: { from, to },
       target: { value: string|number, unit:'cents'|'percent'|'ratio'|'months'|'count', label },
       fact: { value: string|number|null, unit: same, label },
       deviation: { abs: string|number|null, pct: number|null, label },
       direction: 'lower_is_better'|'higher_is_better',
       status: 'on_track'|'off_track'|'no_data' }] }`.
    `getGoalsProgress` вызывается для одного отчётного периода и включает только цели, чей
    `[periodStart, periodEnd]` **совпадает** с `[from, to]`: иначе план и факт относятся к разным интервалам и
    сравнение нечестное. Для `cac` target читается `parseBynToCents` и отдаётся строкой копеек (`value: '5000'`,
    `unit: 'cents'`); `romi` — проценты; `ltv_cac` — коэффициент; `payback` — месяцы; `new_customers` — целое.
    `deviation.abs` для денег — строка копеек, для остальных — число. Цель без факта за период получает
    `status: 'no_data'` и `fact: null`.

- [ ] **Step 1: Написать падающие unit-тесты view-model**

`tests/unit/dashboard.test.js`: KPI совпадают с `blended` health-строкой; `weeklySeries` начинается с
понедельника, не содержит неполной недели и сортирован по `weekStart`; при `spend = 0` `cacCents`/`romiPct` —
`null`, не `NaN`; `verdict.status` равен health-статусу blended; `JSON.stringify(viewModel)` не бросает и не
содержит `bigint`; пустые данные → `no_data` и пустой ряд без исключения.

`tests/unit/channel-passport.test.js`: серия содержит только запрошенный канал; `funnel` сохраняет порядок
этапов и целые числа; кампании приходят одним списком, без запроса на кампанию; `targetCacCents` — строка
копеек; неизвестный `channelId` → `NotFoundError`; `'abc'`/`'0'` → `NotFoundError`/`ValidationError` без SQL;
в view-model нет `bigint`.

`tests/unit/goals-progress.test.js`: `cac`-цель `'50,00'` превращается в `5000` c через `parseBynToCents`, не
`Number()`, а в view-model лежит строкой копеек `'5000'` с `unit: 'cents'`; `direction` для `cac`/`payback` —
`lower_is_better`, для `romi`/`ltv_cac`/`new_customers` — `higher_is_better`; факт ≤ цели для
lower-is-better → `on_track`, иначе `off_track`; `fact = null` → `no_data`; цель с другим периодом не попадает
в rows; health-сервис вызван ровно один раз на список; нет `bigint`, нет `formatPercent` для месяцев.

- [ ] **Step 2: Запустить и убедиться в падении**

Run: `npx vitest run tests/unit/dashboard.test.js tests/unit/channel-passport.test.js tests/unit/goals-progress.test.js`
Expected: FAIL.

- [ ] **Step 3: Реализовать запросы и чистые сборщики view-model**

`listWeeklySeries` — один агрегирующий SQL: `daily_stats` по `stat_date BETWEEN $1 AND $2`, `JOIN campaigns` для
`channelIds`, `GROUP BY date_trunc('week', stat_date)::date`; новые клиенты — отдельный CTE по `customers`
с `first_order_at` в границах недели Minsk и тем же фильтром `first_channel_id`; оба CTE соединяются по
`weekStart` с `FULL JOIN`, чтобы неделя с расходом без клиентов не исчезла. Неделя попадает в ряд, только если
её воскресенье `<= to`; неполная текущая неделя отбрасывается. `coalesce(sum(ds.spend_cents), 0)::bigint::text`;
`count(*)::int`.
`getChannelFunnel` — один SQL: `daily_stats` по кампаниям канала (impressions/clicks/leads) + `customers` по
`first_channel_id` и `first_order_at` в границах периода + `orders` по клиентам канала в
`[minskDayStart(from), minskDayEnd(to)]`; все счётчики — `coalesce(count(...), 0)::int`, чтобы канал без строк
давал нули, а не `null`. Никаких запросов в цикле по кампаниям.

`dashboard.service` вызывает `getChannelHealthReport` один раз, берёт `blended` для KPI/verdict,
`listWeeklySeries` для расходов/клиентов и `getAttributionSeries` для недельной выручки. Последняя полная
неделя — `addDays(isoWeekStart(to), -7)`; начало ряда — `addDays(lastWeekStart, -7 * (weeks - 1))`, конец —
`to`; `listWeeklySeries` сам отбрасывает неполную неделю, attributed-ряд фильтруется по тому же правилу, а
отсутствующая неделя даёт `0n` выручки. CAC недели — `spend / newCustomers` через `computeCac`; ROMI недели —
через `computeRomi` от
**атрибутированной** выручки, а не от `orders.revenue_cents`; `weekLabel` — `formatDateRu(weekStart)`.
`roundNumber` — только в view-model; деньги — `centsToApi`.
`channel-passport.service` вызывает health один раз, `findChannelById`, `listWeeklySeries` с одним каналом,
`getAttributionSeries` с `channelId`, `getChannelFunnel`, `listCampaigns({ channelId })` и
`listCampaignCacInputs({ channelId })`; два списка соединяются по `campaignId` в памяти, без запроса на
кампанию. `campaignCac` считается `computeCac` на строку в памяти. `goals-progress.service` вызывает
`listGoals` один раз и
`getChannelHealthReport` один раз; факт для каждой цели берётся из соответствующей строки (канал или blended)
за `factPeriod`; отклонение — `fact - target` для lower-is-better и `target - fact` для higher-is-better,
`deviationPct` — через `percentChange` от target. Цели с другим `[periodStart, periodEnd]` не попадают в rows.

- [ ] **Step 4: Прогнать тесты и закоммитить**

Run: `npx vitest run tests/unit/dashboard.test.js tests/unit/channel-passport.test.js tests/unit/goals-progress.test.js`
Expected: PASS.

Commit: `feat: add dashboard channel passport and goals progress view models`

---

### Task 7: Интеграция, golden numbers, производительность и миграция индексов 004 (метрик-спека §10)

**Files:**
- Create: `db/migrations/004_m3_metrics_indexes.sql`,
  `tests/integration/metrics.services.test.js`, `tests/integration/metrics.performance.test.js`,
  `tests/helpers/queryCounter.js`, `tests/fixtures/m3-golden.json`
- Modify: `db/seed/seed.js` (экспортировать `SEED_PRNG`, чтобы golden не дублировал число), `IMPROVEMENTS.md`
  (M5-отложенное и известные ограничения)

**Interfaces:** не меняет production-сигнатуры; проверяет реальные сервисы на `getTestPool()`.

- [ ] **Step 1: Добавить индекс и интеграционный тест сервисов**

`004_m3_metrics_indexes.sql` — только индекс, который реально используется CAC-запросом и дашбордом по каналу:
```sql
-- Channel CAC reads customers by acquisition channel and first-order window. Orders, touchpoints and daily_stats
-- already have orders_customer_idx, touchpoints_time_idx and daily_stats_date_idx; a second orders index would
-- duplicate the prefix of orders_customer_idx and only add write cost.
CREATE INDEX customers_channel_first_order_idx ON customers (first_channel_id, first_order_at);
```
`tests/integration/metrics.services.test.js`: в `beforeAll` — `await resetTestDatabase(); await seed({ anchorDate:
SEED_ANCHOR }); pool = getTestPool();`; `anchor = await createReferenceRepository(pool).getDataAnchor()`; в
`afterAll` — `closeTestPool()`. Никакой зависимости от порядка файлов: каждый integration-файл сам сбрасывает и
сеет БД. `SEED_ANCHOR = '2026-11-20'` — единственная литеральная дата, она же записана в golden-фикстуре; все
`from`/`to` — через `resolvePeriod`/`addDays`, без россыпи литеральных дат. Проверить:
1. CAC Instagram из сервиса равен прямому SQL `SUM(spend)/COUNT(new customers)` за период; blended — то же по
   всем каналам; кампании не смешивают каналы; канал без строк `daily_stats` даёт `spendCents: '0'`, а не
   ошибку;
2. LTV12 канала равен `SUM(margin)/SUM(cohort size)` только по завершённым когортам; добавление свежей
   когорты (фикстура) не меняет LTV12; старая завершённая когорта остаётся в расчёте при `fromCohortMonth =
   null`; неполная когорта есть в матрице с `isComplete:false`; заказ в `00:30` Minsk 1-го числа месяца,
   вычисленного от anchor, относится к новой когорте, а не к предыдущей;
3. Σ `revenueCents` по каналам каждой модели == Σ `orders.revenue_cents` за `[from,to]`; `totalAttributedCents
   === totalRevenueCents`; linear не теряет копейки; fallback к `first_channel_id` срабатывает на заказе без
   касаний; заказ/касание на границе дня Minsk попадает в период;
4. health-отчёт: каждый канал имеет `status` из четырёх значений; free-каналы — `no_data`; blended строка
   считается; `payback 12.004`/`ratio 2.9996` на границах дают `watch`, а не `healthy`;
5. ranking: `Σ contributions == score`; дешёвый канал с меньшим CAC стоит выше; `blended` и `no_data` в
   `excluded`;
6. dashboard: KPI совпадают с blended health; недельная серия не содержит неполной недели; сумма недельной
   attributed-выручки равна `totalAttributedCents`; channel passport funnel равен прямому SQL; goals progress:
   факт канальной цели равен строке health за тот же период.

- [ ] **Step 2: Зафиксировать golden numbers**

После первого зелёного прогона выписать из БД/сервиса точные значения. `tests/fixtures/m3-golden.json` хранит
контекст каждого сравнения, а не только числа:
```json
{
  "seedPrng": 20261121,
  "capturedFromSeed": "20261121",
  "cases": [{
    "name": "default 30 days, last_touch, ltv horizon 12",
    "anchor": "2026-11-20",
    "from": "2026-10-22",
    "to": "2026-11-20",
    "model": "last_touch",
    "horizonMonths": 12,
    "expected": {
      "instagramCacCents": "...",
      "blendedNewCustomers": "...",
      "blendedCacCents": "...",
      "ltv12Cents": "...",
      "totalAttributedCents": "..."
    }
  }]
}
```
`anchor`, `from`, `to` — единственные календарные значения; тест не разбрасывает даты по коду, а берёт их из
фикстуры и сверяет с `resolvePeriod`. `seedPrng` тест сверяет с импортированным `SEED_PRNG`, чтобы фикстура не
разошлась с генератором. `instagramCacCents` — `rows.find(code).cacCents`, `blendedCacCents` —
`blended.cacCents`, `ltv12Cents` — `getChannelLtv().rows`, `totalAttributedCents` — поле T3,
`blendedNewCustomers` — `blended.newCustomers`. Поля обязаны существовать в view-model; если поля нет — сначала
добавить его в контракт, потом фикстуру. Комментарий в файле: «captured from seed 20261121; recapture only with
a seed change». Тест сравнивает **точно** (копейки/целые), не «примерно». Если сид изменится — фикстура
обновляется в том же коммите, иначе тест падает честно.

- [ ] **Step 3: Проверить отсутствие N+1 и использование индексов**

`tests/helpers/queryCounter.js`: `wrapDb(pool) -> {db, count(), reset()}` — обёртка над `query`/`connect`,
считающая SQL-запросы. Счётчик сбрасывается **перед каждым** вызовом сервиса; бюджеты проверяются отдельно,
а не суммой по всему тесту:
- `getCacReport({ groupBy: 'channel' })` — ≤ 2 запроса;
- `getChannelHealthReport` — ≤ 8 запросов и одинаковое число для 1 и 8 каналов;
- `getRankingReport` — ≤ 8 запросов, 1 и 8 каналов дают одинаковое число (рейтинг не добавляет SQL поверх
  health);
- `getDashboardSummary` — ≤ 11 (health + недельная серия + attributed-серия);
- `getChannelPassport` — ≤ 15 (health + канал + серия + attributed-серия + воронка + кампании + CAC кампаний);
- `getGoalsProgress` — ≤ 9 (список целей + health).
Рост числа запросов при увеличении числа каналов/кампаний запрещён.

`metrics.performance.test.js`: `EXPLAIN (FORMAT JSON, COSTS OFF)` выполнять на **том же клиенте**, где включён
`SET LOCAL enable_seqscan = off`:
```js
const client = await pool.connect();
await client.query('BEGIN');
await client.query('SET LOCAL enable_seqscan = off');
// EXPLAIN ...
await client.query('ROLLBACK');
```
(или `withTransaction` с `SET LOCAL` внутри). `metrics.performance.test.js` тоже в `beforeAll` делает
`resetTestDatabase()` + `seed({ anchorDate: SEED_ANCHOR })`, в `afterAll` — `closeTestPool()`; порядок файлов
не важен. Проверять только те пути, для которых индекс реально есть:
1. `listCohortMonthlyMargins` — в плане `orders_customer_idx`;
2. `listTouchpointsForOrders` — `touchpoints_time_idx`;
3. `listWeeklySeries` — `daily_stats_date_idx`;
4. `listChannelCacInputs` — `customers_channel_first_order_idx` после миграции `004`.
Допустимы `Index Scan` и `Bitmap Index Scan`; не требовать отсутствия `Seq Scan` у таблиц, где планировщик
вправе его выбрать. Тест не меряет миллисекунды и не использует `process.hrtime` — только доступность индексов
и бюджет запросов.

- [ ] **Step 4: Записать отложенное, прогнать весь набор и закоммитить**

В `IMPROVEMENTS.md` зафиксировать отложенное на M5 (алерты, сценарии, оптимизация бюджета), правило
free-канала → `no_data`, исключение `parseBynToCents` для `goals.cac` и любые найденные некритичные
ограничения. Затем:

Run: `npm run migrate && npm test`
Expected: миграция `004` применена, все тесты M1–M3 зелёные, `single-stylesheet.test.js` не затронут.

Commit: `test: verify metrics engine against seeded database and query budgets`

## Definition of Done M3

- [ ] Восемь сервисов реализованы без HTTP-слоя: CAC, LTV, атрибуция, ROMI/health, рейтинг, дашборд, карточка
      канала, цели. Деньги — `bigint` внутри и строки копеек в view-model; деления дают `null`, не
      `NaN`/`Infinity`.
- [ ] LTV(h) суммирует только `monthOffset < h`, неполные когорты исключены из средних и LTV:CAC; канальный LTV
      не теряет старые завершённые когорты.
- [ ] Линейная атрибуция точна до копейки; tie-break касаний сравнивает id как `BigInt`; окна заказов и
      касаний — `minskDayStart`/`minskDayEnd`; верхняя граница когорты — `timestamptz` в Minsk.
- [ ] Health на границах (`12.004`, `2.9996`, `−0.004%`) не округляется в healthy; ranking использует
      `cacScore = 1 - norm` и исключает `blended`.
- [ ] Aggregation view-model T6 JSON-safe (без `bigint`), с готовыми рядами для графиков.
- [ ] Индекс `004` покрывает CAC по каналу, существующие индексы — cohort/touchpoints/daily_stats; бюджеты
      запросов и отсутствие N+1 проверены.
- [ ] Golden numbers зафиксированы с `anchor/from/to/model/horizonMonths` и seed PRNG; `npm test` зелёный;
      M5-отложенное записано в `IMPROVEMENTS.md`.
