import { and, desc, eq, gt, sql } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { auditLogs, journalEntries } from '@/db/schema';

/**
 * How long ago the shop last took a backup, and whether that is a problem yet.
 *
 * The database file IS the business records. On a plan with no scheduled tasks
 * nothing takes a backup on the shop's behalf, so the only thing standing
 * between a failed disk and the whole history is somebody remembering — and a
 * habit nobody can see is a habit nobody can check.
 *
 * Two rules, and the shop is told if EITHER fires. A week without a backup is
 * worth mentioning whatever has happened — that rule was here first and is kept.
 * On top of it, a single day is enough once there is trading nobody has saved,
 * because the guidance is to back up at the end of each trading day and a busy
 * shop can lose a great deal in six days of silence.
 *
 * The count of unsaved entries is what turns "it has been a while" into
 * something a person can weigh: it is, in plain terms, what a failed disk costs.
 *
 * There is no backup table. Each download writes an audit row, which is already
 * the shop's record of who did what — see `src/app/api/backup/route.ts`.
 */

export type BackupState =
  /** No backup has ever been taken. */
  | 'never'
  /** Recent enough, with nothing unsaved behind it. */
  | 'current'
  /** A day has passed AND there is trading nobody has saved. */
  | 'due'
  /** A week without a backup, whatever has happened since. */
  | 'overdue';

export interface BackupStatus {
  lastTakenAt: Date | null;
  /** Whole days since the last backup. Null when there has never been one. */
  daysSince: number | null;
  /** Journal entries posted since — in plain terms, what a lost disk costs. */
  entriesSince: number;
  state: BackupState;
}

/** With unsaved trading behind it, one day is enough to mention. */
const DUE_AFTER_DAYS = 1;
/** Without any, a week is still worth mentioning. */
const OVERDUE_AFTER_DAYS = 7;

const MS_PER_DAY = 86_400_000;

export function getBackupStatus(db: Db, now: Date = new Date()): BackupStatus {
  const last = db
    .select({ at: auditLogs.createdAt })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, 'backup'), eq(auditLogs.action, 'CREATE')))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1)
    .get();

  const lastTakenAt = last?.at ?? null;

  // Everything, when there has never been a backup: all of it is unsaved.
  const entriesSince =
    db
      .select({ n: sql<number>`COUNT(*)` })
      .from(journalEntries)
      .where(lastTakenAt ? gt(journalEntries.createdAt, lastTakenAt) : undefined)
      .get()?.n ?? 0;

  if (lastTakenAt === null) {
    // No backup at all is worth saying even before the first sale: it is a
    // statement about whether the shop is set up, not only about what is at risk.
    return { lastTakenAt: null, daysSince: null, entriesSince, state: 'never' };
  }

  const daysSince = Math.floor((now.getTime() - lastTakenAt.getTime()) / MS_PER_DAY);

  const state: BackupState =
    daysSince >= OVERDUE_AFTER_DAYS
      ? 'overdue'
      : entriesSince > 0 && daysSince >= DUE_AFTER_DAYS
        ? 'due'
        : 'current';

  return { lastTakenAt, daysSince, entriesSince, state };
}

/** One line a person can act on, for the dashboard and the Health screen. */
export function describeBackupStatus(status: BackupStatus): string {
  const entries = `${status.entriesSince} entr${status.entriesSince === 1 ? 'y' : 'ies'}`;

  switch (status.state) {
    case 'never':
      return status.entriesSince === 0
        ? 'No backup has ever been taken. Nothing has been recorded yet, so start the habit now.'
        : `No backup has ever been taken. ${entries} would be lost with this computer.`;
    case 'overdue':
    case 'due': {
      const when =
        status.daysSince === 0
          ? 'earlier today'
          : status.daysSince === 1
            ? 'yesterday'
            : `${status.daysSince} days ago`;
      return status.entriesSince === 0
        ? `Last backup was ${when}, and nothing has been posted since.`
        : `Last backup was ${when}. ${entries} have been posted since.`;
    }
    case 'current':
      return status.lastTakenAt === null
        ? 'Nothing has been posted yet, so there is nothing to back up.'
        : status.daysSince === 0
          ? 'Backed up earlier today. Nothing posted since.'
          : `Backed up ${status.daysSince} day${status.daysSince === 1 ? '' : 's'} ago. Nothing posted since.`;
  }
}
