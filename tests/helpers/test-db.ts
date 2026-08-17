import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from '@/db/schema';
import { configureConnection } from '@/db/pragmas';
import type { Db } from '@/db/types';
import { seedCore } from '@/db/seed/core';

/**
 * A throwaway database for integration tests.
 *
 * Uses a real file with the REAL migrations and the REAL pragmas, not an
 * approximation. A test that ran against a hand-built schema, or with foreign
 * keys disabled, would prove nothing about production behaviour.
 */

export interface TestDatabase {
  db: Db;
  connection: Database.Database;
  cleanup: () => void;
}

export function createTestDatabase(options: { seed?: boolean } = {}): TestDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'bookkeeper-test-'));
  const file = join(directory, 'test.db');

  const connection = new Database(file);
  configureConnection(connection);

  const db = drizzle(connection, { schema }) as Db;

  // Mirror production exactly: foreign keys off for the rebuild-style
  // migrations, then back on and verified. See src/db/migrate.ts.
  connection.pragma('foreign_keys = OFF');
  try {
    migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });
  } finally {
    connection.pragma('foreign_keys = ON');
  }
  assertHealthy(connection);

  if (options.seed !== false) {
    db.transaction((tx) => seedCore(tx));
  }

  return {
    db,
    connection,
    cleanup: () => {
      connection.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Assert the database has no dangling references or corruption. */
export function assertHealthy(connection: Database.Database): void {
  const violations = connection.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(`Foreign key violations: ${JSON.stringify(violations)}`);
  }
}

export function accountIdFor(db: Db, code: string): number {
  const row = db.select().from(schema.accounts).all().find((account) => account.code === code);
  if (!row) throw new Error(`Test setup error: no account with code ${code}`);
  return row.id;
}
