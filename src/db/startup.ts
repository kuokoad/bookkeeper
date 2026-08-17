import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from '@/db/schema';
import { assertDatabaseHealthy, configureConnection } from '@/db/pragmas';
import type { Db } from '@/db/types';
import { seedCore } from '@/db/seed/core';
import { env } from '@/lib/env';

/**
 * Bringing the database up to date at server start.
 *
 * Kept out of `instrumentation.ts` so it can be imported and tested directly,
 * and so the heavy imports are only loaded in the Node.js runtime.
 */

const MIGRATIONS_FOLDER = resolve(process.cwd(), 'src/db/migrations');

let alreadyRun = false;

export async function runStartupMigrations(databasePath?: string): Promise<void> {
  // `register()` is called once per server instance, but a dev server that
  // reloads can call it again. The work is idempotent either way; this just
  // avoids the log noise. An explicit path is always honoured, so tests and
  // tools can prepare a database other than the running shop's.
  if (databasePath === undefined) {
    if (alreadyRun) return;
    alreadyRun = true;
  }

  const file = resolve(process.cwd(), databasePath ?? env.DATABASE_PATH);

  // The database may live outside the deployed application folder — on a
  // managed host it must, or a redeploy would replace it. Its directory will
  // not exist on a first run.
  const directory = dirname(file);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
    console.warn(`Created the database directory ${directory}.`);
  }

  const isNew = !existsSync(file);
  const connection = new Database(file);

  try {
    configureConnection(connection);
    const db = drizzle(connection, { schema }) as Db;

    // Foreign keys off for the rebuild-style migrations, then back on and
    // verified — exactly as `src/db/migrate.ts` does. A different procedure
    // here would mean the deployed database was built a way no test covers.
    connection.pragma('foreign_keys = OFF');
    try {
      migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      connection.pragma('foreign_keys = ON');
    }
    assertDatabaseHealthy(connection);

    // The chart of accounts, document numbering and settings row. Without
    // these the application cannot post anything at all.
    db.transaction((tx) => seedCore(tx));

    if (isNew) {
      console.warn(`Created a new database at ${file}. Open the site to set up the shop owner.`);
    }
  } catch (error) {
    // Say plainly what failed and where, then refuse to start. Serving pages
    // against a half-built schema would take a sale and lose it.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`The database at ${file} could not be prepared: ${reason}`);
    throw error;
  } finally {
    connection.close();
  }
}
