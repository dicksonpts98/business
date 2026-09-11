import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one PostgreSQL database and truncate between
    // cases, so they must not run in parallel against each other.
    fileParallelism: false,
    sequence: { concurrent: false },
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
