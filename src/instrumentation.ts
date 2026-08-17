/**
 * Runs once when the server starts, before it accepts any request.
 *
 * On a managed host there is no terminal: `npm run db:migrate` and
 * `npm run db:seed` cannot be typed anywhere. Without this the app would start
 * against an empty file and fail on the first page — so the schema and the
 * chart of accounts are brought up to date here instead.
 *
 * Both steps are safe to repeat on every restart. Migrations are versioned and
 * skip what is already applied; `seedCore` checks for each row before inserting
 * and returns early when the settings row exists. Neither writes demo data —
 * that is a separate command, and it refuses to run in production.
 *
 * If either fails, the error is rethrown. A bookkeeping application that starts
 * with a half-built schema would take a sale and lose it; refusing to start is
 * the safer failure.
 */
export async function register(): Promise<void> {
  // The edge runtime has no filesystem and cannot load a native module. Next
  // evaluates this file in both runtimes, so the guard is required, not tidy.
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

  // `next build` starts workers that evaluate instrumentation. Touching the
  // database during a build would migrate whatever file the build machine
  // happens to point at — on a managed host, that is not the shop's database.
  if (process.env['NEXT_PHASE'] === 'phase-production-build') return;

  const { runStartupMigrations } = await import('@/db/startup');
  await runStartupMigrations();
}
