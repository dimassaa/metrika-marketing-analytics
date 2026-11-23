# M5 «Решения» — план реализации

> **Для агентов:** обязательный навык — `superpowers:subagent-driven-development` (рекомендуется) или
> `superpowers:executing-plans`. Задачи выполнять по порядку, шаги отмечать `- [x]`, коммит — в конце задачи.
>
> **Модель исполнителя и ревьюера:** `opencode-go/deepseek-v4.1-flash` (`AGENTS.md` §3). Другие модели не выбирать,
> даже если кажется, что они подходят лучше.

**Цель:** закрыть три бизнес-операции, которых не хватает продукту после M4: алерты (BO-09), сценарии «что если»
(BO-07) и рекомендацию недельного бюджета (BO-08). Экран `/app/alerts` показывает отклонения на точных четырёхнедельных
окнах и ведёт жизненный цикл `active → resolved → dismissed`; экран `/app/scenarios` подгоняет кривые насыщения по
26 неделям, распределяет бюджет через KKT + бисекцию и сохраняет воспроизводимый снимок расчёта в `scenarios`.

**Архитектура:** `routes → controllers (Zod, data anchor) → services/decisions → repositories → PostgreSQL`;
экранная модель собирается один раз в `services/decisions/screen-models.js` и отдаётся одновременно в `data-props` и
`/api/v1/*`. Математика насыщения/оптимизатора — чистые функции без Express и без БД. Алерты и сценарии — отдельный
composition-root `services/decisions/index.js`, потому что это второй bounded context поверх готового движка M3:
он получает `metrics` (репозитории и сервисы CAC/LTV/атрибуции) и не переписывает формулы. Страницы — EJS-каркас +
один React-остров; GET-формы остаются в EJS, потому что они работают без JavaScript и не требуют CSRF.

**Стек:** Node 24 LTS, ESM, Express 5, EJS 3, PostgreSQL 18, Zod 4, React 19 + Recharts 3, Vite 7,
Vitest 3 + Supertest, agent-browser. Новых зависимостей нет. Таблицы `alerts` и `scenarios` созданы в
`db/migrations/001_init.sql`; M5 добавляет **одну** миграцию `006_decisions.sql`, которая расширяет точность
`alerts.value`/`alerts.threshold` до `NUMERIC(14,4)`. Файл `001` не редактируется.

**Спеки:** `docs/superpowers/specs/2026-11-21-metrics-spec.md` §0.1 (data anchor), §6.1–§6.3 (насыщение,
оптимизация, прогноз), §7 (алерты), §9 (BYN); `docs/superpowers/specs/2026-11-21-marketing-analytics-design.md`
§6 (BO-07/08/09), §7 (`alerts`, `scenarios`), §8 (экраны «Сценарии», «Алерты»), §10 (RBAC, CSRF, владелец
сценария); `docs/superpowers/specs/2026-11-21-assignment-traceability.md` §2 (матрица прав).

**Граница этапа:** M5 заканчивается на `/app/alerts`, `/app/scenarios`, их API, сохранении сценариев и тестах.
Существующий CSV-экспорт (`AUDIT_EXPORT_DATASETS`: `channels`, `campaigns`, `daily_stats`, `orders`) считается
достаточным: отдельный экспорт сценариев и алертов в M5 не добавляется. Bullet-график целей,
удаление/редактирование сценариев и per-channel caps — тоже не входят; они записываются в `IMPROVEMENTS.md`
с причиной.

## Global Constraints

1. Только JavaScript, ESM, импорты с `.js`. JSX — только в `client/**`. Ни одного `.ts`/`.tsx`, ни `tsx`/`ts-node`.
2. Один stylesheet — `public/css/app.css`. React не импортирует CSS, не использует `style={{…}}`, `styled`, `sx`,
   CSS-модули. Динамика — только классами из `app.css`.
3. Слои: `controllers` ≤ 40 строк на обработчик (разбор, Zod, один вызов сервиса, рендер/redirect/JSON); формулы —
   только в `services`; `views` и React не считают, а форматируют готовые поля.
4. Деньги — целые копейки, `BIGINT` в БД. В `data-props` и JSON — десятичные строки копеек, никогда `bigint` и
   никогда `number`. В `scenarios.params/result` бюджет хранится как `budgetCents: "123456"`, не как float.
   Границы типов фиксированы: `pg` отдаёт `BIGINT` и `NUMERIC` строками; `centsFromDb(value)` из `src/lib/money.js`
   — единственный вход в копейки; арифметика копеек и клиентов — целочисленная, `bigint` не складывается с `number`
   без явного `BigInt(...)`/`Number(...)`. В сервисах описано, где происходит каждое преобразование.
   Валюта — `<span class="byn">BYN</span>`; `$`, `₽`, `руб.` запрещены.
5. «Сегодня» — `referenceRepository.getDataAnchor()`, один вызов на запрос. Окна алертов, 26 недель кривых и
  базовый недельный бюджет считаются от anchor; системные часы не используются.
6. `null` — честное «нет данных». `NaN`/`Infinity` не покидают сервис. Ноль остаётся нулём; отсутствие LTV,
   кривой или цели не подменяется нулём.
7. JSONB сценария версионируется (`schemaVersion: 1`) и читается через Zod. Неизвестная версия/форма — честная
   пометка «сценарий сохранён другой версией», не 500 и не молчаливый пересчёт.
8. RBAC на каждом маршруте: `scenarios:view/manage`, `alerts:view/manage`. Скрытие кнопки не заменяет проверку.
   Все POST — с CSRF; GET-страница алертов выполняет только идемпотентный пересчёт, ограниченный ролью
   `alerts:manage` и часовым throttle (исключение из «GET без побочных эффектов» зафиксировано спекой §7).
9. SQL только параметризованный. Пересчёт алертов — пакетный `INSERT … SELECT unnest(...) ON CONFLICT
   (channel_id, rule, period_start)`, а не запрос на алерт: число запросов не растёт с числом каналов.
   `period_start` входит и в список колонок, и в `unnest(...)`, и в конфликтный ключ — иначе upsert не найдёт
   существующую строку и создаст дубль.
10. Графики — только Recharts 3 (SVG), через `ChartFrame` и `client/lib/chartTheme.js`, без пирогов/3D/canvas,
    без второй оси Y. Не более 4 серий на линейном графике. У каждого графика — вывод-заголовок, период, единица,
    пустое состояние, `aria-label`, таблица-дубль вне `role="img"`.
11. UI и подписи — русский, код — английский. Один cyan-filled элемент на экран; статусы — точка + текст.
    Пустые/ошибочные состояния обязательны; ошибки — русские.
12. Никаких CDN, внешних шрифтов, новых зависимостей. Скриншоты — только `docs/screenshots/m5/`.
13. Тесты не ходят в прод-БД: только `TEST_DATABASE_URL`. Новый баг — сначала падающий регрессионный тест.
14. Бюджеты запросов: `/app/alerts` ≤ 32, `/app/scenarios` ≤ 12, `/app/scenarios/:id` ≤ 6 (плюс сессия и anchor);
    запросы не растут с числом каналов. CAC-график алертов читает `listWeeklySeries` по выбранному каналу, а
    detail сценария рендерится из сохранённого `result` без повторной подгонки. Повторный read с теми же
    параметрами в одном GET запрещён (`tests/integration/page-queries.test.js`).
15. UI проверяется только в реальном браузере: `agent-browser open/click/fill/resize 390 844/console/screenshot`.
16. Коммит — в конце каждой задачи, формат `type: brief description`; пуши/теги — только с одобрения владельца.

## Решения владельца (утверждены 2026-11-23)

| № | Вопрос | Решение | Отвергнутая альтернатива |
|---|---|---|---|
| 1 | Кто может закрывать (dismiss) алерт? | `analyst` и `admin` (`alerts:manage`), действие пишется в `audit_log` как `alert.dismiss`; `viewer` только видит. Это матрица трассировки §2. | Дать dismiss viewer'у: пришлось бы вводить `alerts:dismiss` и расходиться с §2; отклонено. |
| 2 | Пересчёт алертов при открытии страницы или только по кнопке? | Авто при GET, но только для `alerts:manage`, не чаще раза в час на сессию; кнопка «Пересчитать» работает всегда. Throttle хранится в `req.session.alertsRecalculatedAt`. | Только кнопка: GET стал бы чистым, но спека §7 требует авто-проверку; отклонено. |
| 3 | Бюджет сценария — недельный или месячный? | **Недельный**: формулы §6.3 (`ROMI12 = (revenue12 − b*52)/(b*52)`) и кривая `b` — недельные. UI подписывает и недельный бюджет, и 12-месячный прогноз (`×52`). | Месячный: пришлось бы делить на 4,345 и переписывать §6.1–§6.3; отклонено. |
| 4 | Какой предел бюджета и где он живёт? | Одна конфигурация `METRICS_CONFIG.scenarios.maxBudgetMultiplier = 3` задаёт и `max` слайдера, и серверную валидацию; предупреждение об экстраполяции — при `B > 2×` текущего недельного расхода (`warnBudgetMultiplier = 2`). Per-channel caps в M5 нет (спека §6.2: только `Σ b_i = B, b_i ≥ 0`). | Прежний cap `5×` с дублированием в UI и сервере: два источника правды и скачок за пределы fitted-диапазона; отклонено. |
| 5 | Сценарии — личные или общие? | **Общие на чтение** для всех с `scenarios:view`, автор виден в списке; создание — `scenarios:manage`; удаления/редактирования в M5 нет. Проверка владельца из дизайна §10 понадобится при появлении delete/edit. | Личные сценарии: `listScenarios({userId})`, detail 404 для чужого; viewer остался бы без сценариев, что противоречит «просмотру» в матрице; отклонено. |
| 6 | Участвует ли линейная кривая в KKT? | **Нет.** Линейная кривая (мало положительных недель) исключается из оптимизации с видимым предупреждением «линейная кривая — без оптимума»; канал остаётся в списке и прогнозе отдельной пометкой. Причина фиксируется в `IMPROVEMENTS.md` и в спеке §6.2. | Подставлять линейную кривую в KKT: постоянная предельная отдача даёт скачок «весь бюджет одному каналу»; отклонено. |

Дополнительно план фиксирует решения, которые владельцу подтверждать не нужно (обратимы и следуют M4):

- **Слайдер бюджета — нативный `<input type="range">` в EJS GET-форме**, а не React-состояние: нет CSR-расчёта,
  нет preview-эндпоинта, нет CSRF на каждое движение, страница работает без JavaScript. React-остров рисует только
  результат и графики. Клиентский guard `client-guards.test.js` запрещает `fetch` в островах, поэтому live-preview
  был бы третьим путём вычисления.
- **Список алертов рендерится EJS**, потому что каждая строка несёт CSRF-форму dismiss; остров рисует сводку и
  график. Полная модель всё равно кладётся в `data-props` и совпадает с API, поэтому parity-тест остаётся.
- **ROMI алертов — по `last_touch`**, как health/ranking по умолчанию; подпись в UI «ROMI по последнему касанию».
- **Waterfall-график не вводится**: прирост показывается существующим `IncrementBars`, а расхождение с
  классическим waterfall явно фиксируется в `IMPROVEMENTS.md` и в дизайн-спеке §8.

## Файловая карта

| Действие | Путь | Ответственность |
|---|---|---|
| Create | `src/services/decisions/saturation.service.js` | чистая подгонка `q=K(1−e^{−b/S})`, linear/no_data fallback, R² |
| Create | `src/services/decisions/budget-optimizer.service.js` | KKT + бисекция, округление до копеек, feasibility |
| Create | `src/services/decisions/alerts.service.js` | окна, правила, guard, lifecycle, dedupe |
| Create | `src/services/decisions/scenarios.service.js` | 26 недель, прогноз, сохранение, чтение JSONB |
| Create | `src/services/decisions/scenario-charts.js` | 4 контракта графиков сценария |
| Create | `src/services/decisions/alerts-charts.js` | CAC-график проблемного канала |
| Create | `src/services/decisions/screen-models.js` | `buildAlertsScreen`, `buildScenariosScreen`, `buildScenarioDetailScreen` |
| Create | `src/services/decisions/index.js` | composition root решений |
| Create | `src/repositories/alerts.repo.js` | выборка, пакетный upsert, resolve, dismiss |
| Create | `src/repositories/scenarios.repo.js` | list/find/create + автор |
| Create | `src/validators/alerts.schema.js` | фильтры, dismiss, строгая/терпимая страница |
| Create | `src/validators/scenarios.schema.js` | query/save/store-схемы, `schemaVersion` |
| Create | `src/controllers/alerts.controller.js` | страница, recalc, dismiss, API-load |
| Create | `src/controllers/scenarios.controller.js` | builder, detail, save, API-list |
| Create | `src/controllers/api/decisions.controller.js` | JSON-обёртки над loaders |
| Create | `src/views/pages/alerts.ejs` | фильтры, recalc, EJS-строки с dismiss-формами, остров |
| Create | `src/views/pages/scenarios.ejs` | GET-форма бюджета/каналов, save-форма, остров |
| Create | `src/views/pages/scenario-detail.ejs` | сохранённый снимок, графики, «повторить» |
| Create | `db/migrations/006_decisions.sql` | расширение `alerts.value/threshold` до `NUMERIC(14,4)` |
| Create | `client/entries/alerts.jsx`, `client/entries/scenarios.jsx` | по одному острову; `scenarios` обслуживает и builder, и detail через `mode` |
| Create | `client/components/charts/ComparisonBars.jsx` | grouped bars «сейчас/план» |
| Create | `client/components/charts/SaturationCurve.jsx` | линия кривой + точки наблюдений |
| Create | `client/components/charts/IncrementBars.jsx` | вклад каналов в прирост |
| Modify | `src/config/metrics.js` | замороженные поддеревья `saturation`, `alerts`, `scenarios`; `scenarios.maxBudgetMultiplier` |
| Modify | `src/lib/format.js` | только `formatDateTimeRu`; десятичные числа — существующие `formatRatio`/`formatSignedPercent` |
| Modify | `src/config/audit-actions.js` | `scenario.create`, `alert.dismiss`; entities `scenario`, `alert` |
| Modify | `src/services/audit.service.js` | русские подписи, безопасные ключи `rule`/`reason`/`budgetByn` |
| Modify | `src/repositories/metrics.repo.js` | `listChannelWindowTotals` для двух окон алертов |
| Modify | `src/app.js` | второй composition root и передача в роутеры |
| Modify | `src/routes/app.routes.js` | реальные `/scenarios*`, `/alerts*`; удалить placeholder-loop |
| Modify | `src/routes/api.routes.js` | `/scenarios*`, `/alerts*`, карта прав |
| Modify | `src/controllers/app.controller.js` | удалить неиспользуемый `createAppController`/`comingSoon` |
| Delete | `src/views/pages/coming-soon.ejs` | последние два placeholder'а уходят |
| Modify | `vite.config.js`, `src/lib/assets.js` | входы `alerts`, `scenarios`; `KNOWN_ENTRIES` |
| Modify | `tests/integration/build-output.test.js` | список из семи входов (detail не добавляет восьмой) |
| Create | `tests/helpers/decisionSeeds.js` | `SEED_ANCHOR`, `seedDecisions()` — общий reset/seed для DB-тестов |

**Миграция 006 (единственная новая).** `001_init.sql` объявляет `alerts.value` и `alerts.threshold` как
`NUMERIC(14,2)`. Двух знаков достаточно для отображения, но мало для воспроизводимого следа порога, по которому
сработала severity; 4 знака дают этот запас, не превращая хранение в «математику с float». `006_decisions.sql` делает
`ALTER TABLE alerts ALTER COLUMN value TYPE NUMERIC(14,4), ALTER COLUMN threshold TYPE NUMERIC(14,4)`; CHECK-и,
`UNIQUE(channel_id, rule, period_start)` и индексы не трогаются. Миграция идемпотентна на пустой БД и проверяется
`tests/integration/migrations.test.js`. Файл `001` остаётся неизменным. Следующий свободный номер после M5 — `007`.

Точность и границы: сами сравнения правил — целочисленные и точные; в `alerts.value/threshold` пишутся
4-знаковые строки, а в UI они показываются с 2 знаками. План **не** обещает «копеечную» точность отображённого
порога при 2 знаках: решение принимает integer-сравнение, а `NUMERIC(14,4)` хранит достаточный след для аудита.

## Task 1: Конфигурация и чистые помощники

**Files:**
- Modify: `src/config/metrics.js`
- Modify: `src/lib/format.js`
- Test: `tests/unit/format.test.js`, `tests/unit/m5-config.test.js` (новый файл конфигурации)

**Interfaces:**
- Produces: `METRICS_CONFIG.saturation`, `.alerts`, `.scenarios` (frozen); `formatDateTimeRu(value)` →
  `DD.MM.YYYY HH:mm` (Europe/Minsk, NBSP). Нового `formatDecimal` нет: обычные дроби форматирует существующий
  `formatRatio(value, {decimals})`, дельты — `formatSignedPercent`; дублировать их запрещено.

- [ ] **Step 1: Write failing assertions** — `formatRatio(12.345, {decimals: 2}) === '12,35'`,
  `formatSignedPercent(-0.04) === '−<0,1%'` (tiny negative не становится нулём),
  `formatDateTimeRu('2026-11-23T10:05:00Z') === '23.11.2026\u00a013:05'`; конфиг: `saturation.historyWeeks === 26`,
  `saturation.gridSteps === 60`, `saturation.minPositiveWeeks === 8`, `saturation.r2WarnBelow === 0.3`,
  `alerts.windowWeeks === 4`, `alerts.autoRecalcMs === 3_600_000`, `alerts.cacSpikeWarnRatio` = `{num:6,den:5}`,
  `alerts.cacSpikeCriticalRatio` = `{num:3,den:2}`, `scenarios.maxBudgetMultiplier === 3`,
  `scenarios.warnBudgetMultiplier === 2`, `scenarios.extrapolationFactor === 2`, дерево `Object.isFrozen`.
- [ ] **Step 2: Run and see fail** — `npx vitest run tests/unit/format.test.js tests/unit/m5-config.test.js`.
- [ ] **Step 3: Implement** — `formatDateTimeRu` — один `Intl.DateTimeFormat('en-US', {timeZone:'Europe/Minsk'})`
  и ручная сборка частей, как в `audit.service.js`; перенести приватный форматтер аудита на новый экспорт. Если
  для `K`/`S`/`R²` действительно не хватает `formatRatio` (например, нужен другой набор знаков), добавить один
  тонкий helper и обосновать в отчёте; копию `formatDecimal` не вводить. В `METRICS_CONFIG` добавить ровно
  значения из спеки §6–§7 и таблицы решений. Константа cap в обсуждении называется
  `SCENARIO_BUDGET_MAX_MULTIPLIER = 3`; в коде она живёт как `METRICS_CONFIG.scenarios.maxBudgetMultiplier`, и
  второго литерала `3` в UI/сервере нет.
- [ ] **Step 4: Run tests** — зелёные, включая существующий `audit.service` тест при наличии.
- [ ] **Step 5: Commit** — `feat: add M5 decision thresholds and shared formatters`.

## Task 2: Кривая насыщения (BO-08, часть 1)

**Files:**
- Create: `src/services/decisions/saturation.service.js`
- Test: `tests/unit/saturation.test.js`

**Interfaces:**
- Produces:
  - `toWeeklyBuckets({ firstWeekStart, weeks, rowsByChannel }) → Map<channelId, Array<{weekStart, spendCents: bigint, newCustomers: number}>>`
    Ровно `weeks` точек на канал; отсутствующая неделя — `{spendCents:0n, newCustomers:0}`. Диапазон 26 недель
    даёт **существующий** `resolveWeekRange(anchor, 26)` из `src/services/metrics/weekly-series.js`; верхняя
    граница — `to = addDays(lastWeekStart, 6)`, иначе последняя неделя читается неполной.
  - `fitSaturationCurve({ points, config = METRICS_CONFIG.saturation }) → FitResult`
    `FitResult = { model:'saturation'|'linear'|'no_data', K:number|null, S:number|null, cpaCents:string|null, sse:number,
    sst:number, r2:number|null, unreliable:boolean, positiveWeeks:number, maxSpendCents:string, meanSpendCents:string,
    maxObservedCustomers:number, warning:string|null }`
  - `predictConversions(fit, spendByn: number) → number` (0 при b=0; монотонна; ≤K)
  - `predictLinear(fit, spendByn) → number`
- Consumes: ничего из БД; `points` уже сгруппированы.

- [ ] **Step 1: Write failing test `fits a synthetic saturation curve`** — сгенерировать 26 точек
  `b = 100..2600 BYN`, `q = 500*(1-exp(-b/1200))`; ожидать `model==='saturation'`, `K` в пределах одного шага
  сетки **или** ±5 % от 500, `S` в пределах одного лог-шага или ±15 % от 1200, `r2 > 0.99`,
  `unreliable === false`; `predictConversions(fit, 0) === 0`. Допуск формулируется как «шаг сетки или процент»,
  потому что грубая сетка не обязана попадать в точку параметра.
- [ ] **Step 2: Write failing boundaries** — 7 недель с `b>0` → `model==='linear'`, `cpaCents` = сумма расходов /
  сумма клиентов (целочисленно, `centsFromDb` уже применён); 0 недель с расходом или 0 клиентов →
  `model==='no_data'`; плоские `q` при разных `b` → `unreliable === true`, `r2 === null` или `<0.3`,
  `Number.isFinite` для всех чисел; недели с `b=0` входят в 26 точек, но не в `positiveWeeks`.
  `meanSpendCents`/`mean(b)` определены **только по неделям с `b>0`**; отсюда `K ∈ [1.05*max(q), 4*max(q)]`,
  `S ∈ [0.33*meanPositive(b), 3*max(b)]`. Если положительных недель нет, `meanSpendCents === null`, не `0`.
- [ ] **Step 3: Run and see fail** — `npx vitest run tests/unit/saturation.test.js`.
- [ ] **Step 4: Implement grid** — 60 линейных `K` и 60 логарифмических `S`; `meanSpendCents` — среднее только
  по `b>0`; SSE по всем 26 точкам; `SST` по среднему `q`; `R² = 1 − SSE/SST`, при `SST === 0` —
  `SSE === 0 ? 1 : null`; `unreliable = r2 === null || r2 < 0.3`; `warning` — русская строка для UI. Никакого
  случайного поиска и `Math.random`.
- [ ] **Step 5: Run tests; commit** — `feat: add deterministic saturation curve fit`.

## Task 3: Оптимизатор бюджета (BO-08, часть 2)

**Files:**
- Create: `src/services/decisions/budget-optimizer.service.js`
- Test: `tests/unit/budget-optimizer.test.js`

**Interfaces:**
- Produces:
  - `allocateBudget({ curves, budgetCents, config = METRICS_CONFIG.saturation }) →`
    `{ allocations: Array<{channelId:string, spendCents:bigint, spendByn:number}>, lambda:number, iterations:number,
    totalCents:bigint, objective:number }`
  - `marginalReturn(curve, spendByn) → number` (`K/S * exp(−b/S)`), экспортируется для теста KKT.
- Consumes: `curves` — только `fit.model === 'saturation'` с `K > 0`, `S > 0`. `linear`/`no_data` отфильтровывает
  вызывающий сервис сценариев; оптимизатор не получает их и не пытается «дооптимизировать».

- [ ] **Step 1: Write failing test `splits a budget by equal marginal return`** — две кривые
  `(K=100,S=1000)` и `(K=50,S=500)`, `B=200 000` копеек; сумма `spendCents === 200000n`, обе аллокации `>0`,
  `|marginalReturn(a)−marginalReturn(b)| < 1e-6`; unit-функция возвращает `spendCents` как `bigint`, а
  screen model обязан отдать строку (проверяется в Task 7).
- [ ] **Step 2: Write failing boundaries** — `B=0n`/отрицательный → `ValidationError`; `B < числу кривых в
  оптимизации` (меньше 1 копейки на optimizable-канал; linear/no_data уже отфильтрованы) → `ValidationError`;
  отсутствие кривых → `ValidationError('Нет каналов с валидной кривой')`; больший бюджет не уменьшает ни одну
  аллокацию;
  `Σ spendCents === B` для 100 детерминированных бюджетов, включая `3×` текущего недельного; округление
  largest-remainder не создаёт отрицательных копеек. Отдельный тест: законный бюджет `3×` **не** отвергается
  оптимизатором — cap проверяет сервис сценариев, а не чистая функция.
- [ ] **Step 3: Run and see fail.**
- [ ] **Step 4: Implement KKT + bisection** — `b_i(λ)=S_i*ln(K_i/(S_i*λ))` при `λ<K_i/S_i`, иначе 0; бисекция 80
  итераций на `(0, max(K_i/S_i)]`, монотонная сумма. Произвольного `λ_min`-отсечения нет: экспоненциальная кривая
  достигает любого конечного бюджета при `λ→0`, поэтому единственная проверка достижимости — минимум
  `1 копейка × число кривых в оптимизации`. Перевод в копейки `floor`, остаток — по наибольшей дробной части,
  затем точная сверка суммы; при нехватке копеек канал получает минимум `1n`, а не `0n`.
- [ ] **Step 5: Run tests; commit** — `feat: add KKT budget optimizer`.

## Task 4: Правила и окна алертов (BO-09, часть 1)

**Files:**
- Create: `src/services/decisions/alerts.service.js` (чистая часть)
- Modify: `src/repositories/metrics.repo.js` (`listChannelWindowTotals`)
- Test: `tests/unit/alerts.test.js`

**Interfaces:**
- Produces:
  - `resolveAlertWindows(anchor, weeks = METRICS_CONFIG.alerts.windowWeeks) →`
    `{ anchor, weeks, now:{from,to,periodStart}, prev:{from,to} }`. Вычисляется через существующий
    `resolveWeekRange(anchor, weeks)` из `src/services/metrics/weekly-series.js`; `to = addDays(lastWeekStart, 6)`,
    чтобы окно закрывалось воскресеньем. `periodStart` — понедельник начала `now` (он же ключ хранения);
    отчётная дата (`anchor`) показывается отдельно и в ключ не входит. Оба окна — ровно 4 полные Mon–Sun недели.
  - `evaluateChannelAlerts({ channel, now, prev, ltv12Cents, targetRomiPct }) → AlertCandidate[]`;
    `now/prev = { spendCents:bigint, newCustomers:number, revenueCents:bigint }`.
    `AlertCandidate = { rule, severity, value:string, threshold:string }` — десятичные строки для
    `NUMERIC(14,4)`; `threshold` — именно тот порог, который вызвал severity (`1.5×` для critical, `1.2×` для
    warning). При повышении severity обновляются и `severity`, и `threshold` одной строки.
  - `alertsRepository` (Task 5) получает `listChannelWindowTotals({nowFrom,nowTo,prevFrom,prevTo})` из metrics.repo:
    `{ window:'now'|'prev', channelId, spendCents: bigint, newCustomers: number }`.
- Consumes: `resolveWeekRange(anchor,4)` и `addDays` из `lib`; `attributionService.getAttributionReport(...last_touch)`,
  `ltvService.getChannelLtv(...12)`, `channelsRepository.listChannels()` — в сервисной части (Task 5).

### Точные правила (метрик-спека §7)

Guard для всех правил: `spendNow>0 && customersNow>0 && spendPrev>0 && customersPrev>0`; плюс условие строки.
Сравнения — целочисленные и строгие, без display-округления.

| rule | Условие (точное) | Severity | `value` | `threshold` |
|---|---|---|---|---|
| `cac_spike` | `S_n*C_p*5 > S_p*C_n*6` | warning; critical, если ещё `S_n*C_p*2 > S_p*C_n*3` | CAC_now, BYN | 1,2× CAC_prev (warning) или 1,5× CAC_prev (critical), BYN |
| `romi_below_target` | `targetRomiPct != null` и `(R_n−S_n)*10000 < T_hundredths*S_n` | warning | ROMI_now, % | target, % |
| `romi_negative` | `R_n < S_n` | critical | ROMI_now, % | 0 |
| `payback_long` | `LTV12 != null && LTV12 > 0` и `S_n > C_n*LTV12` | warning | payback, мес. | 12 |
| `ltv_cac_low` | `LTV12 != null` и `LTV12*C_n < S_n` | critical | LTV:CAC | 1 |

`cac_spike` — одна строка на период: severity повышается до critical, второй записи нет (`UNIQUE`); при
повышении `threshold` перезаписывается на `1,5×`, чтобы строка объясняла фактическую severity. Все сравнения —
целые, поэтому тест «ровно 1,2×» и «1,2× + 1 копейка» проверяет именно логику, а не округление хранения.
`NUMERIC(14,4)` — точность следа; UI и `thresholdLabel` показывают 2 знака, и план не утверждает, что
отображённые 2 знака воспроизводят границу.

- [ ] **Step 1: Write failing window tests** — anchor Sunday `2026-11-22` → `now 2026-10-26..2026-11-22`,
  `prev 2026-09-28..2026-10-25`, `periodStart 2026-10-26` (понедельник); anchor Monday `2026-11-23` → `now`
  `2026-10-26..2026-11-22`; anchor Wednesday → та же `now`, текущая неделя не попадает. В модели
  `periodStart` — ключ/подпись окна, отчётная дата (`anchor`) выводится отдельно как «Данные по …».
- [ ] **Step 2: Write failing strict-boundary tests** — CAC ровно 1,2× → warning нет; 1,2× + 1 копейка → warning;
  ровно 1,5× → warning (не critical); 1,5× + 1 копейка → critical; ROMI ровно target → нет; target − 0,01 → warning;
  ROMI ровно 0 → нет `romi_negative`; −0,01 → critical; payback ровно 12 → нет; 12,01 → warning; LTV:CAC ровно 1 →
  нет; 0,999 → critical; `targetRomiPct === null` → `romi_below_target` нет; `ltv12Cents === null` → payback/ltv_cac
  нет; `ltv12Cents === 0n` → `payback_long` нет (окупаемость не определена), но `ltv_cac_low` critical есть.
  Повышение `cac_spike` warning→critical в следующем окне обновляет и `severity`, и `threshold` (1,2× → 1,5×)
  в одной строке; второго ряда нет.
- [ ] **Step 3: Write failing guard tests** — нулевой расход или нулевые клиенты в любом окне → пустой массив для всех
  правил; нулевая выручка при валидном guard → `romi_negative`; `cac_spike` и `romi_negative` сосуществуют.
- [ ] **Step 4: Run and see fail; implement pure functions** — `T_hundredths` парсится как `NUMERIC` строка без
  float (`Number(target)*100` только после проверки `/^\d+(\.\d{1,2})?$/`; порог цели — проценты, 2 знака по
  спеке); `value`/`threshold` формируются `centsToBynDecimal`/`roundNumber` и пишутся с 4 знаками.
- [ ] **Step 5: Repository test переносится в Task 5** — `tests/integration/alerts.test.js` должен реально
  выполнить upsert, а не проверять строку SQL; здесь — только unit.
- [ ] **Step 6: Commit** — `feat: add alert windows and exact rules`.

## Task 5: Персистентность алертов и сценариев

**Files:**
- Create: `src/repositories/alerts.repo.js`, `src/repositories/scenarios.repo.js`
- Modify: `src/services/decisions/alerts.service.js` (service wrapper поверх pure-части Task 4)
- Create: `src/services/decisions/scenarios.service.js`
- Create: `src/validators/scenarios.schema.js`
- Modify: `src/config/audit-actions.js`, `src/services/audit.service.js`
- Test: `tests/integration/alerts.test.js`, `tests/integration/scenarios.test.js`, `tests/unit/scenarios.test.js`

**Interfaces:**
- `createAlertsRepository(dbOrClient).{ listAlerts({filters, page=1, limit=50}) → {rows, summary, page, total, hasMore},
  findAlertById(id) → row|null, listCurrentPeriodActive(periodStart) → rows, upsertAlerts(rows) → {inserted, updated},
  resolveAlerts(ids) → number, resolveActiveBefore(periodStart) → number, dismissAlert(id) → row|null,
  lastDetectedAt() → timestamptz|null }`
- `createAlertsService({ db, metricsRepository, channelsRepository, attributionService, ltvService,
  auditServiceFactory = (client) => createAuditService({ auditRepository: createAuditRepository(client) }) }).{`
  `resolveWindows(anchor), recalculate({anchor, actor}) → counts, list({filters, page}) → {rows, summary, page, total},
  dismiss({id, reason, actor}) → row }`. Сервис **не держит pool**: `recalculate`/`dismiss` открывают
  `withTransaction(db, async (client) => { const alertsRepository = createAlertsRepository(client); … })`;
  audit-сервис в той же транзакции создаётся фабрикой от `client`. Глобальный `pool` в сервисах не используется;
  `auditServiceFactory` подменяется в тесте атомарности.
- `createScenariosRepository(dbOrClient).{ listScenarios({page=1, limit=50}) → {rows, page, total, hasMore},
  findScenarioById(id) → row|null, createScenario({name, createdBy, params, result}) → {id} }`
- `createScenariosService({ db, metricsRepository, channelsRepository, ltvService,
  auditServiceFactory = (client) => createAuditService({ auditRepository: createAuditRepository(client) }) }).{`
  `buildScenario({anchor, budgetByn, channelIds, curveChannelId}) → scenarioResult,`
  `saveScenario({name, budgetByn, channelIds, anchor}, actor) → {id},`
  `listScenarios({page}) → listRows, getScenarioDetail(id) → detail|invalidDetail }`. `saveScenario` выполняет
  `createScenario` и `scenario.create` **в одной транзакции** на одном `client`; при ошибке аудита сценарий не
  сохраняется, при ошибке сохранения аудит не пишется.
- `alertsService.recalculate` возвращает `{ periodStart, triggered, inserted, updated, resolved, keptDismissed }`.
- `scenariosService.saveScenario` возвращает `{ id }`; сервер **пересчитывает** сценарий из `budgetByn`/`channelIds`,
  не принимает `result` от клиента. `buildScenario` проверяет `budgetCents <= currentWeeklyCents *
  METRICS_CONFIG.scenarios.maxBudgetMultiplier` (одна константа с UI) и добавляет `warning` при `budgetCents >
  warnAboveCents`; более высокий бюджет — `ValidationError`, а не тихое урезание. `linear`/`no_data` остаются
  в выдаче с `note`/`warnings`, но не входят в `planned` и KKT-вызов.
- LTV читается **один раз** на запрос: `const { rows } = await ltvService.getChannelLtv({anchor,
  horizonMonths:12, channelIds})`; в `rows[].ltvCents` значение приходит строкой и проходит `centsFromDb`.
  Отдельного запроса на канал нет (N+1 запрещён). Копейки и клиенты складываются целочисленно; `bigint` не
  смешивается с `number`.

- [ ] **Step 0: Determinism helper** — в `tests/helpers/decisionSeeds.js` экспортировать
  `SEED_ANCHOR = '2026-11-20'` и `seedDecisions()` (`resetTestDatabase(); seed({anchorDate: SEED_ANCHOR})`).
  Каждый DB-тест M5 в `beforeAll` вызывает helper, в `beforeEach` очищает `alerts`, `scenarios`, `audit_log`
  (и `sessions`), чтобы порядок файлов не влиял. Аудит проверяется по `entity`/`entity_id`, а не по счётчику
  всех строк.
- [ ] **Step 1: Failing dedupe test** — seed → `recalculate({anchor})` дважды → `SELECT count(*) FROM alerts`
  не меняется; `detected_at` обновляется; `UNIQUE(channel_id,rule,period_start)` не нарушается; повторный расчёт
  после dismiss оставляет `dismissed`. Тест **исполняет** upsert на реальной БД (не проверяет текст SQL).
- [ ] **Step 2: Failing lifecycle test** — вручную вставить `active` строку прошлого периода → recalculate →
  `resolved`; вставить `active` строку текущего `period_start`, чьё правило больше не срабатывает →
  `staleIds = currentActiveIds − triggeredKeys` → `resolved`; `dismissed` не воскресает; `resolved` при
  повторном срабатывании снова `active`. `triggeredKeys` — множество `(channelId, rule)` из кандидатов
  текущего периода; это единственный источник «что живо».
- [ ] **Step 3: Failing scenario persistence + atomicity** — `saveScenario` создаёт строку `scenarios` с JSONB
  `params.schemaVersion===1`, `params.budgetCents` — строка, `result` без `bigint`; `scenario.create` в
  `audit_log` с `entity='scenario'` и `entity_id` нового id; автор = `created_by`; `name` 3–120; пустой
  `budgetByn` → текущий бюджет. Тест cap: `3×` проходит, `3× + 1 копейка` → `ValidationError`, `>2×` даёт
  `warning`; тест живёт здесь, а не в чистом оптимизаторе. Тест атомарности: мок/падающий audit-insert → строки
  `scenarios` нет; падающий `createScenario` → строки `audit_log` нет.
- [ ] **Step 4: Failing drift test** — сохранить сценарий, затем `UPDATE scenarios SET params='{"schemaVersion":99}'`;
  `getScenarioDetail` возвращает `invalid:true`, объяснение и не падает; `listScenarios` не падает.
- [ ] **Step 5: Implement batch upsert** — один `INSERT … SELECT unnest($1::bigint[], $2::text[], $3::date[],
  $4::text[], $5::numeric[], $6::numeric[]) … ON CONFLICT (channel_id, rule, period_start) DO UPDATE SET
  severity=EXCLUDED.severity, value=EXCLUDED.value, threshold=EXCLUDED.threshold, detected_at=now(),
  status=CASE WHEN alerts.status='dismissed' THEN 'dismissed' ELSE 'active' END RETURNING (xmax=0) AS inserted`.
  Колонки: `channel_id, rule, period_start, severity, value, threshold`. `period_start` обязан быть и в
  `unnest`, и в `ON CONFLICT`; без него Postgres не найдёт конфликт. `resolveActiveBefore` и
  `resolveAlerts(staleIds)` — по одному `UPDATE`. Весь пересчёт — в `withTransaction`, репозиторий создан от
  `client`. `detected_at` в сводке — абсолютный `MAX(detected_at)` из БД, без `Date.now()`.
- [ ] **Step 6: Implement scenario storage** — `params = {schemaVersion:1, anchor, history:{from,to,weeks:26},
  budgetCents, channelIds, optimizer:{...METRICS_CONFIG.saturation}, budgetPeriod:'week'}`; `result` —
  JSON-безопасная модель без `list`/`filters`/`save`. Zod `storedScenarioParamsSchema` и строгая
  `storedScenarioResultSchema` на чтении:
  `{ channels:[{channelId, model, K, S, r2, observed, current, planned, forecast}], totals, warnings }`.
  `observed` — точки `{spendCents, customers}`; `current`/`planned` — `{spendCents, customers}` с копейками
  строками; `forecast` — `{customers, revenue12Cents, cacCents, romi12}`; `totals` — сумма `planned` и прогноза.
  Схема `strict`: неизвестное поле в JSONB — `invalid`, а не молчаливое игнорирование.
  Detail рендерится **из сохранённого `result`** и не вызывает `fitSaturationCurve`/`allocateBudget`.
  Тест: сохранить, подменить фактические данные/конфиг, открыть detail — цифры остаются снимком.
- [ ] **Step 7: Audit + transaction dismiss test** — `AUDIT_ACTIONS.SCENARIO_CREATE='scenario.create'`,
  `AUDIT_ACTIONS.ALERT_DISMISS='alert.dismiss'`; `AUDIT_ENTITIES` + `scenario`, `alert`; русские подписи; dismiss
  payload `{channelId, rule, periodStart, severity, reason}`; reason ≤200, хранится только в аудите. Unit-тест:
  dismiss активного алерта вызывает audit ровно один раз с этим payload; dismiss уже закрытого —
  `ValidationError` и ни одного аудит-вызова. Integration: `dismiss` и `alert.dismiss` — одна транзакция,
  при падении аудита статус не меняется.
- [ ] **Step 8: Migration/contract tests** — `006_decisions.sql` применяется после `001`; `information_schema`
  показывает `numeric(14,4)` для `value`/`threshold`; `001` не изменён; существующие `CHECK`/`UNIQUE` на месте.
- [ ] **Step 9: Pagination** — списки алертов и сценариев отдают 50 строк на страницу (`page`, `total`,
  `hasMore`); скрытого «показать всё» нет. Тест: 51-я строка не попадает в первую страницу, `hasMore === true`.
- [ ] **Step 10: Run tests; commit** — `feat: persist alerts and scenarios`.

## Task 6: HTTP-слой, RBAC и CSRF

**Files:**
- Create: `src/validators/alerts.schema.js`, `src/controllers/alerts.controller.js`,
  `src/controllers/scenarios.controller.js`, `src/controllers/api/decisions.controller.js`,
  `src/services/decisions/index.js`
- Modify: `src/app.js`, `src/routes/app.routes.js`, `src/routes/api.routes.js`, `src/controllers/app.controller.js`
- Delete: `src/views/pages/coming-soon.ejs`
- Test: `tests/integration/alerts-screen.test.js`, `tests/integration/scenarios-screen.test.js`,
  `tests/integration/metrics-api.test.js`, `tests/integration/rbac.test.js`

**Routes (pages):**
- `GET /app/alerts` — `alerts:view`; фильтры `status=active|all|resolved|dismissed`, `severity`, `channelId`;
  пагинация `page` (50 строк). Для `alerts:manage` — авто-recalc, если
  `Date.now() - session.alertsRecalculatedAt > METRICS_CONFIG.alerts.autoRecalcMs`; это единственное место, где
  системные часы управляют операционным throttle. Подпись «Последняя проверка» берётся из
  `MAX(alerts.detected_at)` и от `Date.now()` не зависит. Кнопка «Пересчитать» работает независимо от throttle.
- `POST /app/alerts/recalculate` — `alerts:manage`, CSRF; всегда пересчитывает; redirect с сохранением фильтров.
- `POST /app/alerts/:id/dismiss` — `alerts:manage`, CSRF; body `{reason?}`; redirect с фильтрами.
- `GET /app/scenarios` — `scenarios:view`; query `budgetByn`, `channelIds`, `curveChannelId`, `page` (список, 50/стр.).
- `GET /app/scenarios/:id` — `scenarios:view`; 404 для отсутствующего id.
- `POST /app/scenarios` — `scenarios:manage`, CSRF; body `{name, budgetByn?, channelIds?}`; redirect на detail.

**Routes (API):**
- `GET /api/v1/alerts` — read-only, `alerts:view`, `no-store`.
- `POST /api/v1/alerts/recalculate`, `POST /api/v1/alerts/:id/dismiss` — `alerts:manage`, CSRF, JSON.
- `GET /api/v1/scenarios`, `GET /api/v1/scenarios/:id` — `scenarios:view`, `no-store`.
- `POST /api/v1/scenarios` — `scenarios:manage`, CSRF; 201 + detail.

- [ ] **Step 1: Failing page tests** — `/app/alerts` и `/app/scenarios` больше не содержат «следующем этапе»;
  ровно один `data-island`; `data-props` глубоко равен ответу API на том же валидном query (для алертов сначала
  страница, затем API: страница выполняет recalc, API читает уже посчитанное); фильтры алертов меняют строки;
  `/app/scenarios/:id` parity с `/api/v1/scenarios/:id`, включая `mode:'detail'`; `status=bogus` на странице →
  «active»/200, на API → 400; `budgetByn=abc`/`-1`/`0` и `> 3×` → 400.
- [ ] **Step 2: Failing RBAC/CSRF/audit tests** — viewer: GET 200, POST recalculate/dismiss/save → 403 (styled 403);
  analyst/admin: POST без `_csrf`/`X-CSRF-Token` → 403; с токеном → redirect/201; прямой POST viewer не проходит
  даже при скрытой кнопке; dismiss пишет ровно одну строку `audit_log` (`alert.dismiss`, entity `alert`, reason),
  повторный dismiss того же id — 400 без второй audit-строки.
- [ ] **Step 3: Failing dedupe/auto-throttle tests** — два GET `/app/alerts` подряд аналитиком: число `alerts`
  не растёт; второй GET не пишет; viewer GET не пересчитывает вообще; ручной POST пересчитывает даже внутри
  часа; `session.alertsRecalculatedAt` обновляется; `summary.lastRecalculatedLabel` равен `MAX(detected_at)`,
  а не времени запроса.
- [ ] **Step 4: Implement loaders** —
  `createAlertsController({ services, screenModels, referenceRepository, alertsApi=false }).{ page, load, recalculate, dismiss }`;
  `createScenariosController({ services, screenModels, referenceRepository }).{ page, detail, save, loadBuilder }`.
  Контроллер один раз берёт anchor, парсит query через Zod, вызывает сервис, строит модель; API и страница используют
  один loader. Builder отдаёт `mode:'builder'`, detail — `mode:'detail'` в `data-props`, но оба рендерят один
  вход `scenarios` (см. Task 7); восьмого entry нет.
- [ ] **Step 5: Wire composition** — `createDecisionsModule({ db, referenceRepository, auditServiceFactory, metrics })`;
  фабрика по умолчанию строится из `client` внутри транзакции, поэтому `app.js` не передаёт готовый сервис.
  `app.js` создаёт модуль после `metrics` и передаёт в `createAppRouter`/`createApiRouter`. Удалить
  `PLACEHOLDER_SECTIONS`, `createAppController`/`comingSoon` и `coming-soon.ejs` — других placeholder'ов нет.
- [ ] **Step 6: Permissions map** — добавить `DECISIONS_API_PERMISSIONS` (или расширить существующую карту с
  комментарием); тест сверяет маршрут → permission, а не дублирует список.
- [ ] **Step 7: Run integration tests; commit** — `feat: add alerts and scenarios HTTP layer`.

## Task 7: Экранные модели, графики и острова

**Files:**
- Create: `src/services/decisions/screen-models.js`, `scenario-charts.js`, `alerts-charts.js`
- Create: `src/views/pages/alerts.ejs`, `src/views/pages/scenarios.ejs`, `src/views/pages/scenario-detail.ejs`
- Create: `client/entries/alerts.jsx`, `client/entries/scenarios.jsx`, 3 chart components
- Modify: `vite.config.js`, `src/lib/assets.js`, `public/css/app.css` (только новые классы)
- Test: `tests/unit/scenarios-island.test.js`, `tests/unit/alerts-island.test.js`,
  `tests/unit/screen-models.test.js`, `tests/unit/client-guards.test.js`

**Model contracts:**
- `buildAlertsScreen({ window, rows, summary, filters, filterOptions, chart, pagination })` →
  `{page:'alerts', window, filters, filterOptions,
  summary:{active, critical, warning, resolved, dismissed, lastRecalculatedLabel, isStale},
  rows:[{id, channelId, channelName, channelCode, rule, ruleLabel, severity, severityLabel, value, valueLabel,
  threshold, thresholdLabel, periodStart, periodLabel, status, statusLabel, detectedAtLabel}],
  chart, pagination:{page,total,hasMore}, empty }`. `lastRecalculatedLabel` — из `MAX(detected_at)`, не «сейчас».
- `buildScenariosScreen({ scenario, list, query, mode='builder' })` → `{page:'scenarios', mode:'builder',
  budgetPeriod:'week', history, budget:{weeklyCents, forecast12mCents, capCents, warnAboveCents},
  controls, channels, totals, warnings, charts:{spend,customers,saturation,increment}, list, empty, error? }`.
  `budget.forecast12mCents = budgetCents * 52n`; `budget.capCents = currentWeeklyCents *
  METRICS_CONFIG.scenarios.maxBudgetMultiplier`; `budget.warnAboveCents = currentWeeklyCents *
  METRICS_CONFIG.scenarios.warnBudgetMultiplier`;
  UI подписывает «Недельный бюджет» и «12 месяцев: ×52».
- `buildScenarioDetailScreen({ scenario, mode='detail' })` → `{page:'scenarios', mode:'detail', budgetPeriod:'week'}` +
  та же result-часть из сохранённого `result` + `budget` из `params` +
  `{id,name,authorLabel,createdAtLabel,savedAnchor,invalid,invalidReason}`. Detail не пересчитывает кривые и не
  читает сырые метрики; `savedAnchor` — из `params.anchor`, а не «сегодня».

**Charts:**
- `buildSpendAllocationChart({channels})` — grouped bars `current`/`planned`, BYN, table.
- `buildCustomersForecastChart({channels})` — grouped bars `current`/`forecast`, чел., table.
- `buildSaturationCurveChart({channel, fit, observed})` — линия `q(b)` и точки наблюдений, BYN→клиенты, table.
- `buildIncrementChart({channels})` — горизонтальные бары `Δ customers`, signed, table (сознательно заменяет
  waterfall; расхождение фиксируется в `IMPROVEMENTS.md` и дизайн-спеке §8).
- `buildAlertChannelChart({channelName, weeklySeries})` — CAC-линия 12 недель, table; `weeklySeries` берётся
  **из `listWeeklySeries`** для выбранного канала, а не пересчитывается из `alerts`. Переиспользует
  `toCacPoints`/`formatCentsToByn`; один запрос, входит в бюджет `/app/alerts`.

- [ ] **Step 1: Failing chart tests** — каждый builder возвращает `title` с выводом, `caption` с периодом,
  `unit`, `hasData`, `table.columns/rows`; при пустом входе `hasData === false`, таблица не пустая (прочерки);
  ни одного `bigint`/`NaN`; линейный график ≤4 серий.
- [ ] **Step 2: Failing island tests** — SSR `renderToStaticMarkup` содержит `ChartFrame`, `role="img"`,
  `aria-label`, `<details>` + таблицу; `ComparisonBars` рисует 2 серии; `SaturationCurve` — линию и точки;
  `IncrementBars` — знак; entry монтирует ровно один остров; у каждого chart root `accessibilityLayer={false}`.
- [ ] **Step 3: Implement screen models + charts** — вся арифметика выше уже в сервисах; модели только форматируют
  (`formatCentsToByn`, `formatRatio`, `formatSignedPercent`/`formatRomi`, `formatDateTimeRu`). Отдельного
  `formatDecimal` нет. Сценарий: `current` — среднее за 4 полные недели по каждому optimizable-каналу;
  `planned` — аллокация; `before/after` — `predictConversions`. Точные формулы прогноза (в сервисе, не в модели):
  `customers = predictConversions(fit, b)` (дробное, 1 знак в UI),
  `cacCents = roundHalfUp(b_cents / customers)`, `revenue12Cents = roundHalfUp(customers * ltv12Cents)`,
  `romi12 = computeRomi({revenueCents: revenue12Cents, spendCents: budgetCents * 52n})`; при `customers === 0`
  CAC/ROMI — `null`, не ноль. ROMI считается **по каналу** (`plannedCents_i * 52n`), итог — сумма каналов;
  тест с двумя неравными аллокациями ловит ошибку «поделить общий бюджет на всех».
  Канал для CAC-графика: если в фильтре задан `channelId`, рисуется он; иначе — проблемный канал по правилу
  «сначала высшая severity (`critical` > `warning`), при равенстве — наибольший `Δ CAC` к предыдущему окну,
  при полном равенстве — меньший `channelId`» для детерминизма.
- [ ] **Step 3a: Linear fallback rendering** — канал с `model==='linear'` не входит в `planned` и KKT, но
  остаётся в списке с пометкой «линейная кривая — без оптимума» и попадает в `warnings`; `no_data` — с пометкой
  «нет данных». Тест: линейный канал не меняет `totals.planned`, но виден в `channels[].note`.
- [ ] **Step 4: EJS frames** — `scenarios.ejs`: GET-форма (range `budgetByn` в BYN: `min="0.01"`, `step="0.01"`,
  `max` — `budget.capCents` из `METRICS_CONFIG.scenarios.maxBudgetMultiplier`, а не литерал; подписи
  «Недельный бюджет» и «За 12 месяцев ×52»; предупреждение при `budgetCents > budget.warnAboveCents`; пресеты
  «Как сейчас», «+20 %», «×2» как ссылки),
  чекбоксы каналов, curve-select; save-форма с `_csrf` и hidden `budgetByn`/`channelIds`; остров. `alerts.ejs`:
  GET-фильтры + пагинация, recalc POST, EJS-таблица строк с формами dismiss (`_csrf`, `reason`), остров
  сводки+графика выбранного канала. `scenario-detail.ejs`: сохранённый снимок, warnings, 4 графика, ссылка
  «Повторить» с params; `data-props.mode === 'detail'`.
- [ ] **Step 5: Assets** — добавить `alerts`, `scenarios` в `vite.config.js` `input`, `KNOWN_ENTRIES`,
  `build-output.test.js`; итог — **семь** входов. `scenario-detail.ejs` грузит тот же `scenarios.jsx` с
  `mode:'detail'`; восьмого entry нет, guard `KNOWN_ENTRIES` и build-output остаются в паритете.
  Один `<link rel="stylesheet"` остаётся; CSS-классы только в `app.css`.
- [ ] **Step 6: Run unit + build, measure gzip** — `npm run build`; вход ≤210 KB gzip, страница ≤250 KB; записать
  числа в отчёт задачи.
- [ ] **Step 7: Commit** — `feat: add decisions screens and islands`.

## Task 8: E2E, производительность и документация

**Files:**
- Modify: `tests/integration/page-queries.test.js`, `IMPROVEMENTS.md`
- Create: `docs/screenshots/m5/*.png` (не коммитить вне docs)

- [ ] **Step 1: Add query budgets** — `/app/alerts` ≤32, `/app/scenarios` ≤12, `/app/scenarios/:id` ≤6; тест
  «нет повторного statement с теми же параметрами» должен пройти. Если alerts превышает — уменьшать чтения
  (кэш каналов), не поднимать ceiling молча.
- [ ] **Step 2: agent-browser: analyst** — вход; `/app/scenarios`; проверить, что слайдер/пресет меняет бюджет,
  «Рассчитать» перезагружает графики; сохранить сценарий с именем; открыть detail; сравнить totals; скриншоты
  `scenarios.png`, `scenario-detail.png`.
- [ ] **Step 3: agent-browser: alerts** — аналитик открывает `/app/alerts` (авто-recalc), фильтр `critical`,
  dismiss одного алерта с причиной; проверить строку/аудит; повторный пересчёт не плодит строки; скриншот `alerts.png`.
- [ ] **Step 4: RBAC в браузере** — viewer: страницы открываются, кнопок recalc/dismiss/save нет; прямой POST
  отклонён; 390×844: `alerts-390.png`, `scenarios-390.png`; `agent-browser console` без ошибок.
- [ ] **Step 5: Record findings** — не-критичное в `IMPROVEMENTS.md` (per-channel caps, waterfall/`IncrementBars`,
  scenario edit/delete, owner check, авто-recalc throttle per session, `detected_at` semantics, отсутствие
  экспорта сценариев/алертов при существующем CSV-экспорте), критичное — стоп. Отдельной строкой — **спек-нота
  §6.2**: линейная кривая исключена из KKT с предупреждением «линейная кривая — без оптимума».
- [ ] **Step 6: Full suite** — `npm test`; отчёт: что сделано, как проверено, какие решения приняты.
- [ ] **Step 7: Commit** — `test: add M5 decisions end-to-end coverage`.

## Review Focus (режимы отказа)

| Режим отказа | Ожидаемое поведение | Где тест |
|---|---|---|
| Спам алертов после повторного пересчёта | Одна строка на `(channel, rule, period_start)`; `period_start` в `unnest`/`ON CONFLICT`; `staleIds` резолвит только непопавшие; `dismissed` не воскресает, `resolved` переоткрывается | `tests/integration/alerts.test.js` (два recalc, count stable, реальный upsert), `tests/unit/alerts.test.js` (lifecycle/`staleIds`) |
| Невозможный/нулевой бюджет | 400 с русским сообщением; отвергается только `B < 1 копейки × кривых в оптимизации`; сумма аллокаций равна бюджету, «остаток потерян» невозможен; `3×` проходит | `tests/unit/budget-optimizer.test.js` (`0`, `<N`, no curves, sum invariant, 3×), `tests/integration/scenarios-screen.test.js` (POST 0/-1/oversized → 400) |
| Подгонка насыщения на плоских данных | `SST=0` не даёт `NaN`; `R²` null/низкий, `unreliable:true`; канал не участвует в KKT, если модель linear/no_data; линейный — с пометкой «линейная кривая — без оптимума» | `tests/unit/saturation.test.js` (flat, grid tolerance), `tests/unit/scenarios.test.js` (warnings, excluded) |
| Дрейф JSON сценария | `schemaVersion`/Zod; неизвестная версия → `invalid:true`, без 500 и без молчаливого пересчёта; detail читает сохранённый `result`, не подгоняет заново | `tests/integration/scenarios.test.js` (tampered JSONB, stored result), `tests/unit/scenarios.test.js` (parser) |
| Неограниченные слайдеры | HTML `max` и серверный cap из **одной** константы `scenarios.maxBudgetMultiplier = 3`; `>2×` — предупреждение; API отвергает превышение; тест cap живёт в сервисе/экране, не в чистом оптимизаторе | `tests/unit/scenarios.test.js` / `tests/integration/scenarios-screen.test.js` (oversized query), browser resize |
| Потеря точности алерта в `NUMERIC(14,2)` | `006_decisions.sql` даёт `NUMERIC(14,4)`; сравнения целые, хранение 4 знака; 2-значный UI не объявляется границей | `tests/integration/migrations.test.js` (тип колонок), `tests/unit/alerts.test.js` (порог severity) |

## Testing Matrix

| Уровень | Файлы | Что доказывает |
|---|---|---|
| Unit | `saturation.test.js`, `budget-optimizer.test.js`, `alerts.test.js`, `scenarios.test.js` | формулы, допуски «шаг сетки/±5 %», guard, окна, lifecycle/`staleIds`, JSON-схемы, linear exclusion |
| Unit UI | `scenarios-island.test.js`, `alerts-island.test.js`, `screen-models.test.js`, `client-guards.test.js` | ChartFrame/таблицы-дубли, один остров, `mode`, отсутствие fetch/CSS/inline SVG, `formatRatio` вместо дубля |
| Integration | `alerts.test.js`, `alerts-screen.test.js`, `scenarios.test.js`, `scenarios-screen.test.js`, `metrics-api.test.js`, `migrations.test.js`, `rbac.test.js`, `page-queries.test.js` | реальный upsert/`period_start`, dedupe, атомарность audit+write, RBAC/CSRF, parity, пагинация 50, бюджеты запросов |
| Determinism | `tests/helpers/decisionSeeds.js` | каждый DB-тест: `resetTestDatabase()` + `seed({anchorDate: SEED_ANCHOR})`, очистка alerts/scenarios/audit, аудит по entity/id |
| Build | `build-output.test.js` | семь входов (detail переиспользует `scenarios`), gzip-бюджеты, отсутствие CSS в assets |
| E2E | agent-browser | реальные клики, слайдер, dismiss, viewer 403, 390 px, консоль, скриншоты |

## Отложено (в `IMPROVEMENTS.md`, не в код M5)

- Per-channel caps и water-filling — отдельная задача; решение владельца №4 в M5 их запрещает.
- Линейная кривая исключена из KKT (решение №6): нужна спец-нота в §6.2 и строка в `IMPROVEMENTS.md`; в UI —
  видимое предупреждение «линейная кривая — без оптимума».
- Бесплатные каналы (Email/SEO, `spend=0`, клиенты есть) не имеют кривой «расход → клиенты» и исключаются из
  оптимизации с пометкой `no_data`; алерты по ним тоже молчат из-за guard `spend>0`. Это буквальное следствие §6–§7,
  но продуктовое решение «как учитывать бесплатный трафик в сценарии» нужно отдельно.
- Waterfall-график прироста как отдельный тип: M5 показывает вклад каналов (`IncrementBars`), а не классический
  waterfall; причина — визуальная честность и отсутствие промежуточных «накопленных» значений. Обновить
  дизайн-спеку §8 и `IMPROVEMENTS.md`, чтобы расхождение не выглядело забытым.
- Редактирование/удаление сценария и проверка владельца — M6+, вместе с `scenarios.updated_at`.
- Авто-recalc throttle хранится в сессии, а не в `users`: несколько устройств могут пересчитать чаще раза в час;
  для персонального лимита нужна колонка/таблица.
- `alerts.detected_at` обновляется при каждом пересчёте и означает «последняя проверка», а не «первое обнаружение»;
  отдельные `first_detected_at`/`resolved_at` — при следующей миграции.
- Экспорт сценариев/алертов не добавляется: существующих CSV-datasets достаточно; расширение — отдельной задачей.

## Definition of Done

- [ ] `/app/alerts` и `/app/scenarios` заменяют placeholder; один остров на страницу; `data-props` = API;
      detail использует `scenarios` с `mode:'detail'`, восьмого entry нет.
- [ ] Алерты: точные 4-недельные окна от anchor, `period_start` = понедельник, guard, dedupe по
      `(channel, rule, period_start)`, `staleIds`-резолв, `active/resolved/dismissed`, dismiss с аудитом,
      RBAC/CSRF, авто-recalc только `alerts:manage` и throttle 1 ч.
- [ ] Сценарии: 26 недель, saturation/linear/no_data, R²-предупреждение, KKT+бисекция, единый cap 3×,
      предупреждение >2×, линейная кривая вне KKT с пометкой, сохранение `params/result` JSONB, detail из
      снимка, аудит в одной транзакции.
- [ ] Миграция `006_decisions.sql` применена; `alerts.value/threshold` — `NUMERIC(14,4)`; `001` не изменён.
- [ ] Деньги — копейки/BYN, `centsFromDb` на границе, без `bigint`/`number`-смешивания, недельный бюджет и
      годовой ×52 подписаны, `null` не подменён нулём.
- [ ] Списки алертов и сценариев пагинированы по 50; DB-тесты детерминированы (`SEED_ANCHOR`, очистка, аудит по id).
- [ ] Unit/integration/E2E зелёные; бюджеты запросов и gzip соблюдены; console чист; 390 px проверен.
- [ ] `IMPROVEMENTS.md` дополнен; отчёт написан; коммиты по задачам.
