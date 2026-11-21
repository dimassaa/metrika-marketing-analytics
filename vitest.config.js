import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Integration tests share one PostgreSQL database and reset its schema, so files must not run in parallel
    // until tests get per-schema isolation (see IMPROVEMENTS.md).
    fileParallelism: false,
    setupFiles: ['tests/helpers/env.js'],
  },
});
