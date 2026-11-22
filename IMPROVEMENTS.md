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
- **A threshold-refused batch has no `batchId` in the response**, because the contract explicitly sets it to `null`
  when the 10 % rule rejects a file. The report is persisted and visible in the last-20 table, but the island cannot
  link to it directly; the person has to reload the page. Revisit the contract if a permanent deep link is required.
- **Touchpoint and order templates reference `zerna_customer_0001/0002` from the demo seed.** On a stand without the
  seed those rows fail with «Клиент не найден», which is honest but makes the downloaded template look broken. Point
  the template at a self-contained pair, or label the dependency in the template comment, once templates gain comments.

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
