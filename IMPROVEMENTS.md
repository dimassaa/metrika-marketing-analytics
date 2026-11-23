# Improvements backlog

Non-critical findings recorded during implementation. Priority is decided by the project owner.

## Tooling

- **Vitest stays at `^3` as the plan requires, but 3.2.7 reports 1 moderate and 2 critical advisories**
  (`tinypool` prototype-pollution gadget, `@vitest/mocker` path traversal). The fix is Vitest 5, a breaking
  change. Both are dev-only and only process trusted local code, so the practical risk is low; revisit with the
  plan update rather than upgrading silently.
- **`fileParallelism: false` in `vitest.config.js` is a stopgap** until integration tests get per-schema isolation
  (Task 2 and later). It prevents schema resets from racing but makes the suite slower than it has to be.
- **`express-ejs-layouts@^4` from the plan does not exist on npm** (latest is 2.5.1), so 2.5.1 is installed.
  The plan text needs correcting before Tasks 4–5 use layouts, otherwise the next implementer hits the same wall.

## Database and migrations

- **A failed `ROLLBACK` masks the original error** in the migration runner (`db/migrate.js`). When the rollback
  itself throws, the caller sees the rollback failure instead of the statement that actually broke the transaction.
  `withTransaction` now attaches the rollback error as `cause` and rethrows the original; apply the same pattern to
  the migration runner.
- **The reset guard's `name !== 'metrika_test'` clause is redundant**: the following `endsWith('_test')` already
  covers it. Two spellings of one rule invite drift; keep the suffix check only.
- **`databaseName()` parses the DSN as a URL only.** Socket paths, query parameters and percent-encoded names are not
  normalized, so two spellings of the same database can compare unequal in the guard. Decide whether the helper
  supports only URL DSNs and state it, or reuse one parser everywhere.
- **`client.connect()` in `runMigrations` sits outside the `try/finally`**, so a connection failure skips `client.end`.
  Move the connect inside the guarded block or wrap it explicitly.
- **The advisory lock is acquired with a blocking call and no timeout.** A stuck migration blocks every later deploy
  at boot without a diagnostic. Set `lock_timeout` (and a `statement_timeout`) and fail with a message naming the lock.
- **The unlock comment justifies the call by a hypothetical pooled caller** («if this ever moves off a dedicated
  connection»). It is a session-level lock; describe the real invariant or delete the speculation, because a future
  reader may preserve an unnecessary call for a wrong reason.
- **Applied migrations are not checksummed.** Ruling for now: never edit `001`; every schema change ships as `002`
  and later, so an applied file is immutable. If edits still need detection, add a checksum column to
  `schema_migrations` and fail the run on a mismatch.
- **`DROP SCHEMA public CASCADE` / `CREATE SCHEMA public` is not transactional and assumes the connecting role owns
  the schema.** Under a two-role setup (migration owner vs application role) `resetTestDatabase` fails. Document the
  required ownership or split the privileges explicitly.
- **`DATABASE_URL` is required even when only `TEST_DATABASE_URL` is set.** A CI job that runs tests against a
  service container cannot parse the environment without inventing a development URL. Make the pair conditional on
  `NODE_ENV`, or accept a test-only configuration.
- **The advisory-lock and rollback failure paths are untested** (lock contention, a rollback that throws after a
  migration failure). The happy path is covered; these paths guard data integrity, so add tests before the runner
  changes again.
- **The 23503 comment describes only one side of the FK error**, which can be raised by either the child insert or
  the parent delete. Make the comment match the actual assertion so the next reader does not narrow the handler.

## Design system

- **The headline highlight span is 2.28:1 (`#3398e1` on `#c1e1f7`), below WCAG AA for normal text.** This is the
  accepted brand ruling: the element is fixed by the supplied style reference and AGENTS §6, and changing the hue
  would break the design contract. Recorded for the defence, not a bug to fix; revisit only if the owner changes the
  brand.
- **`--shadow-subtle` is unused and `--shadow-preview` only serves the landing preview.** Shipped shadows should be
  the ones components actually use; either apply them in M2 or remove them so the token list stays honest.
- **Public components use unprefixed global class names** (`.card`, `.btn`, `.field`, `.table`, `.badge`), while the
  app shell namespaces its own as `app-*`. Nothing collides today, but a public variant of `.card` will change app
  screens too. Scope public classes under a wrapper or namespace them before the M4 React islands add more classnames.
- **`.card` on the landing carries a card shadow**, while AGENTS §6 allows shadows only for floating/preview cards.
  Either drop the shadow from the base card and keep it on `.preview`, or document why the landing base card is an
  exception.
- **`format('woff2-variations')` is Fontsource-standard but not a standard CSS value.** It works in current
  browsers; keep it only as long as the Fontsource build emits it, otherwise switch to `format('woff2')`.
- **`.u-numeric` also applies right alignment inside `.table`.** The utility is described as numeric formatting but
  changes layout; split the alignment into its own class so a future table cell can use tabular numbers without
  being pushed right.
- **Status words (`healthy`/`watch`/`risk`) are not enforced by CSS.** A class rename would silently render a neutral
  colour; add a rule or a test that ties the three tokens to the class names.
- **The OG SVG's text uses the app font stack but falls back outside it in social cards** because an SVG opened by a
  crawler cannot load the local WOFF2. The PNG rendered in M6 should rasterize the text with the real font.

## Public landing

- **The mobile header hides the anchor navigation** (`.site-nav { display: none }`) and leaves only the brand and
  «Войти». Add a compact disclosure or a shortened menu with «Возможности / Как считаем / Безопасность» so the
  landing does not lose its in-page navigation at 390 px.
- **The Open Graph image is SVG** (`public/img/og-cover.svg`). Several social crawlers reject SVG for `og:image`.
  Render a 1200×630 PNG for the meta tag in M6 and keep the SVG as the editable source.
- **The landing tests cover the hero and meta tags but not the FAQ or the formula section.** A broken `<details>`
  block or a wrong formula would pass; add one assertion per section when the copy is next edited.
- **The logo is declared as 32×32 while its CSS box is 28 px.** The mismatch causes a tiny layout shift on first
  paint; make the intrinsic attributes match the rendered size.
- **Copy nit** («Никаких «примерно» и ручных сведений в таблице»): «сведений» reads as officialese and «в таблице»
  is redundant. Reword to «Никаких «примерно» и ручных правок» when the section is next touched.

## Runtime

- `/health` reports only `status`, `db` and `version`. If deployment ever needs partial degradation (DB up but a
  dependency down), the response shape has to grow; nothing today requires it.
- **`express.static` uses the default caching policy.** CSS, fonts and SVG have no explicit long-lived caching, while
  authenticated pages already send `no-store`. Decide the policy together with the M4 Vite asset fingerprinting:
  immutable `Cache-Control` for hashed assets, revalidation for `app.css`, and keep private responses unfetchable
  from shared caches.

## Seed and demo data

- **The touchpoint mix is 78.2 %, not the brief's 70 %.** The 70 % rule is applied to extra touches while the first
  touch is forced to the acquisition channel, which lifts the overall share. Either retune the generator or record
  the interpretation explicitly in the seed spec; a reviewer comparing the two numbers will otherwise read it as a bug.
- **Fixed seed metadata is untested.** Channel names and kinds, campaign counts, goal metrics and the demo password
  hash are not asserted, so a typo in `db/seed/data.js` would still pass the suite. Add a small metadata test.
- **Several seed comments overclaim behaviour**: "byte-for-byte", "documented in README", "spend from the start" and
  the "30-day window" wording do not match what the generator or the docs actually do. Fix the comments with the next
  seed change; a misleading comment is worse than none.
- **`seed()` is ~320 lines and mixes generation with inserts.** The pure generators can be split out and tested
  without a database; the current shape makes every tweak a review of I/O and arithmetic at once.
- **Date/number helpers are duplicated** (`pad2`, month math, `formatByn`) between the seed and `src/lib`. Reuse the
  shared helpers so a formatting change cannot apply to only one side.
- **The goals count is hardcoded** in the seed and the test. Derive it from the goals array, otherwise adding a goal
  silently fails the count assertion for the wrong reason.
- **`countRows()` interpolates table names** into SQL. Callers pass constants today, but the helper should take a
  fixed whitelist key instead of a free string so the pattern cannot be copied into user-influenced code.
- **The goal window is only regex-checked** (`^\d{4}-\d{2}-01$`). Assert the exact 12-month span relative to the
  anchor; a window that shrinks to one month would currently pass.
- **`seed()` without `anchorDate` resolves "yesterday" per call.** Two runs that straddle Minsk midnight produce
  different datasets even with the same PRNG seed. Tests are effectively immune, but a cron or a demo reset should
  pass `anchorDate` explicitly so the anchor and the generated window cannot disagree.
- **`src/lib/dates.js` has no unit tests.** The seed test covers `minskYesterday` and day bounds indirectly. Add a
  focused test for month ends, an ISO week across a year boundary, `formatDateRu`, and the Minsk offset around DST
  (Belarus has no DST now, but the helper must not silently rely on that).

## App shell

- **Sidebar links test `:view` permissions while the placeholder routes behind them are `requireAuth`-only.** The
  divergence is unreachable today because every role has all `:view` permissions, but a future role without
  `channels:view` would see no link and still be able to open `/app/channels`. Either the routes take the matching
  `requirePermission('…:view')` or the navigation trusts the route guard; decide before a fourth role appears.
- **`admin.controller.js` imports `buildShellLocals`/`roleLabel` from `app.controller.js`.** It avoids duplicating
  Russian role names and shell locals, but creates a controller→controller dependency. A small `src/lib/ui.js`
  (labels, initials, shell locals) would remove it; the file did not exist in the Task 7 ownership list.
- **`.app-body`, `.app-section` and `.app-topbar__period` have no CSS rules.** They are hooks kept for later markup
  or leftovers from the first draft; delete them or give them a rule in M2, so the class list stays honest.
- **Sidebar groups are flat `<p>` titles in one `nav` landmark, and the admin table has no `<caption>`.** Grouping
  each section in a nested landmark (`aria-labelledby` per group) and captioning the roster table would improve
  screen-reader navigation; the current markup passes the M1 accessibility bar but is not ideal.
- **Two new gaps break the 4 px grid:** `.app-nav__list { gap: 2px }` and `.app-topbar__heading { gap: 2px }`.
  They were chosen to tighten adjacent lines; replace with 4 px or a documented line-height adjustment.
- **The admin table header says «Email».** All UI copy is Russian, so the column should read «Почта»; the value
  itself stays an e-mail address.
- **Dashboard «Что дальше» describes the import in the present tense** («Импорт расходов… проверим строки») although
  `/app/import` is still a placeholder. Reword as a future step until the import milestone ships.
- **The dashboard empty state needs two distinct states in M2/M3.** «Данных пока нет» is correct for an empty stand,
  but a seeded stand with no metrics engine should say «метрики ещё не рассчитаны». The current copy blurs both;
  split it when `isEmpty` becomes a real data check.
- **Ten `/app` routes are placeholders until M2–M5** (`channels`, `campaigns`, `cohorts`, `attribution`, `scenarios`,
  `alerts`, `goals`, `import`, `audit`, `profile`). The honest «Раздел появится на следующем этапе» page is correct
  for M1, but the sidebar presents every visible item as available. In M2, mark not-yet-built items (or add a «скоро»
  label), so a demo visitor does not click through a wall of identical stubs.
- **The roster table relies on horizontal scroll inside `.table-wrap` at mobile width.** There is no column priority
  or card fallback; for three rows in M1 it is acceptable, but the pattern will not scale to a real user list.
- **The demo admin's full name is literally «Администратор»**, so the sidebar footer reads «Администратор /
  Администратор» and the roster repeats the role as a name. This is seed data, not an auth bug: give the demo person
  a name (the role already comes from `roleLabel`).
- **The sidebar scrolls on short viewports** (e.g. 1280×577) while identity and logout stay pinned; a nav group can
  disappear below the fold. At the normal 900 px height everything fits, so this is a demo-hardware concern rather
  than a layout bug; add a compact mode if small laptops are part of the defence setup.
- **`roleLabel` returns the raw role code for an unknown role** instead of throwing. The DB CHECK makes that
  unreachable today, but a corrupted session would render an English code in the Russian UI. Decide fail-soft vs
  fail-fast when a fourth role appears, rather than inheriting the current fallback by accident.

## Errors and access

- **404 and 500 render inside the public layout, and so does the 403 from `requirePermission`; other 4xx AppErrors —
  including the CSRF 403 from the central handler — are still `text/plain`.** A signed-in visitor therefore sees the
  landing header with «Войти» on the styled error pages, while a CSRF failure loses the design entirely. Render every
  page 4xx through `errors/403`/`errors/404` once the public partials get an authenticated variant, so the response
  shape does not depend on which middleware rejected the request.
- **404 copy assumes a signed-in visitor** («Вернитесь в дашборд…»). Anonymous visitors get the same sentence and
  only later see «На главную»/«Войти»; branch the copy with the same `currentUser` check that picks the links.

## Auth and sessions

- **A failed audit insert turns a successful login or logout into a 500 after the state change.** The session is
  already rotated/destroyed, but the user sees an error. Treat audit as best-effort: log the failure and keep the
  auth result, or include the audit row in the same transaction where the storage allows it.
- **The login limiter lives in process memory.** A multi-instance deployment would give each instance its own quota;
  move the store to PostgreSQL/Redis before scaling out. The `ip + email` key also lets one address spray many
  accounts, so M6 needs a second per-IP bucket.
- **`trust proxy: 1` is unconditional.** Behind a reverse proxy it is right, but a directly reachable instance lets a
  client spoof `X-Forwarded-For` and poison the limiter key and the audit IP. Make the hop count an environment
  variable (`TRUST_PROXY`) and document the expected topology.
- **A repeated `next` field in the login body produces 400** instead of a safe redirect: the array fails `z.string()`
  even when the credentials are correct. Normalize arrays to the dashboard fallback before Zod parses the form.
- **A live session outlives deactivation and role changes.** `requireAuth` trusts `req.session.user`, so a user
  deactivated by an admin keeps access until the 8 h session expires. M1 has no mutation endpoint, so the gap is
  unreachable now. M2 must delete the user's `sessions` rows on deactivation or role change and prove the old cookie
  stops working; the ruling is already recorded in the M1 ledger.
- **A `GET /login` creates a session row** just to carry the CSRF token. `connect-pg-simple` prunes expired rows, but
  anonymous traffic still writes to `sessions`; watch the table under load or issue a stateless signed token.
- **Failed login attempts are not written to `audit_log`.** Only `auth.login` success and `auth.logout` are recorded,
  as the M1 brief requires. If the audit screen must show brute-force attempts, add `auth.login_failed` with IP and a
  normalized e-mail (never the password) and a retention rule.
- **`DEMO_PASSWORD` is duplicated** between `db/seed/data.js` and `tests/helpers/app.js`. Import the seed constant in
  the test helper (or vice versa) so a rotated demo password cannot leave half the suite failing for the wrong reason.

## Code quality

- **The same API-vs-page check exists in three places** (`auth` and `errors` middlewares plus inline in `app.js`).
  The copies can drift as `/api` grows. Move the predicate to a small `src/lib/http.js` with a unit test the next time
  one of those files changes.

## Data formatting

- **Last login is displayed as a date only** (`20.11.2026`). There is no Minsk datetime formatter yet, so the time of
  day is dropped; add one to `src/lib/format.js` when that module lands and show date + time for the roster.
- **`formatAnchorRu` is a thin alias of `formatDateRu`.** It currently only names the intent; keep it if the anchor
  later needs its own format, otherwise inline `formatDateRu` and remove the wrapper.
- **BIGINT arrives as a string from `pg`.** User ids are deliberately kept as strings today, which is safe. Money
  (`*_cents`) and aggregate sums will need an explicit per-field policy before M3: map identifiers as strings, map
  cents only after proving the value is within `Number.MAX_SAFE_INTEGER`, and never apply `Number()` blindly or let
  raw strings reach templates.

## Tests

- **The 500 page has no automated regression test.** It was verified through a throwaway harness against the real
  `errorHandler`. A test needs an injectable failing route (or a deliberately broken pool and an authenticated
  session); add it with the first error-handling change.
- **The rbac empty-state test is order-dependent.** It truncates `daily_stats, touchpoints, orders, customers` and
  never reseeds, so any later test in the same file that needs statistics would fail. Move it to its own file with a
  `beforeAll` seed or reseed in a `finally`; Vitest's `fileParallelism: false` only hides the problem across files.
- **The JSON-vs-text error contract, the CSP nonce and `withTransaction` rollback were verified by hand**, not by
  automated tests. Add coverage when the error middleware or the transaction helper is next changed.

## M2 channels (task 1 follow-ups)

- **`.pager` is defined in `public/css/app.css` but no screen uses it yet.** It was added because the M2 plan
  requires one shared set of list classes; delete it or wire it when pagination lands, so it does not become a
  class that only exists in the stylesheet.
- **The channel edit form prefills ROMI as `115,00`**, straight from the `NUMERIC` string, instead of the shorter
  `115` the seed form shows. Submitting works, so this is cosmetic; normalise the prefill when the edit form gets
  its next pass.
- **`tests/integration/channels.test.js` is order-dependent by design.** The `viber_ads` channel is created in the
  create case and reused by the update and archive cases, so running a single case in isolation fails. If the file
  grows, create the fixture in `beforeEach` (or a helper) and keep the archive toggle test separate.

## M2 campaigns (task 2 follow-ups)

- **The campaign list is capped at 200 rows, and the budget/spend totals are summed from that capped set.** No real
  pagination exists yet; the page says «Показаны первые 200 кампаний» only when the cap is actually exceeded. Decide
  whether totals should come from a separate aggregate query once the demo can exceed the cap.
- **The channel passport campaign table uses the same 200-row cap without telling the reader.** The seeded maximum is
  four campaigns per channel, so it is unreachable today, but the table and the list would disagree if it ever grew.
- **There is no confirmation message after create, edit or delete.** Every mutation redirects to a list, so the person
  has to find the row to know it worked. Add a flash-style notice (query-free, session-backed) in the next list pass.
- **The edit card is driven by `?edit=<id>` and silently disappears for a stale or non-numeric id.** That is better
  than a 404 for a page that still shows the list, but a short «кампания не найдена» notice would explain the missing
  form.
- **`campaignUpdateSchema` maps an absent `budgetByn` to NULL.** The current edit form always submits the field, so it
  cannot happen through the UI; a future partial form would silently clear the budget.
- **Every campaign mutation commits, then writes its audit row.** A failed `audit_log` insert therefore leaves the
  change applied and answers 500; the row and its trail disagree. The same pattern exists in the task-1 channel
  mutations and the task-4 goal mutations. Wrap the state change and `auditService.record` in one
  `withTransaction`, or make audit explicitly best-effort (log the failure, keep the mutation result) so the chosen
  contract is visible in code.
- **BIGINT id parsing is duplicated between `channels.controller.js` and `campaigns.controller.js` (plus the filter
  transform in the campaign validator).** A shared `src/lib/ids.js` would remove three copies of the same range rule.

## M2 goals (task 4 follow-ups)

- **`goals.target_value` remains `NUMERIC(14,2)` with five different units.** This is the documented exception from
  the task brief: BYN for `cac`, percent for `romi`, a ratio for `ltv_cac`, months for `payback` and an integer for
  `new_customers`. A `target_value_cents` column would cover only one metric out of five and force a second field
  for the rest, so no migration was made. The compensation is enforced in code: CAC input goes through
  `parseBynToCents` and back to a decimal string, and every metric is stored as a two-decimal string. M3 must parse
  `cac` through `parseBynToCents` as well, never through `Number()`, when it compares plan with fact.
- **The database cannot enforce the general overlap rule.** `goals_unique_idx` only rejects an identical
  `(metric, channel, period_start, period_end)`; two different overlapping intervals are caught by the service's
  transaction plus `pg_advisory_xact_lock(hashtext(...))`. A direct SQL insert, another service, or a future import
  bypassing `goals.service.js` can still create an overlap. A `btree_gist` exclusion constraint on
  `(metric, COALESCE(channel_id, 0), daterange(period_start, period_end, '[]'))` would move the rule into the
  database, but requires a new migration and the `btree_gist` extension, which was outside this task's file list.
- **The overlap lookup cannot use `goals_unique_idx`.** `channel_id IS NOT DISTINCT FROM $2` plus the interval
  comparison makes the index unusable, so PostgreSQL scans the goals table on every create/edit. At demo volume
  (single-digit rows) this is irrelevant; an exclusion constraint with `btree_gist` would both enforce the rule and
  index it. Recorded so the cost is not mistaken for an oversight when the table grows.
- **The task brief names `002_m2_data.sql` as the source of the goal index.** That migration does not exist in the
  repository; the whole `goals` table, including `goals_unique_idx`, already ships in `001_init.sql`. The brief should
  be corrected before the next task repeats the reference.
- **The goal list has no row cap or pagination.** The demo has four seeded goals plus a handful of test rows, so the
  screen remains readable; add the same explicit cap/pager as campaigns if goals become numerous.
- **A stale `?edit=<id>` on `/app/goals` silently hides the edit card.** The behaviour matches the campaign list and
  avoids a 404 for a page that still exists, but a short «цель не найдена» notice would explain the missing form.
- **Goal create/edit/delete redirect without a success notice.** The same flash-style mechanism requested for
  campaigns and the profile would confirm the change; today the person has to find the row again.
- **The update path re-reads the goal to learn its metric before parsing the target.** That costs one extra `SELECT`;
  acceptable for a form, and it keeps unit rules in one validator instead of trusting a hidden form field for the
  metric.

## M2 users, profile and audit (task 3 follow-ups)

- **`requireAuth` does not re-validate `users.is_active`/`role` on every request; session revocation is the mechanism.**
  Deactivation, role change and password reset delete the user's rows from `sessions`, which is why the old cookie
  stops working immediately. A database-side role change made outside these endpoints (or an interrupted revocation)
  would still be honoured until the session TTL; if that matters, add one indexed `SELECT is_active, role FROM users`
  to `requireAuth`, at the cost of a query on every render.
- **The audit timestamp formatter lives in `src/services/audit.service.js`.** `src/lib/dates.js` owns Minsk calendar
  formatting but has no date-time function; the journal needed `DD.MM.YYYY HH:mm`, so a local `Intl` formatter was
  added rather than widening this task's file ownership. Move it to `dates.js` with `formatDateTimeRu` when that module
  is next touched.
- **The audit journal's actor filter scans `sess->'user'->>'id'` only for revocation, but the journal itself queries
  `audit_log.user_id`, which is unindexed.** Fine for the demo's row count; add an index on `audit_log(user_id,
  created_at DESC)` if the journal becomes a daily tool.
- **The profile password change redirects without a success notice.** The person sees the same page and has to infer
  that the hash changed. A session-backed flash (without persisting the password) would confirm it; the M2 campaigns
  section already asks for the same mechanism.
- **A password reset uses a one-GET session flash.** The POST redirects to `/app/admin/users`, the next GET shows the
  temporary password and deletes `req.session.flash`; a second GET does not. The plaintext therefore sits in the
  `sessions` row for the fraction of a second between the redirect and the confirmation render. That is the accepted
  trade-off for POST/Redirect/GET without putting the secret in the URL; do not extend the flash TTL or persist it.
- **`toggleUserActive` reads the row in the controller and again in the transaction.** A concurrent change between the
  two reads makes the toggle act on a stale desired state; the transaction still refuses the last-admin and self cases.
  Deriving the desired state inside the service would remove one round trip and the window.
- **Own password change now revokes every other session and keeps the current one.** The controller passes
  `req.sessionID`, so the browser that submitted the form stays signed in while other devices drop to `/login`. If a
  future caller cannot supply a session id, the service falls back to deleting all sessions; the controller still
  redirects to `/app/profile` and `requireAuth` then sends the anonymous request to the login form.
- **The users table has no pagination and the audit page is the only M2 screen using `.pager`.** The demo has a
  handful of accounts; add pagination or a search field before the roster grows.
- **The administrator's own reset button is disabled, but the server still accepts a self-reset POST.** A crafted
  request revokes the acting session because the reset path has no self guard; it is secure but logs the person out.
  Route self-service resets through the profile form, which verifies the current password.
- **Creating a user with an administrator-typed password means the plain secret travels in a form body.** TLS covers
  it in production; the alternative (generating every initial password server-side and showing it once) reuses the
  reset flow and avoids the administrator inventing weak passwords.

## M2 CSV import (task 5 follow-ups)

- **The Minsk `DD.MM.YYYY HH:mm` formatter now exists twice**: a private helper in `audit.service.js` and another in
  `import.service.js`. They are identical; extract one into `src/lib/format.js` when a third screen needs timestamps.
- **A committed import writes one query per row plus one update per order/touchpoint.** The 10 000-row ceiling keeps it
  bounded on the local stand, but a real dataset would want multi-row `INSERT ... SELECT unnest(...)` batches. The
  per-row shape is what the brief pins (`insertDailyStatsRow`, `insertOrderRow`, ...).
- **Touchpoint and order templates reference `zerna_customer_0001/0002` from the demo seed.** On a stand without the
  seed those rows fail with «Клиент не найден», which is honest but makes the downloaded template look broken. Point
  the template at a self-contained pair, or label the dependency in the template comment, once templates gain comments.

## M2 CSV export (task 6 follow-ups)

- **The filename does not encode the filters.** `metrika-channels-2026-11-20.csv` looks identical whether it contains
  all channels or only paid ones, so several downloads overwrite each other in the browser. A short hash or dataset
  suffix would keep them apart; the brief pins the current name, so this waits for a format change.
- **The export is a GET with an audit side effect.** Every click appends to `audit_log`, including retries and
  prefetches, so the journal counts downloads rather than unique exports. Acceptable for the demo and required by the
  brief; if the noise becomes a problem, deduplicate by actor+dataset+filters inside a short window.
- **An invalid filter value silently widens the export.** `?kind=bogus` falls back to “all” (like the list screens),
  which can hand the caller more rows than they asked for. A strict 400 would be safer for a download endpoint, but it
  would diverge from the screen filters; revisit together with them.
- **Export SQL repeats the list repositories' filter clauses.** `export.repo.js` mirrors the channels, campaigns,
  daily-stats and orders WHERE/ORDER fragments so a download matches its screen. When M3 adds the stats/orders screens,
  extract the shared predicates into repository helpers instead of keeping four copies in sync by hand.
- **The exported orders file is not accepted by the orders importer as-is.** Export writes `revenue_byn` and
  `margin_byn` (the same `_byn` suffix as every other export), while `validateImportRow('orders', …)` requires
  `revenue` and `margin`; `first_channel_code` is extra and ignored. So «download orders → upload the same file»
  fails with «Укажите сумму выручки», which reads as a broken round trip even though both sides work in isolation.
  Align the two header sets, or add an explicit alias map in the importer, when the export format is next revised.
- **Exported order timestamps keep microseconds but re-import keeps only milliseconds.** `listOrders` formats
  `occurred_at` with `to_char(..., '…SS.US')`, while `timestamp()` in the import validator runs the string through
  `new Date(...).toISOString()`, which truncates to milliseconds. A value stored with sub-millisecond precision
  therefore changes on a round trip. Either export milliseconds (`.MS`) or parse the offset-aware string without
  `Date` on import; the seed writes whole seconds, so the demo does not expose it.
- **`export.repo.js` list helpers have no `= {}` defaults.** `listChannels()`, `listCampaigns()`,
  `listDailyStats()` and `listOrders()` throw on a missing argument object instead of falling back to the screen
  defaults, unlike the other repositories. The service always passes an object today, but a future caller that omits
  the argument gets a `TypeError` rather than a validation error. Restore the defaults or make the argument
  mandatory in JSDoc and enforce it.
- **Plan drift found while closing M2.** The plan's interface block advertised
  `exportService.exportDataset({ dataset, filters, actor }) → { filename, csvContent, rowsCount }`, while the code
  takes no actor and returns `truncated`/`limit` as well; the plan was corrected in Task 8. The Task 6 report prose
  still describes the pre-fix behaviour (advertised cap and truncation handling), and the plan's goal section named
  `002_m2_data.sql` as the source of `goals_unique_idx`, which has always lived in `001_init.sql`. Treat the plan as
  intent, the code and tests as the contract, and fix report prose in the same change that lands the code.


## M2 media assets (task 7 follow-ups)

- **Public media ids are sequential and enumerable.** `/media/:id` exposes every stored picture to anyone who walks
  the id space. This is accepted for the demo because all images are public by design (avatar and OG cover) and the
  task brief names it as an explicit limitation; revisit if private uploads ever appear.
- **The OG cover is stored and served but not yet wired into the landing metadata.** `homePage` is synchronous and
  static, and `buildSeo` still defaults to `/img/og-cover.svg`; wiring `/media/slug/og-cover` into `og:image` needs a
  media-aware public controller and is deferred to M6.
- **The topbar avatar stays initials until M4.** The profile page shows the uploaded picture, but rendering it in the
  shell would add one `media_assets` lookup to every page and the M4 React shell replaces the topbar anyway.
- **Image uploads and their audit rows are not one transaction.** A failure after the `media_assets` write would leave
  an unaudited image. The window is tiny on the local stand; wrap both in `withTransaction` if audit completeness
  becomes a hard requirement.
- **Media uploads have no dedicated rate limit.** Each request is capped at 1 MB and the avatar slug is per-user, but a
  signed-in account can still churn BYTEA writes; add the same limiter as the import route if the stand is exposed.
- **The image size cap (1 MB) differs from the CSV cap (2 MB) by design.** They are separate upload families with
  separate messages; keep them separate instead of sharing one `LIMIT_FILE_SIZE` constant.

## M3 cleanups (agreed priority)

- **Orders export/import header alias — first cleanup in M3.** `export.repo.js` writes `revenue_byn`/`margin_byn`, while
  `validateImportRow('orders', …)` expects `revenue`/`margin`, so «download orders → upload the same file» fails with
  «Укажите сумму выручки». Accept both spellings in the importer (explicit alias map, not a silent rename) and cover
  the round trip with an integration test; the same file already records the timestamp-precision half of the issue.
- **Consolidate the repeated vocabulary and defaults.** `campaignDefaults: { startedOn: dataAnchor }` is built in both
  campaign controllers; `MAX_BIGINT_ID`/id parsing still has copies in `channels.controller.js`,
  `campaigns.controller.js`, `campaigns.schema.js`, `export.schema.js` and `users.schema.js` beside the shared
  `src/lib/ids.js`; the goal metric labels exist twice (`audit.service.js` `GOAL_METRIC_LABELS` and
  `goals.service.js`). Move each to one module so a new metric, id rule or default cannot drift between screens.
- **Cap or paginate the unbounded goals and users lists.** Both screens render every row, unlike campaigns (200-row cap
  with an honest truncation note) and the audit journal (50-row pager). Add the same explicit cap/pager before either
  list can grow past a demo-sized stand.

## Resolved during the M1 final fix wave

Recorded so the deferred findings do not disappear from history when the open entries above are closed.

- **HTTP logs no longer contain `set-cookie`, `metrika.sid` or `x-csrf-token`.** `pino-http` defaults logged every
  response header; custom serializers in `src/lib/logger.js` now emit method/url/statusCode only, with redaction kept
  as defense in depth, and `tests/unit/logger.test.js` guards it.
- **The seed determinism test now fingerprints `daily_stats`** (md5 over campaign, date, impressions, clicks, leads,
  spend) plus min/max event timestamps for orders and touchpoints.
- **Session-id rotation, protocol-relative/backslash/encoded-CR/LF `next` targets and the unknown-email path** now
  have regression tests in `tests/integration/auth.test.js`; `safeRedirectTarget` rejects percent-encoded control
  characters and slashes after one decode.
- **Production environment parsing rejects the `.env.example` placeholder secret and `COOKIE_SECURE=false`**, naming
  the offending key (`src/config/env.js`, covered in `tests/unit/config-env.test.js`).
- **Canonical URLs are normalized** so a protocol-relative or doubled-slash path cannot point off-site
  (`src/lib/seo.js`, covered in `tests/unit/seo.test.js`). The 404 handler still passes `req.path`, which is now safe
  by construction rather than by trusting the caller.
- **The landing no longer claims encrypted backups as a shipped feature**; the security card labels them as a
  deployment-stage capability (`src/views/pages/home.ejs`).

## Финальное ревью M1 — остаточные находки (отложено)

- `src/controllers/public.controller.js` передаёт сырой `req.path` в `buildSeo`; путь с обратным слэшем теперь даёт
  500 вместо 404. Для страницы 404 canonical не нужен — использовать константу `/404`.
- Кастомный `err`-сериализатор логов оставляет только `type/message/stack` и теряет `code`, `statusCode`, `detail`
  (SQLSTATE для ошибок `pg`). Вернуть эти поля в M2, иначе диагностика БД станет хуже.
- `imagePath` в `src/lib/seo.js` не валидируется: вызывающий код может отдать внешний `og:image`. Нормализовать так же,
  как canonical.

## Metrics engine (M3)

### M3 final whole-branch review

Fixed in the final M3 fix wave:

- **Goal progress decided on display-rounded facts.** `goals-progress.service.js` now rebuilds the exact
  ROMI/payback/LTV:CAC guard values from the health row's kopeck fields with `computeRomi`, `computePayback` and
  `computeLtvCac`. Status, `favorable` and the directional `deviation.abs` use those values; `fact.value` and every
  label stay at display precision. The reviewed boundaries (`2.9996` vs `3`, `12.004` vs `12`, `−0,004%` vs `0`)
  now agree with the health status.
- **ROMI labels used two decimals and could hide a tiny negative as `0,0%`.** `src/lib/format.js` now exports
  `formatRomi`: signed, one decimal, typographic minus, and a tiny negative reads `−<0,1%` instead of a positive
  zero. The raw API value keeps two decimals.
- **`health.watchRatio` and `health.romiRiskBelow` were unused.** `deriveHealth` now uses both in exact bigint
  cross-multiplications, so the spec thresholds have one source again.
- **Event-time day bounds stopped at `.999`.** `metrics.repo.js` now uses the half-open
  `[minskDayStart(from), minskDayStart(to + 1 day))` bound for every `timestamptz` predicate, matching attribution
  and cohorts; a sub-millisecond event on the last day can no longer be dropped.

Still open:

- **Goals are exact only at the helpers' guard precision.** `computeRomi`, `computePayback` and `computeLtvCac` keep
  4/6 decimals; a one-kopeck difference on a very large spend can still round the guard value to zero, so a
  pathological sub-guard case can disagree with health's integer threshold. Raising the guard digits or comparing
  bigint cross-products directly would close it; deferred because it needs one shared exact-comparison API.
- **The health report has no single snapshot across its four reads.** CAC, cohort LTV, attribution and the channel
  dimension are consecutive calls; a concurrent import can move one number between them, so rows can mix two
  moments. The cohort service already opens a repeatable-read snapshot for its own reads; extending one snapshot
  across all four would require a shared transaction and is deferred to the concurrency pass.
- **Attribution duplicates the ROMI formula inline.** `buildModelView` computes
  `centsPercent(revenueCents - spendCents, spendCents)` instead of `computeRomi`. The two agree today, but a change
  to guard digits or the zero-spend rule would drift. Route it through the shared helper when the attribution
  view-model is next touched.
- **Ranking normalises display-rounded criteria.** CAC is exact, but ROMI, LTV:CAC and the customer count come from
  the health row after display rounding, so `2.9996` and `3.0000` rank identically. This is a ranking semantics
  decision, not a quick fix: either pass exact guard values into the ranking or document that scores intentionally
  use display precision.
- **A free channel cannot be ranked.** CAC `0n` makes LTV:CAC undefined, so the channel is excluded as
  `missing_criterion` even when it acquired customers at zero cost. This follows the free-channel `no_data` ruling;
  if such a channel should rank, it needs an explicit "free" score rather than a fabricated ratio.
- **`null` and `undefined` defaults are not uniform.** Some service inputs default with `??`, others check
  `=== null` only, so a partial view-model can leak `undefined` where a consumer tests for `null`. Unify the input
  contract in the next metrics change.
- **Ranking and dashboard stay last-touch for M4.** Both read the health default model. A model selector is a
  possible M4 addition; until then a last-touch score must not be labelled as first-touch or linear.
  `getRankingReport` already has the health service's `attributionModel` parameter to forward when that lands.
- **Dashboard channel/campaign filters are an M4 service extension (BO-13), not an M3 defect.** The weekly query
  already accepts `channelIds`; the summary does not expose filters. Wiring them is additive and should not create
  a second aggregation path.
- **Free channels legitimately show «Мало данных».** Email and SEO acquire customers at zero spend: CAC is `free`
  (`0n`) while ROMI is undefined and LTV:CAC has a zero denominator, so health is `no_data`. This is the literal
  metrics-spec ruling, pinned by the T7 integration suite; changing it needs an owner decision.

### M3 attribution (task 3 follow-ups)

- **The comparison table ships one delta, linear vs last-touch.** The task brief listed three model columns but a
  single delta field. The owner settled it during review: `deltaModel: 'linear'`, `deltaLinearVsLastCents`,
  `deltaLinearVsLastPct`. A first-touch delta is derivable from the same row (`firstTouchCents - lastTouchCents`) and
  is intentionally not a separate field; if the UI needs to show both deltas side by side, widen the view-model
  rather than overloading this one.

### M3 cohorts and LTV (task 2 follow-ups)

- **The margin query fetches every month offset of every selected cohort, not just the requested horizon.** The
  repository has no horizon parameter, so a long-lived stand returns rows the service immediately drops
  (`monthOffset >= horizonMonths`). At demo volume (14 months) this is invisible; if history grows to years, pass the
  horizon into `listCohortMonthlyMargins` and cap offsets in SQL.
- **`withSnapshot` recognises a pool by the `pg.Pool` connection counters (`totalCount`).** A bare `pg.Client` that is
  not already inside a transaction is treated as transactional and will not open a repeatable-read snapshot. The
  integration tests only pass checked-out pool clients, so the rule holds there; if the service ever receives a
  standalone client, wrap it explicitly.
- **`getChannelLtv` and the matrix's `channelLtv` include inactive channels.** This is required so historical LTV can
  be left-joined with CAC after a channel is archived, but the UI must decide whether to grey out or hide an inactive
  row; the view-model deliberately carries no `isActive` flag yet.
- **The matrix merges channels into company cohorts, so it cannot show a channel breakdown per month.** A per-channel
  matrix is available through `getCohortMatrix({ channelId })`; rendering every channel × month at once would need a
  wider view-model and is out of scope for BO-06.
- **A cohort month later than the anchor is rejected, but `fromCohortMonth` earlier than the first customer is
  accepted** and simply returns the available months. That matches a date-range filter; the UI should clamp the picker
  to the data window rather than relying on an error.

### M3 ranking (task 5 follow-ups)

- **`getRankingReport` cannot select the attribution model.** It always ranks the health report's default
  (`last_touch`), while `getChannelHealthReport` already accepts `attributionModel`. Deliberately out of the BO-04
  brief, but once the UI lets users compare models the ranking must forward the parameter instead of adding a second
  report path; otherwise the screen would show a last-touch score under a first-touch/linear label.

### M3 aggregation (task 6 follow-ups)

- **The weekly series always returns `weeks` buckets, filling absent weeks with zeros.** The brief said "empty data →
  an empty series"; a fixed axis was chosen instead so a chart cannot silently shorten its period and every bucket
  keeps the `weekStart` contract. The dashboard's empty state should be decided from `verdict.status`/all-zero
  buckets, not from `weeklySeries.length`.
- **The last complete week is the week containing `to` when `to` is Sunday.** The brief's
  `addDays(isoWeekStart(to), -7)` would drop that complete week; the semantic rule "only full Mon–Sun weeks" was
  implemented and is pinned by `tests/unit/weekly-series.test.js` and a Sunday-anchor dashboard case. Every other
  `to` weekday gives the brief's formula unchanged. The series length is bounded to 1–52 weeks: an unbounded axis
  would loop and shift dates without any screen ever needing it.
- **`deviation.abs` is directional while `deviation.pct` is a signed fact-vs-plan change.** For lower-is-better a
  positive `abs` means "behind"; for higher-is-better the sign is inverted by the brief, while `pct` always uses
  `percentChange(fact, target)`. M4 must read `favorable` (`true`/`false`, `null` for `no_data`) for tone and text
  and must not infer good/bad from the signed `label`; if one signed number is needed, extend the view-model rather
  than reinterpreting these two.
- **Funnel monotonicity is a property of the data, not a rule of the service.** `getChannelFunnel` sums independent
  sources (`daily_stats` stages vs `customers`), so a channel can acquire more customers than it logged leads; the
  view-model shows that honestly instead of clamping stages. The integration test only proves the seeded stand is
  monotonic — M4 must not draw a funnel chart that assumes a narrowing shape.
- **Goal metric labels are duplicated from `goals.service.js`.** The M2 labels are private, so
  `goals-progress.service.js` repeats the five Russian names. They must stay byte-identical; moving them into
  `src/lib/metrics-labels.js` is the obvious fix once M2's list is next touched.
- **`getDashboardSummary` has no channel/campaign filter yet.** BO-13 mentions filters, but T6 only defines the
  unfiltered view-model; the weekly query already accepts `channelIds`, so the filter can be added without a second
  aggregation path.

### M3 integration, golden numbers and performance (task 7 follow-ups)

- **M5 deferrals.** Alert rules and the alerts screen, what-if scenarios, and budget optimisation are outside M3.
  M3 ships the eight analytics view-models with no HTTP layer; M4 renders them and M5 adds alerts/scenarios/budget.
- **The measured query ceilings are higher than the plan's illustrative numbers.** The plan listed CAC 2,
  health/ranking 8, dashboard 11, passport 15, goals 9. `getAttributionReport` actually performs four reads (orders,
  touchpoints, `listChannelSpend`, channel dimension), not two, so every ceiling that includes a health report is
  two higher; the LTV `withSnapshot` adds `BEGIN`/`COMMIT`, which `tests/helpers/queryCounter.js` counts because
  they are real round trips. T7 pins the measured flat ceilings (CAC 2, LTV 5, attribution 4, health/ranking 12,
  dashboard 15, passport 19, goals 13) and the invariant that they do not grow with the number of channels. The
  alternative — silently counting only pool-level queries — would have hidden the LTV snapshot and made the plan's
  numbers look satisfied; that is worse than an honest ceiling.
- **The company-wide CAC query does not use the migration-004 index, by design.** `listChannelCacInputs` aggregates
  every channel, so under `enable_seqscan=off` PostgreSQL picks `customers_first_order_idx` for the
  `first_order_at` window. `customers_channel_first_order_idx` serves the channel-scoped read
  (`getChannelFunnel` and the passport/dashboard channel card), which filters `first_channel_id` first. Both paths
  are asserted in `tests/integration/metrics.performance.test.js`. Migration 005 drops `customers_first_channel_idx`:
  the composite's leading column covers every channel-only predicate, so keeping the single-column index would add
  write cost and planner choice without serving a new access pattern.
- **The health report still loads the channel dimension twice.** `getAttributionReport` reads `channels` for its
  comparison rows, and `getChannelHealthReport` then calls `channelsRepository.listChannels()` again for names and
  sort order. The measured health budget is 12; forwarding the attribution dimension (or asking attribution for a
  name map) would make it 11. Deferred because it changes the T3/T4 contract, not the T7 test.
- **The dashboard weekly test recomputes the attributed series instead of summing the dashboard buckets.** T6's
  `weeklySeries` exposes weekly CAC/ROMI but not weekly attributed revenue, so the test calls
  `getAttributionReport` for the same window and compares totals. That proves the window and model agree, but it does
  not independently prove the dashboard's own buckets sum to the total; widening the view-model with
  `attributedCents` would close the gap.
- **The exact ranking-score assertion is a consistency check, not independent proof.** It recomputes the weighted
  sum from the same `contributions`/`weightsBasisPoints` the service returned. It catches a score that does not match
  its own terms, but an error in the basis-point apportionment would move both sides together; the unit suite's
  fixtures are the independent check.
- **The plan's payback fixtures are not encoded.** `payback = 12 / ratio`, so `payback 12` means `ratio 1`, which is
  `watch`, not `healthy`; `payback 12.004` implies `ratio < 1` and is `risk`. T7 asserts the derived statuses
  (`12 → watch`, `12.004 → risk`, `ratio 2.9996 → watch`) instead of the plan's unsatisfiable `12 → healthy` case.
- **Free channels stay `no_data`.** Email and SEO acquire customers at zero spend, so CAC is `free` (`0n`) while ROMI
  is undefined and health is `no_data`. This is the literal metrics-spec ruling and is now pinned by the T7
  integration suite; changing it needs an owner decision, not a test edit.
- **`goals.cac` is the one money value that must be parsed with `parseBynToCents`.** `goals.target_value` is a mixed
  `NUMERIC(14,2)` (BYN, percent, ratio, months, count), so there is no `target_value_cents` column. `goals-progress`
  converts only the CAC target through `parseBynToCents` and keeps the other units numeric; a future `Number()`
  shortcut would turn `50,00` into `50` or `NaN` depending on the separator.
- **Golden numbers are a recapture contract, not a tolerance.** `tests/fixtures/m3-golden.json` records anchor, from,
  to, model, horizon and seed PRNG. `tests/integration/metrics.services.test.js` compares exact kopeck strings and
  integers, and asserts the fixture's PRNG equals the exported `SEED_PRNG`. Any seed change must update the fixture in
  the same commit; otherwise the suite fails honestly instead of drifting.
- **Ranking contributions are display-rounded individually.** The exact weighted sum equals the score (asserted in
  integer basis points), but the visible `Σ contributions` can differ from the score by up to one hundredth after
  per-term rounding. T7 asserts both the exact sum and a `0.05` display tolerance; a UI that prints the sum must use
  the same tolerance rather than an equality check.
- **The dashboard bundle fits the page budget; the entry budget is raised to 210 KB and is now nearly full.** The
  T2 build is one production file: 718 886 B raw / **209 740 B gzip** (`gzip -9`; Vite reports 212.87 kB with its own
  gzip). That is the entry and the whole page at once: it clears the 250 KiB page budget by about 45 KiB but the
  amended 210 KiB entry budget by only about 5 KiB, because T2 added the two per-channel charts. The old 160 KB entry
  figure was unrealistic for React 19 + Recharts 3.11: no unused Recharts component is imported and a deep-import
  experiment produced the same size. The next dashboard addition needs a decision (vendor split or lazy charts), not
  a silent budget edit; T7 must re-measure. `tests/integration/build-output.test.js` now enforces both ceilings.
- **`formatCompactCents` follows the metrics spec, not the plan's arithmetic example.** `12_340_000` kopecks is
  123 400 BYN, so the axis reads `123,4 тыс.`, not the plan's `12,3 тыс.` (that would be `1_234_000` kopecks).
  The unit test pins both the thousands and the millions boundary; the plan example should be corrected in T7.
- **The gzip budget guard is build-dependent and zlib-version sensitive.**
  `tests/integration/build-output.test.js` now measures zlib level 9 on the manifest's entry/page files and fails above
  210 KiB / 250 KiB. It is skipped when `public/assets` is absent, so CI must build before testing (the same
  precondition as the other build-output assertions). zlib output can move a few bytes between Node releases; the
  whole-kilobyte ceilings absorb that. A future failure should trigger a split or lazy-chart decision, not a byte
  bump.
- **Two channel repository instances are alive in one app.** M2's channel controller builds its own
  `channelsRepository`, while the metrics composition root builds another. The instances are stateless wrappers
  around one pool, so this costs no connection and no state. T3 added `channelListService` but did not move M2 onto
  the composition root; the cleanup now belongs with the T4 passport wiring so the router does not change twice.

## M4 Task 3 — channels table follow-ups

- **Archive/restore buttons left the channels list.** The M2 list was replaced by the React island, whose model is
  data-only; a per-row POST form would need a CSRF token in `data-props`, which the island contract deliberately does
  not carry. The passports keep both actions, and the list row now opens the passport, so nothing is unreachable.
  A quick archive column is an M5+ decision, not a silent regression.
- **The sparkline unit test cannot assert the final `<svg>`.** Recharts 3 builds its surface after layout
  (`ReportChartSize` dispatches in an effect), so `react-dom/server` renders the fixed `recharts-wrapper` only. The
  unit test pins the wrapper geometry and the dash state; the real SVG (8 of them) is verified in `agent-browser`.
  An automated DOM environment would need a new dev dependency, which this milestone does not justify.

## M4 Task 4 — channel passport follow-ups

- **The passport shows two campaign tables.** The M2 management table (status, dates, budget, lifetime spend, edit
  links) is preserved as required, while the React table gives period CAC and customer counts. They answer different
  questions, but the page is long; merging them or moving the management table behind an edit mode is an M5 decision.
- **The spend/revenue chart is an extra third chart.** The T4 interface named `charts: { cac, romi }`; the grouped
  weekly spend/attributed-revenue bars reuse the existing series and add no query. The campaign-dimension stacked area
  stays deferred because `listWeeklySeries` has no campaign dimension.
- **Budget wording:** the 26-query passport budget is service-level (M2 detail, campaign list, M3 passport, cohort
  matrix). A real page request adds the single `getDataAnchor()` read, and the session store query is outside the
  count, matching the other M4 budgets.
- **The passport retention payload is intentionally narrower than the M3 matrix.** The grid reads ready labels, heat
  classes and the partial flag; raw `ltvCents`, `cumLtvCents`, `isComplete` and `monthsObserved` are not sent in
  `data-props`. The cohorts screen keeps the richer model and its own aggregation.
- **A capped campaign list states the cap.** The passport returns at most `CAMPAIGN_LIST_LIMIT` campaigns and exposes
  `campaignsTruncated`; the island prints “Показаны первые N кампаний” and points to the campaign screen for filters.

## M4 Task 5 — cohorts follow-ups

- **The cohorts screen accepts `channelId` but does not render a channel picker.** This follows the M4 plan's
  deferred table: the API and page model narrow the matrix, and horizon links preserve the parameter, but the design
  §8 screen has no channel-control scenario. If the owner wants a visible filter later, it should be one GET select
  that replays `horizon`; no server change is needed.
- **The heatmap table contract repeats the cohort rows in `table` and `cohorts`.** `table` is a ready `<table>` shape
  (header, row header, cell labels, heat classes) used by the island and JSON consumers; `cohorts` keeps the raw
  `retentionPct`/`cumLtvCents` for API clients. The duplication grows the JSON payload roughly by the matrix size
  (~30 KB on the demo stand). Dropping one shape would either force every consumer to re-derive labels or remove
  raw values from the API; the duplication is documented rather than accidental.
- **`channelLtv` is returned but not drawn.** The model carries the M3 per-channel LTV rows so an API client can use
  them and a future channel breakdown needs no second request, but the design's cohorts screen is company-wide only.
  Rendering it on this screen would add a table the owner did not request.
- **`KNOWN_ENTRIES` was missing `channel` as well as `cohorts`.** The optional-manifest guard in `src/lib/assets.js`
  is the only typo check before the first build; without `channel` a fresh development clone rendering a passport
  would throw while `dashboard` worked. Both entries are now listed; the manifest remains authoritative when present.

## M4 Task 6 — attribution follow-ups

- **Model-level totals and ROMI are invariant by mathematics.** Every model allocates the same order revenue, so
  `totalAttributedCents` and model `romiPct` agree across `last_touch`, `first_touch` and `linear` whenever orders are
  attributable at all; only the per-channel split changes. The screen states this explicitly and shows one totals tile
  per model, but the actionable comparison is the channel delta (`linear − last_touch`), not a model leaderboard.
  Do not add a "best model" verdict without a per-channel objective: the totals cannot rank the models.
- **Channel names are now readable without a second lookup.** The M3 attribution comparison is an additive view-model
  change: each row carries `channelName` next to `channelId`/`channelCode`, joined from the channel dimension already
  loaded for the report. No query was added. The chart axis, its duplicate table and the delta table show names; codes
  remain in the API for stable keys and exports.
- **The delta percent column is rounded to one decimal for alignment.** Raw `deltaLinearVsLastPct` keeps its service
  precision (two decimals or more), while the cell formats `roundNumber(pct, 1)`; mixing `+2,4%` with `+0,38%` made the
  column impossible to scan. A future export should use the raw value, not the display rounding.
- **The model switch is a GET link, not an auto-submitting select.** This matches the cohorts horizon control and the
  plan's decision 10: the URL is the only state, and the links replay `days` or an explicit `from`/`to` range. A
  JavaScript select would introduce a second navigation path without changing what the server can already do.
- **Attribution has no campaign-scope allocation.** M3 exposes channel allocation only, so the screen has no campaign
  filter and no campaign breakdown. That remains deferred to M5 together with alerts, scenarios and the optimizer;
  drawing channels as campaigns would fabricate a dimension the service does not expose.

## M4 Task 7 — shared states, accessibility and budget

- **The per-cell cumulative LTV in the retention matrices is still a hover detail for sighted users.** Each cell now
  carries `aria-label` with both the retention percentage and the cumulative LTV, so a screen reader is no longer
  limited to the tooltip; a keyboard or touch user still cannot read it without hovering. A drill-down row or an
  expandable cell would expose it visually, but that changes the dense matrix layout and is deferred.
- **The channels ranking table needs horizontal scrolling at 1280px.** With 12 columns the card is narrower than the
  table even on a laptop; the `.table-wrap` region is focusable and scrolls inside the card, and the page itself never
  overflows. A sticky first column or a column chooser would remove the pan, but both are a redesign.
- **The request cache covers three repository methods only.** `channels.listChannels`, `channels.findChannelById` and
  `campaigns.listCampaignsByChannel` are deduplicated per GET; the dashboard still reads orders and touchpoints twice
  with different windows (period and 12-week series), which is not a duplicate — the parameters differ. Extending the
  cache to those would require the service to expose whether the windows are equal.
- **The shared React + Recharts chunk is 641 KB minified / 193 KB gzip.** Vite prints its generic >500 KB warning on
  every build. Every page total is under the 250 KB gzip budget, and the chunk is immutable and cached across all five
  screens, so the warning is cosmetic; silencing it with `chunkSizeWarningLimit` would hide a real future regression.
- **A chart error boundary cannot be reset without a reload.** Recharts errors usually come from the data shape that
  the server sent, so the fallback's retry is an honest `window.location.reload()`; there is no per-chart endpoint to
  refetch. If a future error is transient, a state reset button would need a data loader the island does not have.
- **The mobile navigation checkbox is announced as "Разделы" with its checked state.** The visible label no longer
  lies with a fixed `aria-label="Показать разделы"`; the trade-off is that the open/closed wording lives in the native
  checkbox state, not in the label text.
- **The Recharts legend cannot take a class name.** `Legend` ignores `className` and paints its labels with the series
  colour (2.5:1 on white). The Money legend now uses a `formatter` that wraps the label in `.chart__legend-label`;
  a chart that adds a default legend later must repeat that formatter, and `tests/unit/client-guards.test.js` does not
  catch the visual regression — only the browser contrast sweep does.
- **Other M2/M3 screens still use the word «рублях».** This task fixed the two M4 pages (`channels.ejs`,
  `channel-detail.ejs`) because the currency rule is absolute for the interface. `campaigns.ejs`, `goals.ejs` and
  `import.ejs` still say «в белорусских рублях»; the fix is a copy-only change but it sits outside this task's five
  screens, so it is listed here instead of bundled in.
- **Zero spend is rendered as an empty state, not a flat zero line (product ruling).** `buildSpendRevenueChart` and
  `buildChannelSpendChart` now set `hasData` from actual values: an all-zero series means "no measured activity", so
  the frame explains the absence instead of drawing a line that a reader cannot tell apart from missing data. The zero
  weeks and per-channel zeros remain in the duplicate table, and KPI totals keep their measured zeros, because a total
  of `0,00` is a fact while a zero-shaped plot is ambiguous. Reverting this requires a product decision, not a test
  edit: `states.test.js` pins both directions.
- **The plot canvas is `inert`, so chart tooltips are gone.** Chromium puts Recharts' bare `<g>` z-index layers in
  the sequential focus order even with `accessibilityLayer={false}` and an explicit `tabindex="-1"`; only an inert
  subtree removes them. The plot is a static picture and every value is in the duplicate table, so the loss is a
  hover nicety, not information. A future interactive chart needs a keyboard-first design, not just removing `inert`.
- **The empty-state action is named «Открыть таблицу данных», not «Показать таблицу».** The disclosure `<summary>`
  already uses the latter; two controls with the same accessible name opened the same table. The names are now unique
  and the action is covered by a behaviour test (`revealDetails`) plus the browser pass, because a server render cannot
  click it.
