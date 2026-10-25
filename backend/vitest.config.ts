import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/globalSetup.ts'],
    setupFiles: ['./tests/setupEnv.ts'],
    // Integration tests share one database, so run files sequentially.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
