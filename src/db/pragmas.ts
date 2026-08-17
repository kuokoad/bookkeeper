import type Database from 'better-sqlite3';

/**
 * The pragmas that make SQLite safe for financial data.
 *
 * This module deliberately carries NO `server-only` marker: migrations, seeds
 * and tests run as plain Node scripts and must open connections with exactly
 * the same settings as the running app. A test that ran without foreign key
 * enforcement would give false confidence.
 */
export function configureConnection(connection: Database.Database): void {
  // SQLite ships with foreign key enforcement OFF. For a relational financial
  // schema that is unacceptable — it would permit orphaned journal lines.
  connection.pragma('foreign_keys = ON');

  // WAL: readers never block the writer, so a report can run while a sale posts.
  connection.pragma('journal_mode = WAL');

  // FULL fsync on every commit. Slower, and deliberately so: shops lose mains
  // power without warning, and NORMAL can drop recently committed transactions
  // on an OS-level crash. A lost sale is worse than a slow one.
  connection.pragma('synchronous = FULL');

  // Wait rather than fail immediately if another connection holds the write lock.
  connection.pragma('busy_timeout = 5000');

  connection.pragma('trusted_schema = OFF');
}

/** Throws if the database has dangling references or internal corruption. */
export function assertDatabaseHealthy(connection: Database.Database): void {
  const violations = connection.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `Database has ${violations.length} foreign key violation(s): ${JSON.stringify(violations)}`,
    );
  }

  const integrity = connection.pragma('integrity_check') as { integrity_check: string }[];
  if (integrity[0]?.integrity_check !== 'ok') {
    throw new Error(`Database integrity check failed: ${JSON.stringify(integrity)}`);
  }
}
