import { defineConfig } from 'vitest/config';

// `npm test` runs everything except *.live.test.ts; `npm run test:live`
// (vitest --mode live) runs only those, and they skip unless RDV_LIVE_RELAYS is set.
export default defineConfig(({ mode }) => ({
  test:
    mode === 'live'
      ? { include: ['test/**/*.live.test.ts'], testTimeout: 180_000, passWithNoTests: true }
      : {
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.live.test.ts', 'node_modules/**', 'dist/**'],
          testTimeout: 90_000,
        },
}));
