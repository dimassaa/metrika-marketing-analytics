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
