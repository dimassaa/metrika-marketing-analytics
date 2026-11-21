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

## Design system

- **`--shadow-subtle` is unused and `--shadow-preview` only serves the landing preview.** Shipped shadows should be
  the ones components actually use; either apply them in M2 or remove them so the token list stays honest.
- **Public components use unprefixed global class names** (`.card`, `.btn`, `.field`, `.table`, `.badge`), while the
  app shell namespaces its own as `app-*`. Nothing collides today, but a public variant of `.card` will change app
  screens too. Scope public classes under a wrapper or namespace them before the M4 React islands add more classnames.

## Public landing

- **The mobile header hides the anchor navigation** (`.site-nav { display: none }`) and leaves only the brand and
  «Войти». Add a compact disclosure or a shortened menu with «Возможности / Как считаем / Безопасность» so the
  landing does not lose its in-page navigation at 390 px.
- **The landing promises encrypted backups with a 7-day retention** («pg_dump + AES-256-GCM, 7 дней»), but backup
  tooling belongs to M6. Keep the copy only if it is labelled as a planned capability; otherwise reword it until the
  scripts exist, so the demo does not describe a feature that cannot be shown.
- **The Open Graph image is SVG** (`public/img/og-cover.svg`). Several social crawlers reject SVG for `og:image`.
  Render a 1200×630 PNG for the meta tag in M6 and keep the SVG as the editable source.

## Runtime

- `pino-http` logs the full response header set, including CSP, on every request. Trimming the serializers would cut
  log volume, but the log shape should be decided together with the observability work, not now.
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
- **The determinism test ignores `daily_stats` values.** It compares row counts and `sum(revenue_cents)`, so a change
  in impressions, clicks, leads or spend would still pass. Add a checksum over those columns (or a content hash of the
  daily rows) to the idempotency assertion.
- **Several seed comments overclaim behaviour**: "byte-for-byte", "documented in README", "spend from the start" and
  the "30-day window" wording do not match what the generator or the docs actually do. Fix the comments with the next
  seed change; a misleading comment is worse than none.
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
- **Session-id rotation on login and rejection of an unsafe `next` are verified only indirectly.** The auth tests
  assert the redirect and the external target, but not that the cookie value changed across login or that `//evil`,
  `\evil` and CR/LF targets fall back. Add both assertions with the first auth change; they guard a security property
  that a refactor can silently break.
