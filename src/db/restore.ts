/**
 * Puts a backup back, safely.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AS CODE RATHER THAN AN INSTRUCTION.
 *
 * The instruction used to be "stop the app and copy a backup file over
 * `data/bookkeeper.db`". That is wrong in the one situation restoring is for.
 *
 * With WAL enabled the newest transactions live in `bookkeeper.db-wal`. A clean
 * shutdown folds them into the main file and removes it, so copying over the
 * main file alone is fine. A POWER CUT does not: the `-wal` survives, which is
 * the whole point of `synchronous = FULL`. Copy a backup over the main file
 * then, and SQLite finds a `-wal` beside it and replays it — putting the
 * transactions the backup predates back on top of the file that was supposed to
 * be free of them.
 *
 * The restore silently does not restore. Worse, nothing notices: those
 * transactions are internally balanced, so the books still balance, `preflight`
 * still passes, and the shop believes it rolled back when it did not.
 *
 * So restoring is: verify the backup FIRST, refuse if the database is in use,
 * keep a copy of what is being replaced, remove `-wal` and `-shm`, copy, and
 * verify the result.
 * ---------------------------------------------------------------------------
 *
 * Usage: npm run db:restore -- ./backups/bookkeeper-2026-08-26T18-00-00.db
 */
import { copyFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

import { verifyBackup } from '@/db/backup';
import { isDirectRun } from '@/db/_cli';
import { env, isProduction } from '@/lib/env';

const FORCE_FLAG = '--force';

export interface RestoreResult {
  from: string;
  to: string;
  entries: number;
  bytes: number;
  /** Where the database that was replaced was put, so a mistake is undoable. */
  replacedCopy: string | null;
}

/** `2026-08-26T18-00-00` — sorts chronologically as plain text. */
function stamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

/**
 * Whether something else has the database open.
 *
 * Two questions, because neither alone is enough. `BEGIN EXCLUSIVE` catches a
 * process actively using it and works everywhere. Renaming the file catches a
 * process merely holding it open — which on Windows fails with EBUSY/EPERM, and
 * is the same signal `reset.ts` relies on. An idle connection on Unix will
 * evade both, which is why the command says plainly that the app must be
 * stopped rather than pretending it can always tell.
 */
function inUse(path: string): boolean {
  try {
    // `timeout: 200` deliberately. better-sqlite3 waits five seconds for a busy
    // database by default, and this is a question, not an attempt to win the
    // lock — a person restoring after a crash should be told at once that the
    // app is still running, not left watching a cursor.
    const connection = new Database(path, { timeout: 200 });
    try {
      connection.exec('BEGIN EXCLUSIVE');
      connection.exec('ROLLBACK');
    } finally {
      connection.close();
    }
  } catch {
    return true;
  }

  const probe = `${path}.inuse-probe`;
  try {
    renameSync(path, probe);
    renameSync(probe, path);
    return false;
  } catch {
    // Put it back if the first half succeeded and the second did not.
    try {
      if (existsSync(probe) && !existsSync(path)) renameSync(probe, path);
    } catch {
      // Nothing more can be done here; the caller is about to refuse anyway.
    }
    return true;
  }
}

/**
 * Put the restored file back into WAL mode.
 *
 * The inverse of `makeSelfContained` in `backup.ts`. A backup is deliberately
 * taken OUT of WAL so it is one file a person can carry on a USB stick — which
 * means copying it into place would otherwise leave the shop's live database in
 * `DELETE` mode, quietly losing the property the whole application is built on:
 * that a report can run while a sale posts, and that a power cut does not take
 * the last transactions with it.
 *
 * It also breaks anything that opens the database READ-ONLY and then calls
 * `configureConnection` — `preflight` does exactly that, and setting WAL on a
 * read-only handle is a write. Found by running `npm run preflight` against a
 * freshly restored database and watching it fail with SQLITE_READONLY.
 */
function restoreJournalMode(path: string): void {
  const connection = new Database(path);
  try {
    connection.pragma('journal_mode = WAL');
  } finally {
    connection.close();
  }
}

/** Remove the write-ahead log companions. THE POINT OF THIS WHOLE FILE. */
function removeCompanions(path: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${path}${suffix}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
}

export function restoreBackup(
  backupPath: string,
  options: { target?: string; keepReplaced?: boolean } = {},
): RestoreResult {
  if (isProduction && process.env['ALLOW_PRODUCTION_RESTORE'] !== 'true') {
    throw new Error(
      'Refusing to restore with NODE_ENV=production unless ALLOW_PRODUCTION_RESTORE=true. ' +
        'Restoring replaces every record in the shop.',
    );
  }

  const from = resolve(process.cwd(), backupPath);
  const to = resolve(process.cwd(), options.target ?? env.DATABASE_PATH);

  if (!existsSync(from)) {
    throw new Error(`There is no backup at ${from}.`);
  }
  if (from === to) {
    throw new Error('The backup and the database are the same file.');
  }

  /**
   * Verified BEFORE anything is touched.
   *
   * The order matters more than it looks: checking afterwards would mean a
   * corrupt backup had already replaced a working database, turning one bad
   * file into no good ones.
   */
  let entries: number;
  try {
    entries = verifyBackup(from);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`That backup cannot be used, so nothing was changed: ${reason}`);
  }

  if (existsSync(to) && inUse(to)) {
    throw new Error(
      `The database at ${to} is in use. Stop the app (and any db:studio session) and run this again.`,
    );
  }

  // Keep what is being replaced. Restoring is destructive and is done in a
  // hurry; a person who restores the wrong file should not lose the shop.
  let replacedCopy: string | null = null;
  if (existsSync(to)) {
    if (options.keepReplaced !== false) {
      replacedCopy = `${to}.replaced-${stamp(new Date())}`;
      copyFileSync(to, replacedCopy);
    }
    unlinkSync(to);
  }

  // Before the copy, not after: a `-wal` left beside the new file would be
  // replayed into it on the next open. This is the bug this file exists for.
  removeCompanions(to);

  copyFileSync(from, to);
  restoreJournalMode(to);

  try {
    verifyBackup(to);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The restored database did not verify: ${reason}. ` +
        (replacedCopy === null
          ? 'Nothing was kept to put back.'
          : `The database that was replaced is still at ${replacedCopy}.`),
    );
  }

  return { from, to, entries, bytes: statSync(to).size, replacedCopy };
}

function main(): void {
  const args = process.argv.slice(2).filter((arg) => arg !== FORCE_FLAG);
  const backupPath = args[0];

  if (backupPath === undefined) {
    console.error('Which backup? Usage: npm run db:restore -- ./backups/bookkeeper-....db');
    process.exitCode = 1;
    return;
  }

  if (!process.argv.includes(FORCE_FLAG)) {
    const target = resolve(process.cwd(), env.DATABASE_PATH);
    console.warn('This replaces every record in the shop with the contents of that backup.');
    console.warn(`  from: ${resolve(process.cwd(), backupPath)}`);
    console.warn(`  to:   ${target}`);
    console.warn('');
    console.warn('The database being replaced is copied aside first, so this is undoable.');
    console.warn('Re-run with --force if that is what you want:');
    console.warn(`  npm run db:restore -- ${backupPath} --force`);
    process.exitCode = 1;
    return;
  }

  const result = restoreBackup(backupPath);
  console.log(`Restored ${result.to}`);
  console.log(`  from ${result.from}`);
  console.log(`  ${result.entries} journal entries, ${result.bytes} bytes, books balanced`);
  if (result.replacedCopy !== null) {
    console.log(`  the database it replaced is at ${result.replacedCopy}`);
  }
}

if (isDirectRun(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error('Restore failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
