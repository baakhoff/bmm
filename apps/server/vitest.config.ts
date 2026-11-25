import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Every test builds a full app on an in-memory Postgres (PGlite, WASM).
    // Several files doing that at once need many gigabytes; one at a time
    // stays small. Slower, and it does not take the machine down.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
