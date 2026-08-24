import 'server-only';

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema';
import { configureConnection } from './pragmas';
import { writeTransaction } from './transaction';
import type { Db } from './types';
import { env } from '@/lib/env';

export type { Db, Tx } from './types';

function createConnection(path: string): Database.Database {
  // The database location is operator-configured at runtime (DATABASE_PATH), so
  // it cannot be statically analysed. This app is self-hosted on the shop's own
  // machine rather than bundled for serverless, so whole-project tracing is not
  // a concern here.
  const absolute = resolve(/* turbopackIgnore: true */ process.cwd(), path);
  const directory = dirname(absolute);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  const connection = new Database(absolute);
  configureConnection(connection);
  return connection;
}

// Next.js dev server hot-reloads modules; without this cache each reload would
// open another SQLite handle and eventually exhaust file descriptors.
const globalForDb = globalThis as unknown as {
  __bookkeeperConnection?: Database.Database;
  __bookkeeperDb?: Db;
};

export const sqlite: Database.Database =
  globalForDb.__bookkeeperConnection ?? createConnection(env.DATABASE_PATH);

export const db: Db =
  globalForDb.__bookkeeperDb ?? drizzle(sqlite, { schema });

if (env.NODE_ENV !== 'production') {
  globalForDb.__bookkeeperConnection = sqlite;
  globalForDb.__bookkeeperDb = db;
}

/**
 * Run `work` inside a single atomic database transaction.
 *
 * better-sqlite3 is synchronous, which is precisely why it was chosen: there is
 * no `await` inside a transaction, so no other operation can interleave and no
 * half-applied sale can exist. Throwing anywhere inside rolls back everything.
 */
export function transaction<T>(work: (tx: Db) => T): T {
  return writeTransaction(db, work);
}
