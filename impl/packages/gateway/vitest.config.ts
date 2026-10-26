import { defineConfig } from 'vitest/config';

// `npm test`: everything runs on localhost (an in-memory relay, the gateway on 127.0.0.1); no network.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 90_000,
  },
});
