/**
 * Applies pending SQL migrations, then verifies the result.
 *
 * Run with `npm run db:migrate`. Safe to run repeatedly — drizzle records which
 * migrations have already been applied.
 *
 * Imports `./pragmas` rather than `./client` on purpose: `client` is marked
 * `server-only` and cannot be loaded by a plain Node script.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { assertDatabaseHealthy, configureConnection } from './pragmas';
import { env } from '@/lib/env';

const MIGRATIONS_FOLDER = resolve(process.cwd(), 'src/db/migrations');

export function runMigrations(databasePath: string = env.DATABASE_PATH): void {
  const absolute = resolve(process.cwd(), databasePath);
  const directory = dirname(absolute);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });

  const connection = new Database(absolute);
  configureConnection(connection);

  try {
    // SQLite cannot add a CHECK constraint in place, so drizzle rebuilds such a
    // table as create-copy-drop-rename. Dropping a table other tables reference
    // needs foreign key enforcement off — and `PRAGMA foreign_keys` is a NO-OP
    // inside a transaction, which is exactly where drizzle runs migrations. So
    // it must be toggled here, on the connection, before the transaction opens.
    connection.pragma('foreign_keys = OFF');

    try {
      migrate(drizzle(connection), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      connection.pragma('foreign_keys = ON');
    }

    // Enforcement was off, so prove nothing was orphaned before we accept it.
    assertDatabaseHealthy(connection);
  } finally {
    connection.close();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url.replace(/\\/g, '/').endsWith(entry.replace(/\\/g, '/').split('/').pop() ?? '');
}

/**
 * Drizzle reports the failing SQL but buries the actual SQLite error in
 * `cause`. Printing only the outer message produces a wall of DDL with no
 * explanation, which is worse than useless when a migration fails.
 */
function describeFailure(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }

  return parts.length > 0 ? parts.join('\n  caused by: ') : String(error);
}

/** Turn the common failures into an instruction the reader can act on. */
function hintFor(error: unknown): string | null {
  const text = describeFailure(error).toLowerCase();

  if (text.includes('already exists')) {
    return (
      'The database already contains these tables, but its recorded migration\n' +
      'history does not match the migration files. This happens when a migration\n' +
      'file is regenerated after it was already applied.\n\n' +
      'In development, rebuild from scratch:\n' +
      '  npm run db:reset -- --force && npm run db:migrate && npm run db:seed'
    );
  }
  if (text.includes('database is locked') || text.includes('ebusy')) {
    return 'Another process is using the database. Stop the dev server and try again.';
  }
  return null;
}

if (isDirectRun()) {
  try {
    runMigrations();
    console.log(`Migrations applied successfully to ${env.DATABASE_PATH}`);
  } catch (error) {
    console.error(`Migration failed: ${describeFailure(error)}`);
    const hint = hintFor(error);
    if (hint) console.error(`\n${hint}`);
    process.exitCode = 1;
  }
}
