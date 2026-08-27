import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    // `.tsx` too, for the handful of tests that RENDER a component. Those
    // opt into a DOM with a `@vitest-environment happy-dom` docblock; every
    // other test stays on the node environment, which is faster and is what
    // the accounting suites want.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/*.test.ts'],
    // Financial invariant tests must not be silently skipped.
    passWithNoTests: false,
    restoreMocks: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws on import outside a server bundle, which is the
      // whole point of it. Under the test runner there is no bundle to be on
      // the wrong side of, so it stands in for nothing and the modules that
      // declare it stay testable.
      'server-only': fileURLToPath(new URL('./tests/helpers/server-only.ts', import.meta.url)),
    },
  },
});
