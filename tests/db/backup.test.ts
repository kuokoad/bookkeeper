import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBackup } from '@/db/backup';
import { createTestDatabase, accountIdFor, type TestDatabase } from '../helpers/test-db';
import { postJournalEntry } from '@/services/journal.service';
import { credit, debit } from '@/domain/accounting/journal';
import { minor } from '@/domain/money';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';

let context: TestDatabase;
let backupDir: string;

beforeEach(() => {
  context = createTestDatabase();
  backupDir = mkdtempSync(join(tmpdir(), 'bookkeeper-backups-'));
});

afterEach(() => {
  context.cleanup();
  rmSync(backupDir, { recursive: true, force: true });
});

/** Put a real, balanced transaction in the books so a backup has something to prove. */
function postSomething(): void {
  // 1001 is the postable Cash-on-hand leaf; 1000 is its heading.
  const cash = accountIdFor(context.db, '1001');
  const capital = accountIdFor(context.db, ACCOUNT_CODES.OWNERS_CAPITAL);
  postJournalEntry(
    context.db,
    {
      entryDate: '2026-08-17',
      memo: 'Owner puts money in',
      // The one source type allowed to exist without a row in a source table,
      // which keeps this fixture from needing an unrelated document.
      sourceType: 'OPENING_BALANCE',
      isOpening: true,
      lines: [debit(cash, minor(50000)), credit(capital, minor(50000))],
    },
    // No actor: this fixture cares about the ledger contents, and a fresh test
    // database has no users to attribute the entry to.
    null,
  );
}

describe('taking a backup', () => {
  it('produces a file that opens, and reports what is in it', async () => {
    postSomething();

    const result = await createBackup({
      source: context.connection.name,
      directory: backupDir,
    });

    expect(existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.entries).toBeGreaterThan(0);
    expect(result.removed).toEqual([]);
  });

  it('captures transactions committed moments earlier', async () => {
    // The point of the online backup API: with WAL, the newest rows are not in
    // the main database file yet. A plain file copy can silently miss them.
    postSomething();

    const result = await createBackup({
      source: context.connection.name,
      directory: backupDir,
    });

    const copy = new Database(result.path, { readonly: true });
    try {
      const row = copy
        .prepare('SELECT memo FROM journal_entries ORDER BY id DESC LIMIT 1')
        .get() as { memo: string } | undefined;
      expect(row?.memo).toBe('Owner puts money in');
    } finally {
      copy.close();
    }
  });

  it('backs up while the shop is still writing', async () => {
    postSomething();
    const backup = createBackup({ source: context.connection.name, directory: backupDir });
    // A sale posted during the copy must not fail or corrupt anything.
    postSomething();
    const result = await backup;

    expect(existsSync(result.path)).toBe(true);
    const copy = new Database(result.path, { readonly: true });
    try {
      const { count } = copy.prepare('SELECT COUNT(*) AS count FROM journal_entries').get() as {
        count: number;
      };
      // Either one or two entries is correct depending on timing; what must
      // hold is that the file is consistent and readable.
      expect(count).toBeGreaterThanOrEqual(1);
    } finally {
      copy.close();
    }
  });

  it('leaves ONE self-contained file, with no -wal or -shm companions', async () => {
    // A backup that needs three files travelling together is one a person will
    // copy incompletely. Verifying the copy must not put the file back into WAL
    // mode and undo that.
    postSomething();
    await createBackup({ source: context.connection.name, directory: backupDir });

    const stray = readdirSync(backupDir).filter(
      (name) => name.endsWith('-wal') || name.endsWith('-shm'),
    );
    expect(stray).toEqual([]);
    expect(readdirSync(backupDir)).toHaveLength(1);
  });

  it('refuses when there is no database to back up', async () => {
    await expect(
      createBackup({ source: join(backupDir, 'nothing-here.db'), directory: backupDir }),
    ).rejects.toThrow(/no database/i);
  });

  it('refuses to keep zero backups', async () => {
    await expect(
      createBackup({ source: context.connection.name, directory: backupDir, keep: 0 }),
    ).rejects.toThrow(/at least 1/i);
  });
});

describe('verifying before trusting', () => {
  it('rejects and DELETES a backup whose books do not balance', async () => {
    postSomething();

    // Break the copy at the source: a journal line whose credit does not match
    // its debit. This is what silent corruption would look like.
    context.connection.prepare('UPDATE journal_lines SET credit_minor = credit_minor + 1 WHERE credit_minor > 0').run();

    await expect(
      createBackup({ source: context.connection.name, directory: backupDir }),
    ).rejects.toThrow(/do not balance/i);

    // The unusable file must not be left behind looking like a safety net.
    expect(readdirSync(backupDir).filter((name) => name.endsWith('.db'))).toEqual([]);
  });

  it('rejects a file that is not a database at all', async () => {
    const notADatabase = join(backupDir, 'source.db');
    writeFileSync(notADatabase, 'this is not a database');

    await expect(createBackup({ source: notADatabase, directory: backupDir })).rejects.toThrow();
  });
});

describe('retention', () => {
  it('keeps the newest and removes the rest', async () => {
    postSomething();

    // Pre-existing older backups, named the way the script names them.
    for (const name of [
      'bookkeeper-2026-08-01T09-00-00.db',
      'bookkeeper-2026-08-02T09-00-00.db',
      'bookkeeper-2026-08-03T09-00-00.db',
    ]) {
      writeFileSync(join(backupDir, name), 'older backup');
    }

    const result = await createBackup({
      source: context.connection.name,
      directory: backupDir,
      keep: 2,
    });

    const remaining = readdirSync(backupDir).sort();
    expect(remaining).toHaveLength(2);
    // The one just taken must survive, and the oldest must be the one dropped.
    expect(remaining).toContain(result.path.split(/[\\/]/).pop());
    expect(remaining).not.toContain('bookkeeper-2026-08-01T09-00-00.db');
    expect(result.removed).toHaveLength(2);
  });

  it('leaves unrelated files in the folder alone', async () => {
    postSomething();
    writeFileSync(join(backupDir, 'notes.txt'), 'do not delete me');

    await createBackup({ source: context.connection.name, directory: backupDir, keep: 1 });

    expect(existsSync(join(backupDir, 'notes.txt'))).toBe(true);
  });

  it('never trims below the newest backup, even asking to keep one', async () => {
    postSomething();
    const first = await createBackup({
      source: context.connection.name,
      directory: backupDir,
      keep: 1,
    });
    expect(existsSync(first.path)).toBe(true);
  });
});
