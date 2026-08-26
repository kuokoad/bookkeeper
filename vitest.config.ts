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
    },
  },
});
