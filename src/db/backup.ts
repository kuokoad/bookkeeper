/**
 * Takes a verified backup of the database.
 *
 * Copying `bookkeeper.db` with the file explorer is not a backup: with WAL
 * enabled the newest transactions live in the `-wal` file, so a plain copy of
 * the main file alone can be missing the last hour of trading, and a copy taken
 * mid-write can be torn. This uses SQLite's own online backup API, which
 * produces a single consistent file **while the shop keeps trading**.
 *
 * A backup nobody has opened is a guess, so every backup is verified before it
 * counts: structural integrity, foreign keys, and — the one that actually
 * matters — that the books in the copy still balance. An unverifiable backup is
 * deleted and the command fails loudly, because believing in a broken backup is
 * worse than knowing you have none.
 *
 * Usage: npm run backup [-- --keep=30] [--dir=path]
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

import { configureConnection, assertDatabaseHealthy } from '@/db/pragmas';
import { isDirectRun } from '@/db/_cli';
import { env } from '@/lib/env';

const FILE_PREFIX = 'bookkeeper-';
const FILE_SUFFIX = '.db';

/**
 * Folds the write-ahead log into the backup file and takes it out of WAL mode.
 *
 * SQLite's backup copies the source's page header, journal mode included, so a
 * backup of a WAL database is itself a WAL database — and merely opening it
 * spawns `-wal` and `-shm` companions. Switching to `DELETE` checkpoints
 * everything into the single file and removes them, which is what makes the
 * backup something a person can copy to a USB stick on its own and have it be
 * whole.
 */
function makeSelfContained(path: string): void {
  const copy = new Database(path);
  try {
    copy.pragma('journal_mode = DELETE');
  } finally {
    copy.close();
  }
}

export interface BackupResult {
  path: string;
  bytes: number;
  entries: number;
  removed: string[];
}

/** `2026-08-17T14-32-05` — sorts chronologically as plain text. */
function stamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

/**
 * Opens the finished backup and proves it is usable.
 *
 * The balance check is the important one. Structural integrity only says SQLite
 * can read the file; that debits still equal credits says the *accounts* in it
 * survived, which is what the shop actually needs from a backup.
 */
function verifyBackup(path: string): number {
  const copy = new Database(path, { readonly: true });
  try {
    // Deliberately NOT `configureConnection`: that switches the database into
    // WAL mode, which would leave `-wal` and `-shm` companions beside every
    // backup file. A backup must be one self-contained file that can be copied
    // to a USB stick on its own. Only the settings that affect *reading*
    // correctly are applied here.
    copy.pragma('foreign_keys = ON');
    copy.pragma('trusted_schema = OFF');
    assertDatabaseHealthy(copy);

    const totals = copy
      .prepare('SELECT COALESCE(SUM(debit_minor), 0) AS debits, COALESCE(SUM(credit_minor), 0) AS credits FROM journal_lines')
      .get() as { debits: number; credits: number };

    if (totals.debits !== totals.credits) {
      throw new Error(
        `the books in the backup do not balance: debits ${totals.debits} vs credits ${totals.credits}`,
      );
    }

    const entries = copy.prepare('SELECT COUNT(*) AS count FROM journal_entries').get() as {
      count: number;
    };
    return entries.count;
  } finally {
    copy.close();
  }
}

/** Oldest first, so trimming can take from the front. */
function existingBackups(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX))
    .sort();
}

export async function createBackup(
  options: { keep?: number; directory?: string; source?: string } = {},
): Promise<BackupResult> {
  const keep = options.keep ?? 14;
  const directory = resolve(process.cwd(), options.directory ?? './backups');
  const source = resolve(process.cwd(), options.source ?? env.DATABASE_PATH);

  if (!existsSync(source)) {
    throw new Error(`There is no database at ${source} to back up.`);
  }
  if (keep < 1) {
    throw new Error('--keep must be at least 1: a backup command that keeps nothing is a delete command.');
  }

  mkdirSync(directory, { recursive: true });
  const target = join(directory, `${FILE_PREFIX}${stamp(new Date())}${FILE_SUFFIX}`);

  if (existsSync(target)) {
    throw new Error(`A backup already exists at ${target}. Refusing to overwrite it.`);
  }

  const connection = new Database(source, { readonly: true });
  let entries: number;
  try {
    configureConnection(connection);
    // The online backup API. Safe against a running server: it copies pages
    // under SQLite's own locking rather than reading the file behind its back.
    await connection.backup(target);
  } finally {
    connection.close();
  }

  try {
    makeSelfContained(target);
    entries = verifyBackup(target);
  } catch (error) {
    // A file that fails verification must not sit in the backup folder looking
    // like a safety net.
    for (const path of [target, `${target}-wal`, `${target}-shm`]) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // Report the original failure, not the cleanup one.
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Backup verification FAILED and the file was discarded: ${reason}`);
  }

  // Trim only after a verified backup exists, so a failure never leaves the
  // shop with fewer backups than it started with.
  const all = existingBackups(directory);
  const removed: string[] = [];
  for (const name of all.slice(0, Math.max(0, all.length - keep))) {
    unlinkSync(join(directory, name));
    // Tidy away any companions an older version of this script, or a person
    // opening a backup with another tool, may have left beside it. Removing the
    // main file alone would leave orphans that look like backups.
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = join(directory, `${name}${suffix}`);
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
    removed.push(name);
  }

  return { path: target, bytes: statSync(target).size, entries, removed };
}

if (isDirectRun(import.meta.url)) {
  const keepArg = process.argv.find((arg) => arg.startsWith('--keep='));
  const dirArg = process.argv.find((arg) => arg.startsWith('--dir='));

  const keep = keepArg ? Number(keepArg.split('=')[1]) : 14;
  if (!Number.isInteger(keep) || keep < 1) {
    console.error('--keep must be a whole number of backups to retain, at least 1.');
    process.exit(1);
  }

  try {
    const result = await createBackup({
      keep,
      ...(dirArg ? { directory: dirArg.slice('--dir='.length) } : {}),
    });

    const mb = (result.bytes / 1_000_000).toFixed(2);
    console.log(`Backup written and verified: ${result.path}`);
    console.log(`  ${mb} MB · ${result.entries} journal entries · debits equal credits`);
    if (result.removed.length > 0) {
      console.log(`  Removed ${result.removed.length} older backup(s), keeping the newest ${keep}.`);
    }
    console.log('\nCopy this file off the machine — a backup on the same computer does not');
    console.log('survive the computer being stolen, dropped, or having its disk fail.');
  } catch (error) {
    console.error(`\nBACKUP FAILED: ${error instanceof Error ? error.message : String(error)}`);
    console.error('The shop is NOT backed up. Fix this before trusting the data.');
    process.exit(1);
  }
}
