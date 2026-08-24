import type { Db, Tx } from './types';

/**
 * Open a transaction that is going to WRITE.
 *
 * ---------------------------------------------------------------------------
 * `BEGIN IMMEDIATE`, never SQLite's default `BEGIN DEFERRED`.
 * ---------------------------------------------------------------------------
 *
 * A deferred transaction takes no lock when it opens. It takes a READ snapshot
 * at its first query and only asks for the write lock later, at its first
 * write — and in WAL mode, if another connection has committed in between, that
 * upgrade cannot be granted. SQLite reports SQLITE_BUSY_SNAPSHOT, and
 * `busy_timeout` does not help: waiting cannot fix a snapshot that has already
 * been overtaken, so the transaction is refused however long it waits.
 *
 * `BEGIN IMMEDIATE` asks for the write lock up front instead. Contention then
 * becomes waiting rather than failing, which `busy_timeout` handles, and a sale
 * that would have been rejected at the till simply takes a moment longer.
 *
 * None of this can happen while the application runs as a single process:
 * better-sqlite3 is synchronous, so no two transactions can be open at once and
 * the read-modify-write on a product's stock cannot be split. That guarantee
 * belongs to the DEPLOYMENT, not to this code, and it disappears quietly the
 * first time anyone runs the app under a process manager that forks workers, or
 * opens a second connection to take a backup while the shop is trading. The
 * cost of not depending on it is one word.
 *
 * This module deliberately carries NO `server-only` marker, for the same reason
 * `pragmas.ts` does not: migrations, seeds and tests are plain Node processes
 * and must open transactions exactly the way the running application does.
 */
export function writeTransaction<T>(db: Db, work: (tx: Tx) => T): T {
  return db.transaction(work, { behavior: 'immediate' });
}
