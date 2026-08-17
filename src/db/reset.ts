/**
 * Deletes the database file so it can be rebuilt from scratch.
 *
 * `npm run db:reset` — DESTRUCTIVE. Development only.
 *
 * Fails loudly rather than silently. On Windows a running dev server keeps the
 * database file open and the delete is refused; swallowing that error leaves a
 * stale schema behind that then fails the next migration in a confusing way.
 * That exact failure is why this script reports the problem instead of ignoring
 * it.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

import { env, isProduction } from '@/lib/env';

const FORCE_FLAG = '--force';

function removeIfPresent(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EBUSY' || code === 'EPERM') {
      throw new Error(
        `Could not delete ${path} because another process is using it.\n` +
          'Stop the dev server (and any db:studio session) and run this again.',
      );
    }
    throw error;
  }
}

function main(): void {
  if (isProduction) {
    throw new Error('Refusing to delete the database with NODE_ENV=production.');
  }

  if (!process.argv.includes(FORCE_FLAG)) {
    console.warn('This permanently deletes the database and every record in it.');
    console.warn(`Target: ${resolve(process.cwd(), env.DATABASE_PATH)}`);
    console.warn('');
    console.warn('Re-run with --force if that is what you want:');
    console.warn('  npm run db:reset -- --force');
    process.exitCode = 1;
    return;
  }

  const base = resolve(process.cwd(), env.DATABASE_PATH);
  // SQLite in WAL mode keeps two companion files; leaving them behind would
  // resurrect part of the old database.
  const removed = [base, `${base}-wal`, `${base}-shm`].filter(removeIfPresent);

  if (removed.length === 0) {
    console.log('No database file found — nothing to delete.');
  } else {
    for (const path of removed) console.log(`Deleted ${path}`);
  }
  console.log('Now run: npm run db:migrate && npm run db:seed');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
