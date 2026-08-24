import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db } from '@/db/types';
import { businessSettings, journalEntries } from '@/db/schema';
import { isLockRelaxation } from '@/domain/accounting/period-lock';
import { ValidationError } from '@/domain/errors';
import { isValidBusinessDate } from '@/lib/format';
import { writeAudit } from './audit.service';
import type { Actor } from './journal.service';

/**
 * Managing the books lock.
 *
 * Moving the lock FORWARD closes a period and is routine. Moving it BACKWARD,
 * or clearing it, reopens a period that was declared final — so it is recorded
 * distinctly in the audit log, because that is the action someone would take to
 * cover a mistake.
 */

export interface LockStatus {
  lockedBefore: string | null;
  /** Entries already recorded inside the locked period. */
  entriesLocked: number;
  /** Entries that would become locked if the proposed date were applied. */
  entriesAffectedByProposal?: number;
}

export function getLockStatus(db: Db, proposedDate?: string): LockStatus {
  const settings = db
    .select({ lockedBefore: businessSettings.booksLockedBefore })
    .from(businessSettings)
    .where(eq(businessSettings.id, 1))
    .get();

  const lockedBefore = settings?.lockedBefore ?? null;

  const countUpTo = (date: string): number => {
    const row = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(journalEntries)
      .where(lte(journalEntries.entryDate, date))
      .get();
    return row?.count ?? 0;
  };

  return {
    lockedBefore,
    entriesLocked: lockedBefore === null ? 0 : countUpTo(lockedBefore),
    ...(proposedDate !== undefined ? { entriesAffectedByProposal: countUpTo(proposedDate) } : {}),
  };
}

export function setBooksLock(
  db: Db,
  lockedBefore: string | null,
  actor: Actor,
  now: Date = new Date(),
): void {
  if (lockedBefore !== null && !isValidBusinessDate(lockedBefore)) {
    throw new ValidationError('Enter a valid lock date.');
  }

  writeTransaction(db, (tx) => {
    const settings = tx
      .select({ lockedBefore: businessSettings.booksLockedBefore })
      .from(businessSettings)
      .where(eq(businessSettings.id, 1))
      .get();

    const current = settings?.lockedBefore ?? null;
    if (current === lockedBefore) return;

    const relaxing = isLockRelaxation(current, lockedBefore);

    tx.update(businessSettings)
      .set({ booksLockedBefore: lockedBefore, updatedAt: now })
      .where(eq(businessSettings.id, 1))
      .run();

    writeAudit(tx, {
      action: 'SETTINGS_CHANGE',
      entityType: 'books_lock',
      entityId: 'books_lock',
      userId: actor.id,
      username: actor.username,
      summary: relaxing
        ? `REOPENED the books: lock moved back from ${current} to ${lockedBefore ?? 'nothing locked'}`
        : lockedBefore === null
          ? 'Removed the books lock'
          : `Closed the books up to ${lockedBefore}`,
      metadata: { before: current, after: lockedBefore, reopened: relaxing },
      at: now,
    });
  });
}

/**
 * How many entries sit after the lock — the open period the owner is still
 * working in. Used to show what a proposed lock would cover.
 */
export function countOpenEntries(db: Db, lockedBefore: string | null): number {
  if (lockedBefore === null) {
    const row = db.select({ count: sql<number>`COUNT(*)` }).from(journalEntries).get();
    return row?.count ?? 0;
  }
  const row = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(journalEntries)
    .where(and(gt(journalEntries.entryDate, lockedBefore)))
    .get();
  return row?.count ?? 0;
}
