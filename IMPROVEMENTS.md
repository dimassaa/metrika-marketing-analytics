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

## Runtime

- `pino-http` logs the full response header set, including CSP, on every request. Trimming the serializers would cut
  log volume, but the log shape should be decided together with the observability work, not now.
- `/health` reports only `status`, `db` and `version`. If deployment ever needs partial degradation (DB up but a
  dependency down), the response shape has to grow; nothing today requires it.

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

## Errors and access

- **403/404/500 render inside the public layout**, so a signed-in visitor sees the landing header with «Войти» and
  landing anchors («Возможности», «Как считаем», «Безопасность») on an error page. The error content itself is
  correct; the shared header needs an authenticated variant once the public partials can be touched.
- **404 copy assumes a signed-in visitor** («Вернитесь в дашборд…»). Anonymous visitors get the same sentence and
  only later see «На главную»/«Войти»; branch the copy with the same `currentUser` check that picks the links.

## Data formatting

- **Last login is displayed as a date only** (`20.11.2026`). There is no Minsk datetime formatter yet, so the time of
  day is dropped; add one to `src/lib/format.js` when that module lands and show date + time for the roster.
- **`formatAnchorRu` is a thin alias of `formatDateRu`.** It currently only names the intent; keep it if the anchor
  later needs its own format, otherwise inline `formatDateRu` and remove the wrapper.

## Tests

- **The 500 page has no automated regression test.** It was verified through a throwaway harness against the real
  `errorHandler`. A test needs an injectable failing route (or a deliberately broken pool and an authenticated
  session); add it with the first error-handling change.
- **The rbac empty-state test is order-dependent.** It truncates `daily_stats, touchpoints, orders, customers` and
  never reseeds, so any later test in the same file that needs statistics would fail. Move it to its own file with a
  `beforeAll` seed or reseed in a `finally`; Vitest's `fileParallelism: false` only hides the problem across files.
