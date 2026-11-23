# M4 «Аналитика и визуализация» — план реализации

> **Для агентов:** обязательный навык — `superpowers:subagent-driven-development` (рекомендуется) или
> `superpowers:executing-plans`. Задачи выполнять по порядку, шаги отмечать `- [x]`, коммит — в конце задачи.
>
> **Модель исполнителя и ревьюера:** `opencode-go/deepseek-v4.1-flash` (`AGENTS.md` §3). Другие модели не выбирать,
> даже если кажется, что они подходят лучше.

**Цель:** показать движок M3 на пяти экранах — дашборд, каналы с рейтингом, карточка канала, когорты, атрибуция.
Каждая страница — серверный EJS-каркас с **одним** mount-узлом; React 19 рисует внутри острова все KPI, карточки,
бейджи, SVG-графики (Recharts 3) и таблицы-дубли из готовой экранной модели. M4 добавляет HTTP-слой метрик
(`GET /api/v1/*`), сборку клиента Vite 7 без dev-сервера и единый набор состояний/доступности. Новых формул нет:
всё считается сервисами M3, экран только форматирует.

**Архитектура:** `routes → controllers (Zod, anchor, resolvePeriod) → services/metrics → screen-models →
EJS-каркас + один island`. `screen-models` — единственная точка сборки экранной модели; её же отдаёт API, поэтому
страница и JSON не могут разойтись. Остров не считает и не запрашивает данные в M4: он рисует интерфейс из
`data-props`. Период, сортировка, веса, фильтр каналов и модель атрибуции — это GET-параметры и обычная
перезагрузка страницы, а не клиентский роутер. GET-формы (период, фильтры, веса, M2-форма канала) живут в
EJS-каркасе; React отвечает только за данные и графики.

**Стек:** Node 24 LTS, ESM, Express 5, EJS 3, PostgreSQL 18, Zod 4, Vitest 3 + Supertest, agent-browser.
Добавляются: `react@19`, `react-dom@19`, `recharts@3` (dependencies), `vite@7` и `@vitejs/plugin-react@5`
(devDependencies). Плагин нужен не для Fast Refresh и не для dev-сервера (их нет): он фиксирует JSX-рантайм.
Vite читает `.env` Express-процесса при разборе конфига, и при `NODE_ENV=development` плагин иначе эмитит
`jsxDEV`, которого нет в production-сборке (`jsxDEV is not a function`). Поэтому `vite.config.js` ставит
`envDir: false`, выводит `NODE_ENV` из режима и явно передаёт его в `define`; плагин остаётся единственным
местом, где выбран development/production-вариант React.
`engines.node` поднимается до `>=22.12`: это нижняя граница Vite 7; `package-lock.json` коммитится вместе с
`package.json`.

**Спеки:** `docs/superpowers/specs/2026-11-21-marketing-analytics-design.md` §5 (слои, сборка клиента),
§8 (экраны и правила интерфейса), §9 (публичная часть — M4 её не трогает), §11 (кэш, запросы), §12 (тесты);
`docs/superpowers/specs/2026-11-21-metrics-spec.md` §0.1 (data anchor), §3.2–§3.4 (подписи и статусы);
`docs/superpowers/specs/2026-11-21-assignment-traceability.md` (BO-04, BO-05, BO-06, BO-13).

**Граница этапа:** M4 заканчивается на пяти экранах, их API и общей инфраструктуре островов.
**M5: сценарии, рекомендация бюджета, алерты — отдельный план; M6: Docker multi-stage, финальный a11y/SEO-аудит.**

## Global Constraints

1. Только JavaScript, ESM, импорты с `.js`. JSX — только в `client/**`. Ни одного `.ts`/`.tsx`, ни `tsx`/`ts-node`.
2. Один stylesheet — `public/css/app.css`. React не импортирует CSS, сборка не создаёт ни одного `.css`, в `client/**`
   нет `style={{…}}`, `styled`, `sx`, CSS-модулей. Динамика (ширина, цвет) — только классами из `app.css`.
3. Слои: `controllers` ≤ 40 строк на обработчик (разбор, Zod, один вызов сервиса, `res.render`/`res.json`);
   формулы — только в `services`; `views` и React не считают, а форматируют готовые поля. Единственное исключение —
   чтение последней точки ряда для подписи-вывода (`series.at(-1).cacLabel`), это не вычисление.
4. Деньги — целые копейки. В `data-props` и JSON — **десятичные строки копеек**, никогда `bigint` и никогда `number`.
   Формат — один модуль `src/lib/format.js` (включая `formatCompactCents`); клиент импортирует его же, второго
   форматтера нет. Валюта — `<span class="byn">BYN</span>`; `$`, `₽`, `руб.` запрещены.
5. «Сегодня» — `referenceRepository.getDataAnchor()`, вызванный контроллером один раз на запрос. Системные часы для
   периодов, окон и подписей не используются. Контроллер вызывает `resolvePeriod({anchor, days, from, to})` и
   передаёт сервису готовые `{from, to}`; сервис не принимает `days` как параметр периода.
   `days` несовместим с `from`/`to` в одном запросе: схема отклоняет такую комбинацию 400, а не выбирает победителя
   молча. Произвольные `from`/`to` доступны только в API; в UI — `days ∈ {30, 90, 180}`.
6. `null` — честное «нет данных». Ноль остаётся нулём, `null` не подменяется нулём ни в сервисах, ни в графиках.
   `NaN`/`Infinity` не покидают сервис (проверено в M3); M4 не добавляет делений.
7. BigInt в `data-props`/`res.json` запрещён: `serializeDataProps` бросает `TypeError` с именем острова, а тесты
   рекурсивно проверяют модели (`assertJsonSafe`).
8. API M4 — только `GET`. У каждого маршрута `requireAuth` + `requirePermission`; мутаций нет, поэтому CSRF-токен
   не нужен (метод без побочных эффектов), и это записано в комментарии роутера. Ответы — `Cache-Control: no-store`.
9. Каждый query-параметр проходит Zod; ошибка — `ValidationError` (400, JSON `{error:{code,message}}`). Все
   сообщения схем — русские; `parseQuery` превращает первый issue в `ValidationError`, английский текст Zod
   наружу не попадает. Страницы `/app/*` остаются терпимыми к устаревшим закладкам **фильтров списка**
   (`status`/`kind=bogus` → «все», 200), API — строгим (400); невалидный период, `model` или `horizon` — 400 и на
   странице. Это осознанная асимметрия, а не «ZodError → 500»: M2-фильтры уже используют `.catch('all')`.
10. UI и подписи — русский, код — английский. Тексты живые: «Покажем, куда уходят деньги», а не «Осуществляется
    отображение». Один cyan-filled элемент на экран; статусы — точка + текст, не заливка.
11. Графики — только Recharts 3 (SVG). Запрещены пироги, 3D, canvas, градиенты, вторая ось Y у временного ряда.
    Больше 4 серий — small multiples или фильтр. CAC (BYN) и ROMI (%) не рисуются на одной оси: это два маленьких
    графика. Scatter CAC×LTV — исключение по осям: X и Y — разные измерения, третьей оси нет. Спарклайн — тоже
    Recharts (`LineChart` с фиксированными `width`/`height`, без осей и точек), не рукописный SVG.
12. У каждого графика: заголовок-вывод, подпись периода, единица, пустое состояние и таблица-дубль. Разметка:
    `<figure aria-labelledby="…-title">`, `<figcaption><h3 id="…-title">`, слот графика — `role="img"` с
    `aria-label`; `<details>` + `<table>` — **вне** поддерева `role="img"`, чтобы скринридер не читал дубль как
    часть картинки. Сетка 1px `#e8e6e5`, оси 12px, tooltip — белая карточка.
13. Никаких CDN и внешних шрифтов. Новых зависимостей, кроме перечисленных в «Стеке», нет.
14. Бюджеты запросов (`tests/helpers/queryCounter.js`): dashboard ≤ 15, channels list ≤ 14, `/api/v1/ranking` ≤ 12,
    passport ≤ 26 (M2 detail + passport 19 + матрица удержания), cohorts ≤ 5, attribution ≤ 4. Бюджет не включает
    запрос сессии (`connect-pg-simple`) и `getDataAnchor()`: оба выполняются один раз на запрос и учитываются
    отдельно. Число запросов не растёт с числом каналов/кампаний.
15. UI проверяется только в реальном браузере: `agent-browser open/click/fill/resize 390 844/console/screenshot`.
    Скриншоты — только в `docs/screenshots/m4/`.
16. Коммит — в конце каждой задачи от имени владельца репозитория, формат `type: brief description`; пуши не делать.
    `package-lock.json` коммитится вместе с `package.json`.

## Решения владельца (зафиксированы до T1)

1. **Один остров на страницу, а не на график.** EJS рендерит каркас (topbar, заголовок, GET-формы, mount-узел);
   внутри mount-узла React рисует KPI, карточки, бейджи, все графики и таблицы-дубли. `data-props` — ровно
   экранная модель; API возвращает тот же объект. Тест на каждой странице: `data-props` глубоко равен JSON API.
   Отдельных островов для графиков и продублированных моделей нет.
2. **Сборка метрик — один composition-модуль.** `src/services/metrics/index.js` создаёт `metrics.repo` и все
   сервисы/контроллеры, `src/app.js` передаёт готовый модуль в `createAppRouter`/`createApiRouter`. Роутеры не
   создают сервисы сами и не знают, как собирается движок.
3. **BO-13: фильтр каналов на дашборде — в M4.** `channelIds` (multi-select, Zod, страница + API); M3
   `getChannelHealthReport`/`getDashboardSummary` получают фильтр и пересчитывают blended-строку;
   `listWeeklySeries({channelIds})` уже поддерживает фильтр. Фильтр кампаний отложен: у атрибуции нет campaign-scope
   (см. «Отложено»). Scatter CAC×LTV добавлен на дашборд из `channels: health.rows`, без нового запроса.
4. **ROMI по каждой модели атрибуции.** `buildModelView` добавляет `totalSpendCents` и `romiPct` (через
   `computeRomi`). Это второе аддитивное изменение контракта M3 (первое — недельная атрибутированная выручка).
   Число запросов отчёта остаётся 4.
5. **Веса — четыре числовых GET-параметра** `wCac`, `wRomi`, `wLtvCac`, `wNewCustomers` (проценты 0–100), сервер
   собирает объект весов. Любая аутентифицированная роль может смотреть свой рейтинг: ранжирование read-only,
   поэтому страница и API не могут разойтись. Строкового `weights=cac:0.3,…` больше нет, скрытых полей с весами нет.
6. **Пустой дашборд:** расход и новые клиенты — измеренные нули (`0`, `0,00`), CAC и ROMI — `—`, вердикт
   `no_data`. Существующий `rbac.test.js` и запланированные проверки обновляются под это правило: четыре «—» больше
   не ожидаются, две KPI-плитки показывают нули.
7. **Экран каналов:** строки — все health-строки, включая `no_data`; у неранжируемых `rank`/`score` — `null`, причина
   в `excluded`. `kind`/`isActive` добавляются из M2-каналов. API принимает `status`/`kind`. M2-форма создания,
   CSV-экспорт и фильтры списка сохраняются в каркасе страницы.
8. **Кривая LTV когорт:** завершённая когорта с `null` наблюдаемой маржой вносит `0` в числитель и свой
   `cohortSize` в знаменатель. Это правило агрегации, а не замена `null` нулём в данных: при отсутствии завершённых
   когорт кривая остаётся `null`.
9. **EJS/React-разделение:** EJS — только каркас и mount-узел; все KPI/карточки/бейджи/графики/таблицы-дубли
   рендерит React. Пустой текст в SSR не проверяется: тест читает `data-props`. В React у каждого графика —
   `ChartErrorBoundary`.
10. **Когорты без `days`:** у когорт нет дневного периода, topbar-select на них не рендерится; anchor остаётся.
    Ссылки смены модели/горизонта сохраняют все прочие параметры, включая `days`, если он пришёл в URL вручную.

## Решения владельца: отложено с причиной (не входит в M4)

| Что | Почему отложено | Где зафиксировать |
|---|---|---|
| Фильтр кампаний на дашборде | Атрибуция считает в разрезе каналов; campaign-scope потребует отдельного прохода аллокации и изменит контракт M3. | `IMPROVEMENTS.md`, M5 |
| Stacked area «расход по кампаниям» | `listWeeklySeries` не имеет campaign-измерения; рисовать его из каналов значило бы выдать канал за кампанию. | `IMPROVEMENTS.md`, M5 |
| Фильтр каналов на экране когорт | API принимает `channelId`, но дизайн §8 не требует контрола; лишний фильтр без сценария — шум. | `IMPROVEMENTS.md` |
| «Обновить без перезагрузки» | Второй путь рендера тех же чисел; M4 оставляет один источник — SSR + `data-props`. | Решение владельца, M5 |

Остальные расхождения дизайна §8 закрыты в M4: bar расхода по каналам (T2), горизонтальный ROMI-bar (T3),
удержание в паспорте через `getCohortMatrix({channelId})` (T4), scatter CAC×LTV (T2).

## Инфраструктура островов — точное решение

- **Один вход = одна страница.** `vite.config.js` в корне: `build.outDir = 'public/assets'`, `emptyOutDir: true`,
  `publicDir: false` (иначе Vite скопирует `public/` внутрь `public/assets/` и создаст вложенный `assets/assets`),
  `build.manifest: true`, `esbuild: { jsx: 'automatic' }`, `rollupOptions.input` — явная карта пяти входов
  (`dashboard`, `channels`, `channel`, `cohorts`, `attribution` → `client/entries/<name>.jsx`). Явная карта, а не
  glob: случайный файл не должен попасть в прод-сборку. Манифест — `public/assets/.vite/manifest.json`, каталог
  уже в `.gitignore`.
- **Нет общего registry.** `client/islands/registry.js` не создаётся: каждый entry импортирует ровно свой island и
  вызывает `mountIsland`. Статический registry, тянущий все острова в каждый бандл, запрещён и проверяется
  `client-guards.test.js`.
- **Скрипты.** `"build": "vite build"`, `"build:watch": "vite build --watch"`,
  `"dev": "npm run build && node --watch src/server.js"`, `"start": "node src/server.js"`. Dev-сервера и HMR нет:
  страницы рендерит Express, второй origin в CSP и расхождение dev/prod не нужны. `build:watch` — отдельный
  процесс в другом терминале; `npm run dev` собирает один раз и перезапускает только сервер. `npm start` сборку не
  запускает. Docker-этап (build-стадия + копирование `public/assets`) — M6, здесь только запись в README.
- **Манифест в Express.** `src/lib/assets.js`:
  `createAssetManifest({ manifestPath, required = env.nodeEnv === 'production' })` →
  `{ assets(entryNames) → { scripts: string[], preloads: string[] } }`.
  Имя входа — короткое (`dashboard`), внутри превращается в ключ манифеста `client/entries/dashboard.jsx`.
  В production манифест читается один раз при старте; нет файла — `AssetManifestError` **на старте приложения**
  (сообщение называет путь и команду `npm run build`). В development/test манифест перечитывается, когда меняется
  `mtime` файла: `vite build --watch` переписывает манифест, и долгоживущий `node --watch` не должен отдавать
  старый хеш. В development/test без файла — одно предупреждение в лог и пустой список скриптов, чтобы свежий клон
  открывал страницы до первой сборки. Неизвестный вход — всегда ошибка, независимо от режима: опечатка в
  контроллере не должна тихо оставить экран без графика.
- **Статика.** `app.use('/assets', express.static(assetsDir, { immutable: true, maxAge: '1y' }))` **до**
  `express.static(publicDir)`: хешированные файлы кэшируются навсегда, `app.css` (без хеша) — по умолчанию.
  HTML — без кэша (`Cache-Control: no-store` для `/app/*`), иначе браузер покажет старый бандл после деплоя.
  `ETag`/conditional GET для `/app/*` не добавляем: лишняя ветка кэша без выигрыша для маленького HTML.
- **CSP.** Не меняется: `script-src 'self'` + nonce, `script-src-attr 'none'`, `style-src-attr 'unsafe-inline'`
  (нужен Recharts). Vite выдаёт только внешние `<script type="module" src>` — inline-скриптов и nonce у островов нет.
- **`data-props`.** EJS: `<div class="island" data-island="<%= name %>" data-props="<%= dataProps(model, name) %>">`.
  `res.locals.dataProps = dataProps`, где `dataProps(model, name)` вызывает `serializeDataProps(model, name)`:
  `JSON.stringify` + замена `<`, `>`, `&` на `\u003c`, `\u003e`, `\u0026`; исключение `JSON.stringify` переводится
  в `TypeError` с именем острова. `<%= %>` экранирует кавычки, DOM возвращает их обратно,
  `JSON.parse(node.dataset.props)` получает исходный объект, а `</script>` внутри строки физически не может
  закрыть тег. `dangerouslySetInnerHTML` и `innerHTML` запрещены.
- **Монтирование.** `client/lib/mount.js`: `mountIsland(Component, name)` находит **ровно один**
  `[data-island="${name}"]`; ноль или больше одного — явная ошибка (дубль mount-узла — ошибка разметки, а не
  повод молча выбрать первый). Парсит props, вызывает `createRoot(node).render(<ChartErrorBoundary><Component
  {...props} /></ChartErrorBoundary>)`. `hydrateRoot` не используется: сервер не рендерит содержимое, внутри
  mount-узла лежит skeleton, который React заменяет.
- **Каскад ошибок.** `ChartErrorBoundary` — классовый компонент (иначе React не ловит ошибку рендера), оборачивает
  каждый график. Падение одного графика показывает «График не построился», текст ошибки в UI не попадает, кнопка
  «Показать таблицу» остаётся; соседние карточки живут. Ошибка логируется с именем острова и именем графика.
- **Skeleton.** В mount-узле EJS кладёт `<div class="skeleton skeleton--chart" aria-hidden="true">` и
  `<noscript>`-пояснение. Пока JS не выполнился, карточка не «прыгает»: у контейнера фиксированная высота класса
  `.chart__plot`.
- **Общие чистые помощники.** `src/lib/series.js` (`toCacPoints`, `toRomiPoints`, `hasPlottableData`),
  `src/lib/contributions.js` (`toStackSegments`), `src/lib/cell-format.js` (единственная карта
  `token → formatter`), `src/lib/format.js` (`formatCentsToByn`, `formatPercent`, `formatRomi`, `formatMonths`,
  `formatRatio`, `formatInteger`, `formatCompactCents`), `src/lib/sort-rows.js`, `src/lib/heat-scale.js`,
  `src/lib/query.js` (сборка GET-ссылок с массивами). Все модули — чистый ESM без Node API; их импортируют и
  серверные screen-models, и клиентские острова. Второй копии форматтера или карты токенов нет:
  `tests/unit/cell-format.test.js` и `tests/unit/chart-theme.test.js` ловят расхождение.
- **Тема.** `client/lib/chartTheme.js` — единственный источник цветов/размеров Recharts: `canvas`, `border`,
  `grid`, `axisText`, `seriesPrimary` (`#3ba6f1`), `seriesMuted`, `healthy/watch/risk`, `tooltip` (белая карточка,
  hairline, тень), `fontSize: 12`, `strokeWidth: 2`. Значения совпадают с токенами `app.css`; тест
  `tests/unit/chart-theme.test.js` парсит `:root` из `app.css` и падает при расхождении. В компонентах нет hex.
- **Бандл-размер.** Бюджеты раздельные: **вход ≤ 210 KB gzip** и **страница (entry + shared-чанки) ≤ 250 KB
  gzip**. Вход повышен с 160 KB после замера T1: React 19 + Recharts 3.11 без неиспользуемых импортов дают
  ~206 KB gzip, это измеренный пол, а не раздутый код (см. `IMPROVEMENTS.md`). В T1 самый тяжёлый вход
  (`dashboard`) измеряется на одном экране: `npm run build`, затем
  `gzip -c public/assets/<entry>.js | wc -c` и сумма всех файлов, которые грузит страница; число записывается в
  отчёт задачи. Если превышено — убрать неиспользуемые импорты Recharts, а не дробить экраны. T7 перепроверяет оба
  бюджета на всех страницах.

## API `/api/v1/*` — контракт M4

Все маршруты монтируются в `src/routes/api.routes.js` после `requireAuth`. Общая таблица прав экспортируется рядом
с роутером (`METRICS_API_PERMISSIONS`), чтобы тест RBAC сверял маршрут с правом, а не дублировал список.

| # | Маршрут | Право | Сервис | Query (Zod) |
|---|---|---|---|---|
| 1 | `GET /api/v1/dashboard` | `dashboard:view` | `getDashboardSummary` | `days`, `from`, `to`, `channelIds` |
| 2 | `GET /api/v1/channels` | `channels:view` | `createChannelListService.getChannelList` | `days`, `from`, `to`, `status`, `kind`, `sort`, `dir`, `wCac`, `wRomi`, `wLtvCac`, `wNewCustomers` |
| 3 | `GET /api/v1/channels/:id` | `channels:view` | `getChannelPassport` + `getCohortMatrix({channelId})` | `days`, `from`, `to` |
| 4 | `GET /api/v1/ranking` | `channels:view` | `getRankingReport` | `days`, `from`, `to`, `wCac`, `wRomi`, `wLtvCac`, `wNewCustomers` |
| 5 | `GET /api/v1/cohorts` | `cohorts:view` | `getCohortMatrix` | `horizon`, `channelId`, `fromCohortMonth`, `toCohortMonth` |
| 6 | `GET /api/v1/attribution` | `attribution:view` | `getAttributionReport` | `days`, `from`, `to`, `model` |

- `src/validators/metrics.schema.js`:
  - `periodQuerySchema`: `days` — необязательный enum `METRICS_CONFIG.periods.options`, `from`/`to` —
    `^\d{4}-\d{2}-\d{2}$`; `.refine`, что `days` не приходит вместе с `from` или `to`. Дефолт `days` применяет
    `resolvePeriod`, а не схема: иначе `from` без `days` получил бы 30 и конфликтовал с собственным refine.
    `from` без `to` допустим (M2-экспорт), `to` без `from` допустим (окно от начала до даты).
  - `channelIdsQuerySchema`: повторяющиеся `channelIds=1&channelIds=2` **или** `channelIds=1,2`; preprocess
    нормализует в массив, каждый элемент — `^\d+$`, минимум один. Пустой параметр — issue, а не «все каналы».
    Разбор — чистая `parseChannelIds`, ею же пользуется страница.
  - `cohortQuerySchema`: `horizon` — enum `METRICS_CONFIG.ltv.horizons`, по умолчанию `defaultHorizon`;
    `channelId` — `^\d+$`; `fromCohortMonth`/`toCohortMonth` — `^\d{4}-\d{2}(-01)?$`.
  - `attributionQuerySchema`: period + `model` — enum `METRICS_CONFIG.attribution.models`.
  - `weightsQuerySchema`: четыре необязательных числа `0…100`, все четыре вместе или ни одного; сумма > 0.
    `parseWeightParams` — чистая функция, собирает `{cac, romi, ltvCac, newCustomers}` как доли; её вызывает и
    страница каналов, и API, поэтому дефолт и кастомные веса не расходятся.
  - `channelsQuerySchema`: `status` — enum `all|active|archived`, `kind` — enum `all|paid|owned|earned`,
    `sort` — enum из `CHANNEL_SORT_FIELDS`, `dir` — `asc|desc`. Для API — строгий parse (400), для страницы —
    `channelFiltersSchema` с `.catch('all')` (200, «все»). Это записано в комментарии обеих схем.
- Контроллеры — `src/controllers/api/metrics.controller.js`, каждый ≤ 15 строк: `parseQuery` → `getDataAnchor()` →
  `resolvePeriod({anchor, ...periodQuery})` → один вызов сервиса → `screenModel` → `res.json`. `res.set(
  'Cache-Control', 'no-store')` стоит один раз в роутере. Сервис получает `{from, to}`, а не `days`: тест
  `days=180` проверяет, что в сервис пришло окно ровно 180 дней, а не 30.
- Ответ = ровно тот `data-props`, который получает страница (см. `screen-models`), поэтому API-тест и SSR-тест
  сравнивают один объект. `/api/v1/ranking` — исключение: отдаёт сырой отчёт M3 (ranked/excluded/weights), потому что
  им пользуются тесты весов и M5.
- Тест на маршрут (в `tests/integration/metrics-api.test.js`): (а) аноним → 401 JSON; (б) `viewer` → 200 и
  `METRICS_API_PERMISSIONS[route]` совпадает с ожидаемым правом; (в) невалидный параметр (`days=45`, `horizon=7`,
  `wCac=-1`, `channelId=abc`, `days=30&from=2026-01-01`) → 400 с `code: 'VALIDATION_ERROR'` и без SQL-ошибки;
  (г) пустая БД → 200 с честными `null`/`[]`/`no_data`, без `NaN` и без `bigint`; (д) `?status=bogus` → 400, а
  страница `/app/channels?status=bogus` → 200. Для `channels/:id` роль пустой БД играет «канал есть, статистики
  нет»: тест вставляет один канал и проверяет `health.status === 'no_data'`, `campaigns: []`.
  Отдельно: `GET /api/v1/channels/999999` → 404 JSON. 403 недостижим (все view-права есть у viewer) — это
  зафиксировано в комментарии теста, а поведение `requirePermission` покрыто существующим RBAC-набором.

## Изменения в M3 (два аддитивных поля контракта + необязательные входы)

1. **Недельная атрибутированная выручка.** `weeklySeries` в `dashboard.service` и `channel-passport.service` не
   содержит недельной выручки, поэтому бар «расход/выручка» пришлось бы считать из ROMI — это округление и вторая
   формула. В `buildWeeklySeries` добавляются `attributedCents: string` (копейки, `'0'` для недели без атрибуции) и
   `attributedLabel: string` (`formatCentsToByn`). Источник — уже полученный `attributedRows`; новых запросов нет.
   Это закрывает и открытый пункт `IMPROVEMENTS.md` «dashboard weekly test recomputes the attributed series».
   Обновляются `tests/unit/weekly-series.test.js`, `tests/unit/dashboard.test.js`,
   `tests/integration/metrics-view-models.test.js`; если в наборе есть сохранённая golden-фикстура недельного ряда,
   она перегенерируется в том же коммите, а дифф проверяется глазами (новые поля, старые не сдвинулись).
2. **ROMI по каждой модели.** `buildModelView` добавляет `totalSpendCents: string` (сумма spend по каналам периода)
   и `romiPct: number|null` (`computeRomi({revenueCents: totalAttributed, spendCents: totalSpend})`). Модели
   различаются только числителем — расход один и тот же, и это явно в подписи. `totalSpendCents` берётся из уже
   загруженного `listChannelSpend`; число запросов отчёта остаётся 4 (`listOrdersInPeriod`,
   `listTouchpointsForOrders`, `listChannelSpend`, `listChannels`). Обновляются `tests/unit/attribution.test.js`,
   `tests/integration/attribution.test.js`, `tests/integration/metrics-view-models.test.js`.
3. **Необязательные входы для BO-13.** `getChannelHealthReport({channelIds})`, `getDashboardSummary({channelIds})`,
   `getAttributionSeries({channelIds})` и `getChannelLtv({channelIds})` принимают массив id. Форма ответа не меняется,
   кроме двух аддитивных полей: `getDashboardSummary` возвращает `channels: health.rows` для scatter и бара
   расхода и `availableChannels` — полный список каналов для multi-select (иначе после фильтра в форме остались бы
   только выбранные). Оба поля — уже загруженные строки, а не второй вызов health. При `null` поведение прежнее.
   `getChannelHealthReport` фильтрует строки и **пересчитывает blended**: spend и newCustomers — суммы
   отфильтрованных строк CAC, revenue — сумма атрибуции по выбранным каналам, LTV — точный blended из
   `getChannelLtv` с тем же фильтром (не среднее округлённых LTV), CAC/ROMI — через существующие
   `computeCac`/`computeRomi`, статус — через `deriveHealth`. `getDashboardSummary` передаёт фильтр в health,
   `listWeeklySeries` и `getAttributionSeries`; период остаётся отдельным входом: контроллер уже разрешил его в
   `{from, to}`.
   Тесты: `tests/unit/dashboard.test.js`, `tests/unit/channel-health.test.js` (если файла нет — новый),
   `tests/unit/attribution.test.js`, `tests/integration/metrics-view-models.test.js`.

## Карта файлов M4

```
vite.config.js
client/entries/{dashboard,channels,channel,cohorts,attribution}.jsx
client/lib/{mount,chartTheme}.js
client/components/ui/{Card,Kpi,HealthBadge,EmptyState,Skeleton}.jsx
client/components/charts/{ChartFrame,ChartErrorBoundary,ChartTooltip,CacRomiLines,SpendRevenueBars,
                          ChannelSpendBars,CacLtvScatter,RomiBars,Sparkline,ScoreStack,RetentionGrid,
                          AttributionBars,CohortCurve}.jsx
src/lib/{assets,validation,serialize-props,cell-format,series,contributions,sort-rows,heat-scale,query}.js
src/lib/format.js                              (modify: +formatCompactCents)
src/validators/metrics.schema.js
src/services/metrics/index.js                  (composition)
src/services/metrics/{screen-models,chart-series,channel-list.service}.js
src/controllers/{dashboard,cohorts,attribution}.controller.js
src/controllers/api/metrics.controller.js
src/views/partials/{island,island-scripts}.ejs
src/views/pages/{dashboard,channels,channel-detail,cohorts,attribution}.ejs
Modify: package.json, package-lock.json, src/app.js, src/routes/{app,api}.routes.js,
        src/controllers/{app,channels}.controller.js, src/views/layouts/app.ejs,
        src/views/partials/topbar.ejs, public/css/app.css,
        src/services/metrics/{weekly-series,dashboard,channel-passport,attribution,ltv}.service.js,
        README.md, IMPROVEMENTS.md
Не создавать: src/lib/sparkline.js (спарклайн — React/Recharts, рукописный SVG не нужен)
tests/unit/{assets,serialize-props,chart-theme,validation,series,contributions,sort-rows,heat-scale,
            cell-format,chart-series,screen-models,channel-list,channel-health,weekly-series,dashboard,ltv,query,
            client-guards}.test.js
tests/integration/{metrics-api,dashboard-screen,channels-screen,passport-screen,cohorts-screen,
                   attribution-screen,states,assets-runtime,build-output,assets-strict}.test.js
tests/helpers/{dataProps,jsonSafe}.js
docs/screenshots/m4/ + README.md
```

Порядок: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8. T2–T6 правят общие файлы: `src/app.js`,
`src/routes/app.routes.js`, `src/routes/api.routes.js`, `src/controllers/api/metrics.controller.js`,
`src/services/metrics/screen-models.js`, `src/services/metrics/chart-series.js`, `public/css/app.css`.
Поэтому параллельно — только в отдельных worktree и с явным порядком слияния; иначе последовательно.
T5 и T6 не зависят от данных друг друга, но общие файлы всё равно делают их последовательными.

---

### Task 1: Инфраструктура островов и вертикальный срез дашборда (KPI, вердикт, CAC/ROMI)

**Files:**
- Create: `vite.config.js`, `src/services/metrics/index.js`,
  `src/lib/{assets,validation,serialize-props,cell-format,series}.js`,
  `client/entries/dashboard.jsx`, `client/lib/{mount,chartTheme}.js`,
  `client/components/ui/{Card,Kpi,HealthBadge,EmptyState,Skeleton}.jsx`,
  `client/components/charts/{ChartFrame,ChartErrorBoundary,ChartTooltip,CacRomiLines}.jsx`,
  `src/views/partials/{island,island-scripts}.ejs`, `src/controllers/dashboard.controller.js`,
  `src/controllers/api/metrics.controller.js`, `src/services/metrics/{screen-models,chart-series}.js`
- Modify: `package.json`, `package-lock.json`, `src/app.js`, `src/routes/{app,api}.routes.js`,
  `src/controllers/app.controller.js` (убрать dashboard), `src/views/pages/dashboard.ejs` (заменить),
  `src/views/layouts/app.ejs`, `src/views/partials/topbar.ejs`, `src/lib/format.js` (+`formatCompactCents`),
  `public/css/app.css` (`.island`, `.chart*`, `.kpi--*`), `tests/integration/rbac.test.js`
- Test: `tests/unit/{assets,serialize-props,chart-theme,validation,series,screen-models}.test.js`,
  `tests/unit/format.test.js` (расширить), `tests/integration/{dashboard-screen,metrics-api,assets-runtime,
  build-output}.test.js`

**Interfaces:**
- `createMetricsModule({ db, referenceRepository })` → `{ repository, services, controllers, screenModels }`.
  В T1 создаёт `metricsRepository` и сервисы `cac`, `ltv`, `attribution`, `channelHealth`, `ranking`, `dashboard`;
  репозитории `channels`, `campaigns`, `cohorts`, `attribution` строятся из того же `db` (инстансы без состояния,
  дубль с M2 безвреден). Контроллеры `dashboard` и `api`. T3–T6 добавляют в модуль
  passport/cohort/attribution-контроллеры, не меняя сигнатуру. M2-контроллер каналов остаётся владельцем формы
  создания и её error-path, но получает `channelListService`/`passportService` из модуля, а не строит их сам.
  `src/app.js` вызывает модуль один раз и передаёт `metrics` в оба роутера; ни роутер, ни новый контроллер не
  создают сервисы.
- `createAssetManifest({ manifestPath, required })` → `{ assets(entryNames): { scripts, preloads } }`;
  `AssetManifestError` (не `AppError`: это ошибка конфигурации, не запроса). `absoluteAssetPath(src)` для тестов.
- `serializeDataProps(value, label)` → экранированная JSON-строка; `dataProps(model, name)` — та же функция с
  именем острова в `TypeError`. `parseQuery(schema, query)` → `safeParse`; первый issue → `ValidationError` с
  русским сообщением (fallback «Некорректный параметр запроса»).
- `buildDashboardScreen({ summary })` → `{ page: 'dashboard', period, filter: { channelIds: null }, kpis, verdict,
  charts: { cac, romi }, labels }`; chart = `{ id, title, caption, unit, hasData, series, table }`.
  `caption` — факт: «CAC по неделям · 12 недель · последняя 34,20 BYN».
- `toCacPoints(series)` / `toRomiPoints(series)` / `hasPlottableData(points)` — в `src/lib/series.js`; `null`
  сохраняется, `[null, 0]` — валидный ряд (ноль измерен), `[null, null]` — пусто.
- `mountIsland(Component, name)`; `ChartErrorBoundary`; `ChartFrame({ title, caption, unit, ariaLabel, empty, table,
  children })` — `<figure aria-labelledby>`, `<figcaption><h3 id>`, слот `role="img"`, `<details>` + `<table>` вне
  слота, пустое состояние вместо нулевой линии.
- `buildPeriodControl({ query })` → `{ days, options, preserve: [{name,value}] }`; страницы без дневного периода
  (когорты, T5) передают `period: null`, и select не рендерится вовсе.
- Dashboard controller: `GET /app/dashboard?days=` → `resolvePeriod` → `getDashboardSummary({anchor, from, to})` →
  `screenModel` → EJS + `islandEntries: ['dashboard']`. API route 1 возвращает тот же объект. Фильтр `channelIds`
  добавляется в T2; в T1 схема его не принимает.

- [ ] **Шаг 1 — падающие тесты.** `assets.test.js`: валидный манифест из `tests/fixtures/asset-manifest.json` →
  `assets(['dashboard'])` даёт `/assets/dashboard-<hash>.js` и preload для shared-чанка; неизвестный вход → ошибка
  с именем входа; `required: true` без файла → `AssetManifestError` с путём и `npm run build`; `required: false`
  без файла → `{scripts: [], preloads: []}`; после перезаписи манифеста и `utimes` (non-production) `assets()`
  отдаёт новый хеш, а в production — старый до перезапуска. `serialize-props.test.js`:
  `</script><script>alert(1)</script>`, `"onmouseover="`, `&`, `\u2028`, `<img onerror>` → в строке нет `<`/`>`/`&`,
  `JSON.parse` возвращает исходную строку; `{cents: 5000n}` → `TypeError` с меткой; `dataProps(model, 'dashboard')`
  называет остров. `chart-theme.test.js`: каждый hex темы присутствует в `:root` `app.css`, `fontSize === 12`,
  `seriesPrimary === '#3ba6f1'`. `validation.test.js`: невалидный query → `ValidationError` с русским текстом,
  валидный → данные; `ZodError` не утекает; `days` + `from` → 400. `format.test.js`: `formatCompactCents(123400)`
  → `1 234`, `(12_340_000)` → `12,3 тыс.`, `null` → `—`. `series.test.js`: `null` не становится нулём;
  `hasPlottableData` false для `[null,null]` и true для `[null,0]`.
  `screen-models.test.js` (секция dashboard): KPI из `blended`, подписи «30 дней»/«12 недель», `hasData` для
  CAC/ROMI, `JSON.stringify` без `bigint`. `dashboard-screen.test.js`: 200 для viewer; в SSR ровно один
  `[data-island="dashboard"]`, нет текста KPI (React ещё не выполнился), есть `skeleton--chart` и `<noscript>`;
  `data-props` парсится и **глубоко равен** ответу `/api/v1/dashboard?days=30`; пустая БД → две плитки показывают
  измеренные нули (`spendLabel === '0,00'`, `newCustomersLabel === '0'`), CAC и ROMI — `—`
  (`cacLabel`, `romiLabel`), `verdict.status === 'no_data'`.
  `rbac.test.js` обновляется: вместо четырёх `kpi__value">—<` и SSR-текста «Данных пока нет» проверяются props
  пустого дашборда; страница по-прежнему 200. `metrics-api.test.js`: маршрут 1 по схеме «API-тест на маршрут»,
  включая `days=180` → сервис получил окно 180 дней (spy или переданный период в ответе).
  `assets-runtime.test.js`: `/app/dashboard` в `NODE_ENV=test` без манифеста не падает и не содержит
  `<script type="module">`; `createApp` с инжектированным манифестом-заглушкой рендерит `src` из заглушки;
  `/app/dashboard` отвечает `Cache-Control: no-store`, `Content-Security-Policy` содержит `script-src 'self'` и не
  содержит `unsafe-inline` для скриптов; `/assets/...` отвечает `Cache-Control: public, max-age=31536000,
  immutable`.
  `build-output.test.js` (пропускается, если `public/assets` нет): в `public/assets` нет вложенного `assets/`,
  нет `.css`, манифест существует.
- [ ] **Шаг 2 — падение.** `npx vitest run tests/unit/assets.test.js tests/unit/serialize-props.test.js
  tests/unit/chart-theme.test.js tests/unit/validation.test.js tests/unit/series.test.js
  tests/unit/screen-models.test.js tests/unit/format.test.js tests/integration/dashboard-screen.test.js
  tests/integration/metrics-api.test.js tests/integration/assets-runtime.test.js
  tests/integration/build-output.test.js tests/integration/rbac.test.js` → FAIL.
- [ ] **Шаг 3 — реализация.** Поставить `react`, `react-dom`, `recharts`, `vite`; `engines.node >=22.12`;
  `vite.config.js` по разделу «Инфраструктура»; `assets.js` читает манифест лениво и перечитывает по `mtime` в
  non-production; `assets()` склеивает `file` входа + `imports` (рекурсивно, без дублей), `preloads` — те же
  импорты. `src/app.js` создаёт `metrics = createMetricsModule(...)`, манифест, кладёт `dataProps`/`assetScripts`
  в locals, ставит `Cache-Control: no-store` для `/app/*` и монтирует `/assets` immutable до
  `express.static`. `createApp({ db, sessionStore, trustProxy, assets })` принимает готовый манифест, чтобы тест
  подставил заглушку. Layout добавляет
  `include('../partials/island-scripts')`, читающий `locals.islandEntries ?? []`. Topbar: `<form method="get">` с
  `days` + скрытыми `preserve`, `action` = текущий путь, подпись «Данные по …» остаётся. Dashboard EJS — каркас:
  заголовок, topbar, один mount-узел, `noscript`; KPI/вердикт/графики рендерит `DashboardIsland`. CSS: `.island`,
  `.chart`, `.chart__head`, `.chart__plot` (фиксированная высота 240/180), `.chart__table`, `.chart__empty`,
  `.skeleton--chart`, `.kpi--bad`, `.badge--no-data`; только токены, без новых hex.
- [ ] **Шаг 4 — проверка и коммит.** Тесты PASS. `npm run build`, **замерить** gzip самого тяжёлого входа
  (`dashboard`) и сумму файлов страницы, записать числа в отчёт (бюджеты 210/250 KB). Браузер:
  `agent-browser open http://localhost:3000/app/dashboard`, `snapshot -i`, `console` (пусто), клик по точке →
  tooltip в BYN, `<details>` раскрывает таблицу, `screenshot /tmp/m4-t1.png`. Удалить `public/assets` и убедиться,
  что страница открывается без островов и в логе одно предупреждение; `NODE_ENV=production` + отсутствующий
  манифест → процесс не стартует с внятным сообщением. Commit:
  `feat: add island pipeline and dashboard shell with kpi cac romi`

---

### Task 2: Дашборд — недельные ряды, расход/выручка, фильтр каналов и scatter CAC×LTV

**Files:**
- Create: `client/components/charts/{SpendRevenueBars,ChannelSpendBars,CacLtvScatter}.jsx`, `src/lib/query.js`
- Modify: `client/entries/dashboard.jsx`, `src/views/pages/dashboard.ejs` (форма фильтра в каркасе),
  `src/services/metrics/{weekly-series,dashboard}.service.js`, `src/services/metrics/{screen-models,chart-series}.js`,
  `src/controllers/dashboard.controller.js`, `src/controllers/api/metrics.controller.js`,
  `src/routes/{app,api}.routes.js`, `src/validators/metrics.schema.js`, `public/css/app.css`
- Test: `tests/unit/{weekly-series,dashboard,channel-health,query}.test.js` (расширить/новый),
  `tests/unit/screen-models.test.js` (dashboard), `tests/integration/{dashboard-screen,metrics-api}.test.js`
  (маршрут 1 расширить)

**Interfaces:**
- `getDashboardSummary({ anchor, from, to, channelIds })` → прежние поля + фильтр, `channels: health.rows`
  (JSON-safe строки health, включая `cacCents`/`ltv12Cents`) и `availableChannels` (полный список каналов для
  multi-select, даже когда `channels` отфильтрованы); `channelIds === null` — все. Внутри: health с фильтром,
  `listWeeklySeries({ channelIds })`, `getAttributionSeries({ channelIds })`. Фильтр не меняет число запросов;
  `channels` и `availableChannels` — уже полученные строки, без второго вызова health.
- `buildDashboardScreen({ summary })` → `charts: { cac, romi, spendRevenue, channelSpend, cacLtv }`,
  `filter: { channelIds, selected }`, `channelOptions` из `summary.availableChannels` (полный список, не
  отфильтрованный); `channels` для scatter и bar берутся из `summary.channels` (`health.rows`). `channelSpend` —
  горизонтальный `BarChart` расхода по каналам; `cacLtv` — `ScatterChart` по `cacCents`/`ltv12Cents`, каналы без
  обоих значений в таблицу-дубль попадают с «—», но точку не рисуют.
- `buildWeeklySeries` добавляет `attributedCents`, `attributedLabel` (см. изменения M3).
- `SpendRevenueBars`: 12 недель, spend — stone, attributed revenue — cyan; легенда «Расход» / «Выручка
  (атрибуция, последнее касание)». `ChannelSpendBars`: расход по каналам, cyan — выбранный/крупнейший.
  `CacLtvScatter`: оси CAC (BYN, X) и LTV12 (BYN, Y), без третьей оси; tooltip — канал, CAC, LTV.
- Форма фильтра — в EJS-каркасе: `<select name="channelIds" multiple>` + скрытый `days`, `action=/app/dashboard`.
  Выбранные каналы попадают в `filter.selected`; подпись графика называет фильтр («выбрано 3 канала»).
- `days=180` доходит до сервиса как 180-дневное окно; `days` + `from` отклоняется схемой.

- [ ] **Шаг 1 — падающие тесты.** `query.test.js`: `buildQueryString({days:90, channelIds:['1','2']}, {sort:'cac'})`
  даёт `days=90&channelIds=1&channelIds=2&sort=cac`, сохраняет массивы и не теряет чужие ключи при patch.
  `weekly-series.test.js`: `attributedCents` равен сумме `attributedRows` недели,
  `'0'` при отсутствии, `attributedLabel` — `formatCentsToByn`; неделя вне окна не расширяет ось.
  `dashboard.test.js`: 12 полных недель Mon–Sun, последняя ≤ `period.to`; KPI — из **отфильтрованного** blended;
  `channels` равен health-строкам (без второго вызова health); `availableChannels` содержит все каналы даже при
  активном фильтре; фильтр `[instagram]` даёт spend/newCustomers только этого канала, CAC = spend/customers,
  revenue = атрибуция канала, blended LTV — точный из `getChannelLtv({channelIds})`; отсутствие параметра — все
  каналы, пустой `channelIds=` — 400 от схемы;
  фильтр с несуществующим id — нули/`no_data`, не 500. `screen-models.test.js`: пять графиков, у scatter нет
  строк без CAC/LTV, таблица-дубль содержит все отфильтрованные каналы; подпись фильтра. `dashboard-screen.test.js`: форма
  `channelIds` в каркасе, выбранные значения сохраняются; `data-props` глубоко равен
  `/api/v1/dashboard?days=30&channelIds=…`; `?channelIds=1,2` и повторяющийся `channelIds` дают одну модель.
  `metrics-api.test.js`: `channelIds=abc` → 400; `channelIds` без значения → 400; `days=30&from=…` → 400;
  бюджет запросов dashboard ≤ 15 на 8 каналах и на 1.
- [ ] **Шаг 2 — падение.** `npx vitest run tests/unit/query.test.js tests/unit/weekly-series.test.js
  tests/unit/channel-health.test.js tests/unit/dashboard.test.js tests/unit/screen-models.test.js
  tests/integration/dashboard-screen.test.js tests/integration/metrics-api.test.js` → FAIL.
- [ ] **Шаг 3 — реализация.** В health/dashboard добавить `channelIds`, пересчёт blended по правилу из раздела
  M3; `getAttributionSeries` фильтрует аллокации по set после аллокации (канал получает свою долю, а не
  перераспределение заказа); `getChannelLtv` фильтрует entries/channels до `buildChannelLtv`, чтобы blended был
  точным. Scatter и bar расхода — из `health.rows`, без новых запросов. CSS — только токены.
- [ ] **Шаг 4 — проверка и коммит.** Тесты PASS. Браузер: `/app/dashboard` на сиде — пять графиков,
  scatter показывает точки; выбрать два канала → KPI, графики и подписи сузились; снять выбор → все; `?days=180` меняет
  цифры; `resize 390 844` — одна колонка, таблицы скроллятся; `console` пусто. Commit:
  `feat: add dashboard channel filter spend revenue and cac ltv scatter`

---

### Task 3: Каналы — таблица, сортировка, health, спарклайн, стек-бар, ROMI-bar и веса

**Files:**
- Create: `client/entries/channels.jsx`, `client/components/charts/{ScoreStack,RomiBars,Sparkline}.jsx`,
  `src/lib/{contributions,sort-rows}.js`, `src/services/metrics/channel-list.service.js`
- Modify: `src/services/metrics/chart-series.js`, `src/controllers/channels.controller.js` (list),
  `src/views/pages/channels.ejs` (каркас: фильтры, M2-форма, экспорт, mount),
  `src/repositories/metrics.repo.js` (добавить `listChannelWeeklyCacInputs`),
  `src/validators/metrics.schema.js`, `src/controllers/api/metrics.controller.js`, `src/routes/api.routes.js`,
  `src/services/metrics/{screen-models,index}.js`, `public/css/app.css`
- Test: `tests/unit/{sort-rows,contributions,channel-list,chart-series,screen-models}.test.js`,
  `tests/integration/{channels-screen,metrics-api}.test.js` (маршруты 2 и 4), `tests/integration/channels.test.js`
  (регрессия M2)

**Interfaces:**
- `createChannelListService({ healthService, metricsRepository, channelsRepository })` →
  `getChannelList({ anchor, from, to, status, kind, sort, dir, weights })` →
  `{ period, filters, weights, weightsBasisPoints, rows, blended, excluded, sparklines, chart: { romi }, labels }`.
  Health вызывается **один раз**; `kind`/`isActive` добавляются из `channelsRepository.listChannels()` (один
  дополнительный запрос). `computeRanking({channels:[...health.rows, blended], weights})` — чистая функция;
  `getRankingReport` здесь не вызывается, иначе health считался бы дважды.
- **Все health-строки — в таблице.** Ранжирование считается по полному набору health-строк; `status`/`kind`
  применяются к отображению **после** ранжирования, поэтому фильтр `status=archived` не меняет ранги. Строка
  `no_data`/`missing_criterion` остаётся видимой с `rank: null`, `score: null`; причина — в `excluded`
  (`{code, reason, reasonLabel}`). `blended` в таблицу не попадает (это сводка), но остаётся в `excluded` с
  причиной `blended`. Порядок `excluded` повторяет порядок строк, `blended` — последним.
- `listChannelWeeklyCacInputs({ from, to })` → `[{channelId, weekStart, spendCents: bigint, newCustomers: number}]`
  одним SQL (GROUP BY channel, week); CAC недели считается в памяти через `computeCac`, окно — то же, что у
  графика дашборда (`resolveWeekRange(period.to, METRICS_CONFIG.dashboard.weeks)`). Это один запрос на весь список,
  не один на строку.
- `toSparklinePoints(weeklyCacRows)` → `[{weekLabel, value: number|null}]` для одного канала: CAC по неделям,
  `null` там, где нет клиентов/расхода; helper живёт в `chart-series.js`, компонент только рисует.
- `sortChannelRows(rows, { sort, dir })` → новый массив; `CHANNEL_SORT_FIELDS` с `defaultDir`
  (`rank`/`score`/`revenue`/`newCustomers` — `desc`, `cac` — `asc`, `health` — `asc` по
  `risk → watch → healthy → no_data`); деньги сравниваются как `BigInt(cents)`, не строкой (`'1000' < '900'`
  было бы ошибкой); `null` всегда в конце, tie-break — `code`.
- `toStackSegments(row)` → `[{criterion,label,value,scored,weight}]`, `Σ value === row.score ± 0.05`;
  `value = contribution`, `scored` — из `contributions[]` (для CAC это `1 - norm`).
- `Sparkline({ values })` — Recharts `LineChart` с фиксированными `width={72}` `height={20}`, без осей, сетки,
  точек и анимации; `null`-точки разрывают линию (`connectNulls={false}`), < 2 чисел — пустая ячейка «—».
  Рукописного SVG нет.
- `RomiBars` — горизонтальный `BarChart` ROMI по каналам (cyan — выбранный/лидирующий, stone — остальные).
- Веса: форма в EJS-каркасе, только если `can('channels:view')` (любая роль); четыре числовых поля
  `name="wCac"` и т.д., `step="1"`, `min="0"`, `max="100"`, предзаполнены текущими весами в процентах; скрытые
  `days`, `status`, `kind`, `sort`, `dir`.
  `parseWeightParams` на сервере собирает веса; API принимает те же четыре параметра. Если ни один не задан —
  `METRICS_CONFIG.ranking.weights`. Неверная сумма/частичный набор — 400.
- URL: `/app/channels?status=&kind=&days=&sort=&dir=&wCac=&wRomi=&wLtvCac=&wNewCustomers=`. Страница парсит
  `status`/`kind` через `channelFiltersSchema` (`.catch('all')`, 200), а `sort`/`dir`/веса — строго; API парсит всё
  через `channelsQuerySchema` (400). Ссылки сортировки строятся `buildQueryString(current, patch)` из
  `src/lib/query.js` и сохраняют **все** фильтры, включая `days` и веса; массивы (`channelIds`) кодируются
  повторяющимися параметрами. Форма фильтров тоже несёт `days`/`sort`/`dir`/веса скрытыми полями: смена статуса
  не должна молча сбрасывать период и порядок. Экспорт сохраняет свои `status`/`kind` (его схема не знает
  `sort`/веса) и не отправляет лишние параметры.

- [ ] **Шаг 1 — падающие тесты.** `sort-rows.test.js`: CAC по возрастанию, деньги сравниваются BigInt
  (`1000` после `900` при asc), `null` в конце в обоих направлениях, `health` — worst first, равные значения по
  `code`, исходный массив не мутируется. `chart-series.test.js` (секция sparkline): `toSparklinePoints` сохраняет
  `null` и порядок недель, пустой ряд — `[]`. `contributions.test.js`: дешёвый канал получает больший CAC-сегмент;
  `Σ === score` в допуске 0.05; сегментов всегда 4 и порядок `cac, romi, ltvCac, newCustomers`.
  `channel-list.test.js`: health вызван один раз на 8 каналах и на 1; `no_data` остаётся в `rows` с `rank: null`,
  `blended` есть только в `excluded` (в таблицу не попадает); `status=archived` не меняет ранги; `kind`/`isActive`
  присутствуют; viewer с `wCac=…` получает кастомные веса (ранжирование read-only). `screen-models.test.js`: таблица и `excluded`
  согласованы, ROMI-bar содержит все каналы с `romiPct !== null`. `channels-screen.test.js`: 8 строк, спарклайн
  Recharts (`<svg>` внутри ячейки), `aria-sort` на активном `<th>`, ссылка сортировки сохраняет `days`/`status`;
  `data-props` = ответ `/api/v1/channels` с теми же `sort`/весами; `?status=bogus` на странице → 200 («все»),
  в API → 400 (осознанная асимметрия, см. Global Constraints §9). `channels.test.js` (M2, регрессия): форма
  создания, `45,00`, `name="targetCacByn"`, CSV-экспорт и фильтры списка на месте. `metrics-api.test.js`:
  маршруты 2 и 4; для `/api/v1/ranking` — `Σ contributions === score`, `weightsBasisPoints` суммируются в 1000,
  `excluded` содержит `blended`; `wCac=abc`/частичный набор → 400. Бюджет channels ≤ 14, ranking ≤ 12.
- [ ] **Шаг 2 — падение.** `npx vitest run tests/unit/sort-rows.test.js tests/unit/contributions.test.js
  tests/unit/channel-list.test.js tests/unit/chart-series.test.js tests/unit/screen-models.test.js
  tests/integration/channels-screen.test.js tests/integration/channels.test.js
  tests/integration/metrics-api.test.js` → FAIL.
- [ ] **Шаг 3 — реализация.** Health — один раз; метаданные M2 — один запрос; спарклайны — из тех же недельных
  данных, что у дашборда (окно `resolveWeekRange(period.to, METRICS_CONFIG.dashboard.weeks)`), но **без**
  рукописного пути: `Sparkline` получает готовый массив `{weekLabel, value}`. Таблица в React: место, канал
  (ссылка), расход, новые клиенты, CAC, LTV12, ROMI, payback, LTV:CAC, статус, спарклайн. Стек-бар — один
  горизонтальный `BarChart`, cyan только крупнейший сегмент. Форма весов и M2-форма — в каркасе, не в острове.
- [ ] **Шаг 4 — проверка и коммит.** Тесты PASS. Браузер: `/app/channels` — сортировка по CAC меняет порядок и
  сохраняет фильтры; `?wCac=0&wRomi=100&wLtvCac=0&wNewCustomers=0` переставляет каналы; viewer видит форму и
  получает свой рейтинг (read-only); `?status=bogus` показывает все; клик по строке ведёт на паспорт;
  `resize 390 844` — таблица скроллится, спарклайн не ломает строку; `console` пусто. Commit:
  `feat: add channels table ranking weights sparklines and romi bars`

---

### Task 4: Карточка канала — метрики, график, воронка, кампании, цели и удержание

**Files:**
- Create: `client/entries/channel.jsx`,
  `client/components/charts/{RetentionGrid,Sparkline}.jsx` (Sparkline — если не создан в T3),
  `src/lib/heat-scale.js`
- Modify: `src/controllers/channels.controller.js` (detail), `src/views/pages/channel-detail.ejs` (каркас + mount),
  `src/controllers/api/metrics.controller.js`, `src/routes/api.routes.js`, `src/services/metrics/index.js`,
  `src/services/metrics/{screen-models,chart-series}.js` (секции passport/funnel), `public/css/app.css`
  (`.heat*`, `.matrix*`)
- Test: `tests/unit/{chart-series,screen-models,cell-format,heat-scale}.test.js`,
  `tests/integration/passport-screen.test.js`, `tests/integration/metrics-api.test.js` (маршрут 3),
  `tests/integration/channels.test.js` (M2-регрессия detail)

**Interfaces:**
- `buildPassportScreen({ passport, matrix, funnelSteps })` → `{ page: 'channel', channel, period, health,
  charts: { cac, romi }, retention, funnel, campaigns, targets }`. `health` — строка M3 без изменений;
  `retention` — матрица `getCohortMatrix({ channelId, horizon })`, отрисованная тем же `heatBucket`, что и T5;
  `targets: [{metric:'cac'|'romi', targetLabel, factLabel, tone}]` (tone — сравнение готовых значений).
- `buildFunnelSteps(funnel)` → `{ stages: [{key,label,value,sharePct: number|null, meterMax}], scaleMax }`.
  `sharePct = value / impressions * 100` (`null` при `impressions === 0`); `sharePct > 100` **не обрезается** —
  этапы из разных источников; `meterMax = Math.max(1, scaleMax)` — `<meter max="0">` запрещён, нулевая воронка
  получает max 1 и пустое состояние.
- `cellFormat(token, value)` — карта `cents|percent|romi|integer|months|ratio|date` → `src/lib/format.js`.
- Страница: `GET /app/channels/:id?days=`; `islandEntries: ['channel']`; M2-форма, её поля и
  `name="targetCacByn"` сохраняются в каркасе.

- [ ] **Шаг 1 — падающие тесты.** `chart-series.test.js`: порядок этапов фиксирован, `sharePct` при нулевых
  показах `null`, при `customers > leads` больше 100 и не клипается, `meterMax >= 1` даже для всех нулей.
  `screen-models.test.js` (passport): retention-строки совпадают с матрицей, неполные помечены, `campaigns` —
  периодные CAC, не lifetime; `JSON.stringify` без `bigint`. `cell-format.test.js`: каждый токен даёт тот же
  результат, что прямой вызов `format.js`; неизвестный токен → `TypeError`; второй карты токенов нет (импорт из
  `src/lib/cell-format.js`). `passport-screen.test.js`: 200 для viewer; цифры CAC/LTV/ROMI в `data-props`
  совпадают со строкой канала в `/api/v1/channels` за тот же период; retention-блок присутствует; воронка — 5
  этапов; `data-props` = ответ `/api/v1/channels/:id`; неизвестный id → 404 (`channels.test.js` зелёный, `45,00`
  и `name="targetCacByn"` на месте); канал без статистики → `no_data`, воронка нулей, `meterMax === 1`, без `NaN`.
  `metrics-api.test.js`: маршрут 3 (401/400/404/пусто). Бюджет passport ≤ 26.
- [ ] **Шаг 2 — падение.** `npx vitest run tests/unit/chart-series.test.js tests/unit/screen-models.test.js
  tests/unit/cell-format.test.js tests/unit/heat-scale.test.js tests/integration/passport-screen.test.js
  tests/integration/channels.test.js tests/integration/metrics-api.test.js` → FAIL.
- [ ] **Шаг 3 — реализация.** Detail-контроллер дополнительно вызывает `getChannelPassport` и
  `getCohortMatrix({channelId})` (один раз каждый); M2-часть (`getChannelDetail`,
  `listCampaignsForChannel`) не трогается. React: строка метрик (CAC, LTV12, ROMI, payback, LTV:CAC, расход,
  выручка) + `HealthBadge`; блок целей; два `ChartFrame` (CAC и ROMI); retention-grid; воронка — `<ol>` с
  `<meter min="0" max="1" value="…">` (доля как значение 0…1) и колонкой «доля от показов», сноска о разных
  источниках; кампании — таблица с CAC за период; пустые кампании/воронка — `EmptyState`.
- [ ] **Шаг 4 — проверка и коммит.** Тесты PASS. Браузер: из `/app/channels` клик по Instagram → CAC/LTV/ROMI
  совпадают с таблицей; retention и воронка видны; `?days=90` меняет цифры; M2-форма сохраняется; `resize 390 844`;
  `console` пусто. Commit: `feat: build channel passport with metrics funnel retention and targets`

---

### Task 5: Когорты — heatmap удержания и кривая накопленного LTV

**Files:**
- Create: `src/controllers/cohorts.controller.js`, `src/views/pages/cohorts.ejs` (каркас + mount),
  `client/entries/cohorts.jsx`, `client/components/charts/CohortCurve.jsx`
- Modify: `src/services/metrics/{screen-models,chart-series}.js` (секции cohorts/curve),
  `src/routes/{app,api}.routes.js`, `src/controllers/api/metrics.controller.js`,
  `src/services/metrics/index.js`, `public/css/app.css` (`.heat*`, `.matrix*`)
- Test: `tests/unit/{heat-scale,chart-series,screen-models}.test.js`,
  `tests/integration/cohorts-screen.test.js`, `tests/integration/metrics-api.test.js` (маршрут 5)

**Interfaces:**
- `buildCohortsScreen({ matrix, curve })` → `{ page: 'cohorts', horizonMonths, anchor, cohorts, excludedIncomplete,
  channelLtv, charts: { ltv }, table }`. Месяц когорты приходит из M3 как `YYYY-MM`; screen-model один раз
  превращает его в `cohortMonthDate: 'YYYY-MM-01'` для подписи/ссылок, а `cohortMonth` оставляет ключом. В UI нет
  `new Date('2026-11')`.
- `buildCumulativeLtvCurve({ cohorts, horizonMonths })` → `[{monthOffset, ltvCents: string|null, ltvLabel,
  cohortCount}]`: по каждому смещению — **взвешенное по `cohortSize`** среднее накопленного LTV только по
  `isComplete`. Завершённая когорта с `ltvCents === null` вносит `0` в числитель и свой `cohortSize` в
  знаменатель (наблюдаемой маржи нет — это измеренный ноль на уровне агрегации). `null` — только если
  завершённых когорт с данными на этом смещении нет. Подпись называет правило точно: «Средний накопленный LTV по
  завершённым когортам, N когорт».
- `heatBucket(retentionPct)` → `'heat-0'…'heat-4'` или `'is-empty'` для `null`; пороги — константы модуля
  (0–20/20–40/40–60/60–80/80–100), цвет — только в `app.css`.
- `buildCohortMatrix` M3 не меняется; `channelId` — из query, `horizon` — из `METRICS_CONFIG`. Topbar `days`
  на экране **не рендерится** (`period: null`): у когорт месячный горизонт. `horizon`-ссылки сохраняют
  `channelId` и `days`, если он пришёл в URL.

- [ ] **Шаг 1 — падающие тесты.** `heat-scale.test.js` (расширить после T4): границы 0/19.99/20/100 и `null`;
  бакетов ровно 5.
  `chart-series.test.js`: кривая исключает неполные когорты, взвешивает по размеру (когорты 100 и 400 дают 1:4),
  завершённая когорта с `null` вносит 0 и свой размер (проверка: 100/null + 400/100 → 80, а не 100),
  `null` при отсутствии завершённых, `cohortCount` совпадает с числом вошедших, копейки — строки.
  `screen-models.test.js` (cohorts): `cohortMonthDate` — `YYYY-MM-01`, исходный `cohortMonth` не потерян,
  `excludedIncomplete` совпадает с матрицей, `horizonMonths` управляет числом колонок. `cohorts-screen.test.js`:
  200 для viewer; в SSR один mount-узел без текста матрицы; `data-props` = ответ `/api/v1/cohorts`; в props
  неполная когорта `isPartial`, будущая ячейка `null` (не 0), «исключены» перечислены; `?horizon=3|6|12` меняет
  число колонок и props; topbar без `days`; пустая БД → `hasData: false`, без `NaN`. `metrics-api.test.js`:
  маршрут 5 (401/400 `horizon=7`/пусто). Бюджет cohorts ≤ 5.
- [ ] **Шаг 2 — падение.** `npx vitest run tests/unit/heat-scale.test.js tests/unit/chart-series.test.js
  tests/unit/screen-models.test.js tests/integration/cohorts-screen.test.js
  tests/integration/metrics-api.test.js` → FAIL.
- [ ] **Шаг 3 — реализация.** Убрать `cohorts` из `PLACEHOLDER_SECTIONS`, добавить маршрут
  `requirePermission('cohorts:view')`. Heatmap — React-таблица (данные из props): строки — когорты, колонки —
  месяцы 0…horizon−1, в ячейке `retentionPct` текстом + класс `heat-N`; неполные — `is-partial` (пунктирная
  граница) и легенда; пустые — «—» с `title`. Кривая — один `LineChart` с одной серией (cyan), `null`-точки
  разрывают линию. Переключатель горизонта — три GET-ссылки, активная с `aria-current`; `buildQueryString`
  сохраняет `channelId`/`days`.
- [ ] **Шаг 4 — проверка и коммит.** Тесты PASS. Браузер: `/app/cohorts` — heatmap читается, `is-partial`
  отличается, `?horizon=6` уменьшает матрицу и кривую, `console` пусто, `resize 390 844` — горизонтальный скролл
  матрицы. Commit: `feat: add cohort retention heatmap and cumulative ltv curve`

---

### Task 6: Атрибуция — три модели, grouped bars, ROMI модели, дельта и выбор модели

**Files:**
- Create: `src/controllers/attribution.controller.js`, `src/views/pages/attribution.ejs` (каркас + mount),
  `client/entries/attribution.jsx`, `client/components/charts/AttributionBars.jsx`
- Modify: `src/services/metrics/attribution.service.js` (ROMI модели),
  `src/services/metrics/screen-models.js` (секция attribution), `src/routes/{app,api}.routes.js`,
  `src/controllers/api/metrics.controller.js`, `src/services/metrics/index.js`, `public/css/app.css`
- Test: `tests/integration/attribution-screen.test.js`, `tests/integration/metrics-api.test.js` (маршрут 6),
  `tests/unit/screen-models.test.js` (attribution), `tests/unit/attribution.test.js` (ROMI модели)

**Interfaces:**
- `buildAttributionScreen({ report, model })` → `{ page: 'attribution', period, model, models: [{key,label,
  totalAttributedCents, totalAttributedLabel, totalSpendCents, romiPct, romiLabel, selected}], comparison,
  charts: { revenue }, table, unattributedNote }`. `selected` — выбранная модель; порядок моделей фиксирован
  `last_touch, first_touch, linear`.
- Сводка выбранной модели берётся из `report.models[model].totalAttributedCents` (и `romiPct` оттуда же), а не из
  суммы comparison-строк: это разные агрегаты, и сводка обязана совпадать с моделью.
- `AttributionBars`: 3 серии (`last_touch` — cyan, `first_touch`/`linear` — stone), ось — каналы.
- `model` — query `?model=`; выбор меняет **выделение и сводку ROMI**, но все три серии остаются видимыми:
  скрывать модели значило бы позволить экрану выглядеть как «одна модель». Ссылки моделей сохраняют `days`.
- Дельта-таблица: `lastTouchCents`, `firstTouchCents`, `linearCents`, `deltaLinearVsLastCents` +
  `deltaLinearVsLastPct` (`formatPercent`, `signed: true`), заголовок явно называет базу дельты.
- `unattributedNote`: строится из выбранной модели — `models[model].totalRevenueCents` минус
  `models[model].totalAttributedCents`; если разница не нулевая — «Не вся выручка атрибутирована: N BYN». Поле
  называет разницу, а не заставляет экран вычитать. `totalRevenueCents` уже есть в ответе M3 по каждой модели.

- [ ] **Шаг 1 — падающие тесты.** `attribution.test.js`: у каждой модели `totalSpendCents` равен сумме spend,
  `romiPct = computeRomi(totalAttributed, totalSpend)`, при нулевом расходе `null`, число запросов отчёта — 4.
  `screen-models.test.js`: выбор `linear` помечает только линейную модель, её `totalAttributedLabel` и ROMI
  попадают в сводку; порядок моделей стабилен; `deltaModel === 'linear'`; `unattributedNote` появляется только
  при расхождении. `attribution-screen.test.js`: 200 для viewer; в `data-props` 3 серии; `Σ` по каналам каждой
  модели равна `totalAttributedCents`; дельта-колонка = `linear − last_touch` по копейкам (арифметика сервиса);
  `?model=first_touch` меняет `selected` и сводку, но не цифры; `data-props` = ответ `/api/v1/attribution`;
  пустая БД → модели с `'0'`, `romiPct === null` при нулевом расходе, без `NaN`; `?model=bogus` → 400, страница
  без валидной модели — 400, не тихий дефолт. Бюджет attribution ≤ 4.
- [ ] **Шаг 2 — падение.** `npx vitest run tests/unit/attribution.test.js tests/unit/screen-models.test.js
  tests/integration/attribution-screen.test.js tests/integration/metrics-api.test.js` → FAIL.
- [ ] **Шаг 3 — реализация.** Убрать `attribution` из `PLACEHOLDER_SECTIONS`, маршрут с
  `requirePermission('attribution:view')`. React: селектор моделей — три GET-ссылки/<select> с кнопкой
  «Показать» (auto-submit отключён), сводка выбранной модели, `AttributionBars`, дельта-таблица с
  `u-numeric u-right`. Подпись под графиком: «Выручка по моделям атрибуции за период; окно касания — 30 дней».
  Блок «Не вся выручка атрибутирована» — по `unattributedNote`.
- [ ] **Шаг 4 — проверка и коммит.** Тесты PASS. Браузер: `/app/attribution` — 3 серии, `?model=linear`
  выделяет линейную и меняет сводку; дельта-таблица сходится; `resize 390 844`; `console` пусто. Commit:
  `feat: add three model attribution comparison screen`

---

### Task 7: Общие состояния, доступность, адаптив и бюджет бандла

**Files:**
- Modify: `public/css/app.css`, `client/components/charts/*`, `client/components/ui/*`,
  `src/views/pages/{dashboard,channels,channel-detail,cohorts,attribution}.ejs`, `README.md` (раздел сборки)
- Test: `tests/unit/client-guards.test.js`, `tests/unit/single-stylesheet.test.js` (расширить),
  `tests/integration/states.test.js`

**Interfaces:** новых контрактов нет. Правки только поведенческие и стилевые.

- [ ] **Шаг 1 — падающие тесты.** `client-guards.test.js`: в `client/**` нет `import '*.css'`, `styled.`,
  `style={{`, `dangerouslySetInnerHTML`, `innerHTML`, `fetch(`; нет `client/islands/registry.js` и ни один entry не
  импортирует больше одного острова; `Sparkline.jsx` использует `LineChart`, а не рукописный `<svg`; в
  `public/assets` после сборки нет `.css` (тест пропускается, если каталога нет). `single-stylesheet.test.js`:
  `public/css` по-прежнему содержит только `app.css`, `@import` нет. `states.test.js`: каждая страница M4 в SSR
  содержит ровно один `[data-island]`, `skeleton--chart`, `<noscript>`; `data-props` парсится и не содержит
  `bigint`; на пустой БД в props каждой страницы графики `hasData: false`, а дашборд — `verdict === 'no_data'`
  (текст пустого состояния не проверяется в SSR — его рисует React). Доступность figure (`aria-labelledby`, `role="img"`, таблица-дубль вне
  слота) проверяется в браузере на шаге 4; SSR её не содержит по определению.
- [ ] **Шаг 2 — падение.** `npx vitest run tests/unit/client-guards.test.js
  tests/unit/single-stylesheet.test.js tests/integration/states.test.js` → FAIL.
- [ ] **Шаг 3 — реализация.** Единые состояния: skeleton (до JS), empty (объяснение + действие), error
  (`ChartErrorBoundary` → «График не построился» + «Показать таблицу»; retry — перезагрузка, отдельного fetch нет),
  partial data (пометка «неполные данные» для неполных когорт и `no_data`-каналов). Клавиатура: `<summary>`
  таблиц фокусируемы, ссылки сортировки/горизонта/модели имеют `aria-sort`/`aria-current`, `focus-visible` ring —
  токен `--color-cyan-edge`. 390px: `grid--4` → 1 колонка, `table-wrap` со скроллом, подписи осей не наезжают
  (уменьшить число меток, а не шрифт). Перепроверить бюджеты: каждый вход ≤ 210 KB gzip, каждая страница
  (entry + shared) ≤ 250 KB gzip; при перерасходе удалить неиспользуемые импорты Recharts, а не дробить экраны.
- [ ] **Шаг 4 — проверка и коммит.** Тесты PASS. Браузер по всем пяти экранам: `Tab` проходит по ссылкам и
  `<summary>`, фокус виден; `agent-browser snapshot` подтверждает `role="img"` у графика и доступное имя у
  `<figure>`; `resize 390 844` — без горизонтального скролла страницы (только таблицы); `console` пусто на
  каждом; `agent-browser screenshot` каждого экрана на 1280 и 390; замер gzip записан в отчёт. Commit:
  `a11y: unify loading empty error states and responsive charts`

---

### Task 8: E2E, строгий манифест, скриншоты, README и полный прогон

**Files:**
- Create: `docs/screenshots/m4/{dashboard,channels,channel,cohorts,attribution}.png`,
  `docs/screenshots/m4/{mobile-dashboard,mobile-channels,mobile-cohorts}.png`, `docs/screenshots/m4/README.md`,
  `tests/integration/assets-strict.test.js`
- Modify: `README.md` (раздел «Что уже работает» → M1–M4, «Скрипты» → `build`, `build:watch`, `dev`, «Структура» →
  `client/`, `public/assets`, «Быстрый старт» → `npm run build` перед `npm start`, Node ≥22.12), `IMPROVEMENTS.md`

- [ ] **Шаг 1 — E2E-сценарий.** Поднять чистую БД (`npm run db:setup && npm run migrate && npm run seed`),
  `npm run build`, `npm start`. Пройти:
  1. `/login` → viewer → `/app/dashboard`: KPI-блок, вердикт и пять графиков (CAC, ROMI, расход/выручка,
     расход по каналам, scatter CAC×LTV), таблицы-дубли, `console` пуст;
  2. выбрать два канала в фильтре → цифры и подписи сузились; `?days=90` → цифры изменились;
  3. `/app/channels` → сортировка по CAC сохраняет фильтры, веса (analyst) переставляют рейтинг, viewer тоже
     может смотреть свой рейтинг; `?status=bogus` показывает все;
  4. клик по каналу → паспорт, удержание, воронка, кампании, цели; M2-форма работает; ссылка «К списку каналов»;
  5. `/app/cohorts` → `?horizon=6`, неполные ячейки отличимы; topbar без `days`;
  6. `/app/attribution` → `?model=linear`, сводка ROMI и дельта-таблица; пометка о неатрибутированной выручке;
  7. `resize 390 844` → все пять экранов без поломок;
  8. `/api/v1/dashboard` в браузере → JSON, `Cache-Control: no-store`, нет `bigint`, есть `channelIds`.
  Скриншоты — `agent-browser screenshot docs/screenshots/m4/<name>.png`; README папки: что на каждом снимке,
  дата, сид, разрешение.
- [ ] **Шаг 2 — строгий манифест отдельным тестом.** `assets-strict.test.js` **явно** создаёт приложение с
  `NODE_ENV=production` и несуществующим `manifestPath` → `AssetManifestError`/отказ старта; `env` читается при
  импорте, поэтому тест запускает дочерний процесс с `NODE_ENV=production`, а не подменяет поле после импорта.
  Тот же тест проверяет, что в production манифест не перечитывается. Это не покрывается обычным `npm test`:
  в test-режиме манифест необязателен, поэтому утверждать «дефолтный прогон проверяет strict» нельзя.
- [ ] **Шаг 3 — полный набор и документация.** `npm test` (без `public/assets` — dev-фолбэк) и `npm test` после
  `npm run build` — оба зелёные; `npx vitest run --reporter=verbose` без пропущенных тестов; миграций M4 нет,
  `npm run migrate` идемпотентен. README: M4 в «Что уже работает», обязательный `build` перед `start`,
  `build:watch` для правки островов без dev-сервера, `npm run dev` собирает один раз, `public/assets` — артефакт
  сборки и в git не попадает, `package-lock.json` коммитится, Node ≥22.12; Docker-этап явно отложен на M6.
  `IMPROVEMENTS.md`: campaign-фильтр, stacked area по кампаниям, фильтр каналов на когортах, отсутствие общего
  снапшота health, дублирование dimension в health, ранжирование по display-округлению, `null`/`undefined`
  унификация — те пункты M3, которые M4 не закрывает, остаются с пометкой «M4 не меняет».
- [ ] **Шаг 4 — коммит.** `docs: add m4 screenshots readme and build instructions`

## Тестирование: что и где

| Уровень | Инструмент | Что покрывает |
|---|---|---|
| Чистые преобразования | Vitest | `sortChannelRows`, `heatBucket`, `buildFunnelSteps`, `buildCumulativeLtvCurve`, `toStackSegments`, `toCacPoints/…`, `cellFormat`, `formatCompactCents`, `serializeDataProps`/`dataProps`, `createAssetManifest`, `parseQuery`, `parseChannelIds`, `parseWeightParams`, `attributedCents`, ROMI модели |
| API и экраны | Vitest + Supertest | 6 маршрутов (401/400/404/пусто), `?status=bogus` (API 400 / страница 200), RBAC-таблица, SSR-каркас с одним mount-узлом, `data-props` ↔ API (deep equal) на каждой странице, `assertJsonSafe`, отсутствие `bigint`, CSP/кэш-заголовки, бюджет запросов |
| Сборка | Vitest + `npm run build` | манифест (mtime, unknown entry, strict production), отсутствие вложенного `public/assets/assets` и `.css`, `assets()` после перезаписи манифеста |
| E2E | agent-browser | клики, фильтр каналов, сортировка, веса, модель, горизонт, 390px, консоль, `role="img"`/`aria-labelledby`, скриншоты |

**`@testing-library/react` + jsdom не добавляем.** Причины: (1) `ResponsiveContainer` в jsdom измеряет 0×0, поэтому
тест увидит контейнер без графика и создаст ложное чувство покрытия; (2) вся арифметика графиков уже вынесена в
чистые модули и проверяется напрямую; (3) острова M4 не имеют состояния и не обрабатывают события — симулировать
нечего; (4) это две новые dev-зависимости и второй тестовый рантайм ради проверки, которую даёт реальный браузер.
Пересмотреть в M5, когда остров получит слайдеры сценариев.

## Review Focus

1. **Устаревший бандл и вложенный `public/assets`.** Манифест кэшируется в production, перечитывается по `mtime`
   в dev/test, HTML — без кэша, `/assets` — immutable. Где проверяется: `assets.test.js` (unknown entry,
   отсутствие манифеста, перезапись и `utimes`), `assets-runtime.test.js` (`src` из манифеста, `/assets` immutable),
   `build-output.test.js` (нет `public/assets/assets`, нет `.css`), `assets-strict.test.js` (production + нет
   манифеста → отказ), E2E (хеш в HTML совпадает с файлом). `build:watch` и `npm run dev` описаны в README.
2. **XSS через `data-props` и границы острова.** Строка канала/кампании может содержать `</script>`, `"` или `&`.
   Где проверяется: `serialize-props.test.js` (payload-набор, round-trip, `\u003c`, имя острова в ошибке),
   `dashboard-screen.test.js` / `passport-screen.test.js` / `channels-screen.test.js` (в HTML нет закрывающего
   тега внутри атрибута), `client-guards.test.js` (нет `innerHTML`/`dangerouslySetInnerHTML`, нет registry), CSP —
   в `assets-runtime.test.js`. Один mount-узел на страницу: дубль ломает `mountIsland` явной ошибкой.
3. **Сериализация BigInt и расхождение страницы с API.** Любое новое поле копеек легко протащить как `bigint` из
   репозитория; экранная модель собирается один раз и отдаётся и в `data-props`, и в JSON. Где проверяется:
   `assertJsonSafe` в каждом API-тесте и в тестах экранных моделей; `serializeDataProps`/`dataProps` бросают
   `TypeError` с именем острова; `JSON.stringify(screenModel)` в `dashboard.test.js`/`channel-list.test.js`;
   deep-equal `data-props` ↔ API на каждой из пяти страниц. Money-поля — только `*Cents: string`.
4. **График врёт из-за разных периодов или фильтра.** KPI — 30 дней, линия — 12 недель, бар — те же 12 недель с
   **атрибутированной** выручкой, паспорт — свой период, когорты — месяцы. Фильтр каналов применяется ко всем
   частям дашборда одновременно. Где проверяется: `dashboard.test.js` (12 полных недель, последняя ≤ `period.to`,
   подписи «30 дней» и «12 недель» различаются, бар использует `attributedCents`, отфильтрованный blended
   пересчитан), `chart-series.test.js` (кривая — только завершённые когорты, взвешивание, null-правило),
   `channels-screen.test.js` («Атрибуция: последнее касание»), `attribution-screen.test.js` (сводка ROMI — из
   `report.models[model]`, три серии видны). Запрет второй оси Y (> 4 серий) — на ревью и в `client-guards.test.js`.
5. **Пустота неотличима от нуля.** Ноль — измерение, `null` — отсутствие данных. Где проверяется:
   `series.test.js` (`null` не становится `0`, `hasPlottableData`), `chart-series.test.js` (`ltvCents: null`,
   завершённая когорта с null вносит 0 и свой размер), `states.test.js` (в props `hasData: false`, без SSR-текста),
   `rbac.test.js` (пустой дашборд: spend/newCustomers — нули, CAC/ROMI — «—»), API-тесты (пустая БД → `null`/`[]`),
   `cohorts-screen.test.js` (будущая ячейка — `null`/«—», не `0%`), `passport-screen.test.js` (`meterMax >= 1`,
   нулевая воронка не даёт `<meter max="0">`).

## Definition of Done M4

- [ ] Vite собирает пять входов в `public/assets` с манифестом, `publicDir: false` (нет вложенного `assets/`),
  Express подставляет хешированные скрипты, в production падает без манифеста, в dev перечитывает по `mtime`,
  `/assets` кэшируется immutable, HTML — нет; CSS-файлов в сборке нет; `package-lock.json` и
  `engines.node >=22.12` зафиксированы.
- [ ] Каждая страница — EJS-каркас + ровно один mount-узел; `data-props` экранирован, JSON-safe, без `bigint`,
  глубоко равен ответу API; CSP `script-src 'self'`, inline-скриптов нет; все KPI/графики/таблицы — в React,
  у графиков `ChartErrorBoundary`.
- [ ] Шесть `GET /api/v1/*` маршрутов с `requireAuth` + правом, Zod-валидацией (русские сообщения, `days`+`from`
  → 400), anchor из `getDataAnchor`, `resolvePeriod` в контроллере, тем же экранным view-model, что и страница;
  на каждый — тесты 401/400/пусто.
- [ ] Дашборд (KPI, вердикт, CAC/ROMI, расход/выручка, расход по каналам, scatter, фильтр каналов), каналы
  (все строки, сортировка с BigInt, веса для любой роли, исключённые, ROMI-bar, спарклайн Recharts), паспорт
  (метрики, серия, удержание, воронка с `meterMax >= 1`, кампании, цели), когорты (heatmap + кривая, null-правило,
  неполные отличимы), атрибуция (3 модели, ROMI модели, grouped bars, дельта, выбор модели, пометка о
  неатрибутированной выручке) работают на сиде и на пустой БД.
- [ ] Все графики: заголовок-вывод, период, единица, пустое состояние, `aria-labelledby` у `<figure>`,
  `role="img"` у слота, таблица-дубль вне картинки; ≤ 4 серий; без второй оси Y (scatter — законное исключение
  X/Y); cyan — акцент, не заливка; статусы — точка + текст.
- [ ] Состояния loading/empty/error/partial есть на каждом экране; 390px не ломается; консоль чистая; клавиатура
  и `focus-visible` проверены; бюджеты 210 KB на вход и 250 KB на страницу измерены.
- [ ] `npm test` зелёный и без сборки, и после неё; strict-манифест проверен отдельным `assets-strict.test.js`;
  бюджеты запросов (15/14/12/26/5/4) не превышены; скриншоты в `docs/screenshots/m4/`; README и
  `IMPROVEMENTS.md` обновлены; отложенные пункты зафиксированы.
