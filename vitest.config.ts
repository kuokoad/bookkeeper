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

    /**
     * Vitest defaults to 5s, which is tuned for pure unit tests. Very little
     * here is one. A typical test in this suite builds a real SQLite database
     * by running all the real migrations, and the rest take real online
     * backups, hash real passwords, or walk ten thousand prices to prove a tax
     * identity holds at every one of them. Several land within a second or two
     * of that ceiling on an idle machine and go over it whenever anything else
     * on the machine is busy.
     *
     * That produced runs of `npm run verify` failing with a handful of "Test
     * timed out in 5000ms" lines and not one failed assertion — a red gate
     * carrying no information, which is worse than a slow one. Raising it here
     * rather than per test, because the ones that tripped were a different set
     * each time; it is the suite that is slow, not three particular tests.
     *
     * The cost is honest: a test that genuinely hangs now takes 30s to say so.
     * That is the right trade for a gate that means something when it is red.
     */
    testTimeout: 30_000,
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
