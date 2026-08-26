import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBackup } from '@/db/backup';
import { restoreBackup } from '@/db/restore';
import { createTestDatabase, accountIdFor, type TestDatabase } from '../helpers/test-db';
import { postJournalEntry } from '@/services/journal.service';
import { credit, debit } from '@/domain/accounting/journal';
import { minor } from '@/domain/money';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';

/**
 * Putting a backup back.
 *
 * A backup nobody has ever restored is a hypothesis. This suite exists because
 * the restore path was, for a long time, one line of documentation — "stop the
 * app and copy a backup file over the database" — and that line is wrong in the
 * one situation restoring is for.
 *
 * With WAL enabled the newest transactions live in `bookkeeper.db-wal`. A clean
 * shutdown folds them in and deletes it. A POWER CUT does not: the `-wal`
 * survives, which is exactly what `synchronous = FULL` is chosen to guarantee.
 * Copy a backup over the main file with that `-wal` still beside it, and SQLite
 * replays it into the file that was supposed to be free of it — silently
 * restoring the shop to a state that never existed. The books still balance
 * afterwards, because the resurrected entries are internally balanced, so
 * nothing warns.
 *
 * The last test in this file is that scenario, and it is the reason the rest
 * exist.
 */

let context: TestDatabase;
let workDir: string;

beforeEach(() => {
  context = createTestDatabase();
  workDir = mkdtempSync(join(tmpdir(), 'bookkeeper-restore-'));
});

afterEach(() => {
  context.cleanup();
  rmSync(workDir, { recursive: true, force: true });
});

/** A real, balanced entry, so a backup has something to prove. */
function post(memo: string, amount: number): void {
  const cash = accountIdFor(context.db, '1001');
  const capital = accountIdFor(context.db, ACCOUNT_CODES.OWNERS_CAPITAL);
  postJournalEntry(
    context.db,
    {
      entryDate: '2026-08-17',
      memo,
      sourceType: 'OPENING_BALANCE',
      isOpening: true,
      lines: [debit(cash, minor(amount)), credit(capital, minor(amount))],
    },
    null,
  );
}

const livePath = () => (context.connection as unknown as { name: string }).name;

const entryCount = (path: string): number => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n;
  } finally {
    db.close();
  }
};

const memos = (path: string): string[] => {
  const db = new Database(path, { readonly: true });
  try {
    return (db.prepare('SELECT memo FROM journal_entries ORDER BY id').all() as { memo: string }[])
      .map((row) => row.memo)
      .filter((memo) => memo.startsWith('E'));
  } finally {
    db.close();
  }
};

describe('restoring a backup', () => {
  it('puts the books back as they were', async () => {
    post('E1', 10_000);
    const backup = await createBackup({ directory: workDir, source: livePath() });

    post('E2', 20_000);
    expect(entryCount(livePath())).toBe(2);

    context.connection.close();
    const result = restoreBackup(backup.path, { target: livePath() });

    expect(result.entries).toBe(1);
    expect(memos(livePath())).toEqual(['E1']);
  });

  it('keeps the database it replaced, so a wrong restore is undoable', async () => {
    post('E1', 10_000);
    const backup = await createBackup({ directory: workDir, source: livePath() });
    post('E2', 20_000);

    context.connection.close();
    const result = restoreBackup(backup.path, { target: livePath() });

    expect(result.replacedCopy).not.toBeNull();
    expect(existsSync(result.replacedCopy!)).toBe(true);
    // The copy still holds what was there before the restore.
    expect(memos(result.replacedCopy!)).toEqual(['E1', 'E2']);
  });

  it('refuses a backup that is not a usable database, changing nothing', async () => {
    post('E1', 10_000);
    const rubbish = join(workDir, 'not-a-database.db');
    writeFileSync(rubbish, 'this is not a database');

    context.connection.close();
    expect(() => restoreBackup(rubbish, { target: livePath() })).toThrow(/cannot be used/i);

    // The live database is untouched — a bad backup must not cost a good one.
    expect(memos(livePath())).toEqual(['E1']);
  });

  it('refuses a backup whose books do not balance', async () => {
    post('E1', 10_000);
    const backup = await createBackup({ directory: workDir, source: livePath() });

    // Break the copy the way a damaged file would be broken: still readable,
    // still structurally valid, but the accounts no longer agree.
    const broken = new Database(backup.path);
    broken.prepare('UPDATE journal_lines SET debit_minor = debit_minor + 1 WHERE debit_minor > 0').run();
    broken.close();

    context.connection.close();
    expect(() => restoreBackup(backup.path, { target: livePath() })).toThrow(/do not balance/i);
    expect(memos(livePath())).toEqual(['E1']);
  });

  it('refuses when the database is still in use', async () => {
    post('E1', 10_000);
    const backup = await createBackup({ directory: workDir, source: livePath() });

    // The connection is deliberately left open: the app is still running.
    const held = new Database(livePath());
    held.exec('BEGIN EXCLUSIVE');
    try {
      expect(() => restoreBackup(backup.path, { target: livePath() })).toThrow(/in use/i);
    } finally {
      held.exec('ROLLBACK');
      held.close();
    }
  });

  it('refuses to restore a file over itself', async () => {
    post('E1', 10_000);
    const backup = await createBackup({ directory: workDir, source: livePath() });
    expect(() => restoreBackup(backup.path, { target: backup.path })).toThrow(/same file/i);
  });

  it('leaves the database in WAL mode, not the backup format', async () => {
    /**
     * A backup is deliberately taken OUT of WAL so it is a single file somebody
     * can carry on a USB stick. Copy it into place unchanged and the shop's
     * live database is left in `DELETE` mode — losing the property the whole
     * application rests on, that a report can run while a sale posts, and that
     * a power cut does not take the last transactions with it.
     *
     * This was a real defect in the first version of `restore.ts`, and it did
     * not show up in any test: it surfaced as `npm run preflight` failing with
     * SQLITE_READONLY, because preflight opens the database read-only and
     * setting WAL on a read-only handle is a write.
     */
    post('E1', 10_000);
    const backup = await createBackup({ directory: workDir, source: livePath() });
    context.connection.close();

    restoreBackup(backup.path, { target: livePath() });

    const db = new Database(livePath(), { readonly: true });
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      db.close();
    }
  });

  it('REMOVES THE WRITE-AHEAD LOG, so a crash cannot resurrect what was undone', async () => {
    /**
     * The bug this whole file is for.
     *
     * Restoring almost always follows a crash, and a crash is precisely when
     * the `-wal` survives. Copying a backup over the main file then leaves
     * SQLite a log full of transactions the backup predates, which it replays
     * on the next open — putting them straight back.
     */
    post('E1', 10_000);
    const backup = await createBackup({ directory: workDir, source: livePath() });

    // Trade on. These land in the write-ahead log.
    post('E2', 20_000);
    post('E3', 30_000);

    const live = livePath();
    const walBefore = `${live}-wal`;
    expect(existsSync(walBefore), 'the fixture must actually be in WAL mode').toBe(true);

    // Simulate a power cut: keep the -wal and -shm that a clean close would
    // have folded away, and put them back after closing the handle.
    const keptWal = join(workDir, 'kept-wal');
    const keptShm = join(workDir, 'kept-shm');
    copyFileSync(walBefore, keptWal);
    if (existsSync(`${live}-shm`)) copyFileSync(`${live}-shm`, keptShm);
    context.connection.close();
    copyFileSync(keptWal, walBefore);
    if (existsSync(keptShm)) copyFileSync(keptShm, `${live}-shm`);

    restoreBackup(backup.path, { target: live });

    /**
     * The CONTENTS are the proof, not the absence of a file.
     *
     * A restored database is put back into WAL mode, so a `-wal` may exist
     * again straight afterwards — but it is the new database's own, empty. What
     * matters is that the stale one was removed before the copy rather than
     * replayed into it: the entries the backup predates did not come back.
     *
     * Before `restore.ts` existed, following the documented procedure made this
     * read ['E1', 'E2', 'E3'].
     */
    expect(memos(live)).toEqual(['E1']);
    expect(entryCount(live)).toBe(1);
  });
});
