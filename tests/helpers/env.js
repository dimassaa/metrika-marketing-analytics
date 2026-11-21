// Loaded through `setupFiles` before every test module. Unit tests still import src/config/env.js, which reads
// DATABASE_URL, so the test environment is pinned here and the dedicated test database is required up front:
// failing at setup names the missing variable instead of surfacing a confusing connection error later.
import 'dotenv/config';

process.env.NODE_ENV = 'test';

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Copy .env.example to .env and point TEST_DATABASE_URL at the metrika_test database.',
  );
}
