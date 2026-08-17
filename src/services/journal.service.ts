import { eq } from 'drizzle-orm';

import type { Tx } from '@/db/types';
import { accounts, businessSettings, journalEntries, journalLines } from '@/db/schema';
import type { JournalSourceType } from '@/db/schema/accounting';
import { assertPeriodOpen } from '@/domain/accounting/period-lock';
import {
  finaliseLines,
  reverseLines,
  type DraftEntry,
  type DraftLine,
} from '@/domain/accounting/journal';
import { InvariantViolatedError, NotFoundError } from '@/domain/errors';
import { DOC_TYPES, nextDocumentNumber } from './sequence.service';

/**
 * The ONLY way a journal entry enters the database.
 *
 * Centralising it means the balance assertion cannot be forgotten by a future
 * module: every posting path runs `finaliseLines`, which throws unless debits
 * equal credits. Because this runs inside the caller's transaction, a failed
 * assertion rolls back the entire business operation — the sale, the stock
 * movement and the payment all disappear together.
 */

export interface PostEntryInput extends DraftEntry {
  occurredAt?: Date;
  isDemo?: boolean;
  /**
   * Bypass the books lock. Set ONLY by an owner-level action that has already
   * checked the permission and will record the override in the audit log.
   */
  overridePeriodLock?: boolean;
}

/** The shop's books-lock date, or null when nothing is locked. */
export function readLockDate(tx: Tx): string | null {
  const settings = tx
    .select({ lockedBefore: businessSettings.booksLockedBefore })
    .from(businessSettings)
    .where(eq(businessSettings.id, 1))
    .get();
  return settings?.lockedBefore ?? null;
}

export interface PostedEntry {
  entryId: number;
  entryNo: string;
}

export interface Actor {
  id: number;
  username: string;
}

export function postJournalEntry(
  tx: Tx,
  input: PostEntryInput,
  actor: Actor | null = null,
): PostedEntry {
  // Every financial transaction in the application posts through here, which
  // makes this the one place the books lock cannot be bypassed.
  assertPeriodOpen(input.entryDate, readLockDate(tx), {
    ...(input.overridePeriodLock === true ? { allowOverride: true } : {}),
  });

  // Throws UnbalancedEntryError unless debits === credits.
  const lines = finaliseLines(input.lines);

  assertAccountsPostable(tx, lines);

  const entryNo = nextDocumentNumber(tx, DOC_TYPES.JOURNAL);
  const occurredAt = input.occurredAt ?? new Date();

  const entry = tx
    .insert(journalEntries)
    .values({
      entryNo,
      entryDate: input.entryDate,
      occurredAt,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      memo: input.memo ?? null,
      isOpening: input.isOpening ?? false,
      createdBy: actor?.id ?? null,
      isDemo: input.isDemo ?? false,
      createdAt: occurredAt,
    })
    .returning({ id: journalEntries.id })
    .get();

  if (!entry) {
    throw new InvariantViolatedError('Journal entry could not be created.');
  }

  lines.forEach((line, index) => {
    tx.insert(journalLines)
      .values({
        entryId: entry.id,
        lineNo: index + 1,
        accountId: line.accountId,
        debitMinor: line.debit,
        creditMinor: line.credit,
        paymentAccountId: line.paymentAccountId ?? null,
        customerId: line.customerId ?? null,
        supplierId: line.supplierId ?? null,
        description: line.description ?? null,
        createdAt: occurredAt,
      })
      .run();
  });

  return { entryId: entry.id, entryNo };
}

/**
 * A heading account groups its children and must never be posted to directly,
 * or its balance would double-count against the children beneath it.
 */
function assertAccountsPostable(tx: Tx, lines: readonly DraftLine[]): void {
  const seen = new Set<number>();

  for (const line of lines) {
    if (seen.has(line.accountId)) continue;
    seen.add(line.accountId);

    const account = tx
      .select({ id: accounts.id, name: accounts.name, isActive: accounts.isActive })
      .from(accounts)
      .where(eq(accounts.id, line.accountId))
      .get();

    if (!account) throw new NotFoundError('Account', line.accountId);

    const childCount = tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.parentId, line.accountId))
      .all().length;

    if (childCount > 0) {
      throw new InvariantViolatedError(
        `Account "${account.name}" is a heading and cannot be posted to directly.`,
        { accountId: line.accountId },
      );
    }
  }
}

/**
 * Reverse a posted entry by writing its mirror image.
 *
 * The original rows are never edited or deleted: the history of what happened,
 * and of the correction, both survive. The two entries are linked in both
 * directions so either can be found from the other.
 */
export function reverseJournalEntry(
  tx: Tx,
  entryId: number,
  options: {
    entryDate: string;
    memo?: string;
    sourceType?: JournalSourceType;
    sourceId?: number;
    occurredAt?: Date;
  },
  actor: Actor | null = null,
): PostedEntry {
  const original = tx.select().from(journalEntries).where(eq(journalEntries.id, entryId)).get();
  if (!original) throw new NotFoundError('Journal entry', entryId);

  if (original.reversedByEntryId !== null) {
    throw new InvariantViolatedError('That entry has already been reversed.', { entryId });
  }

  const originalLines = tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, entryId))
    .all();

  if (originalLines.length === 0) {
    throw new InvariantViolatedError('That entry has no lines to reverse.', { entryId });
  }

  const mirrored = reverseLines(
    originalLines.map((line) => ({
      accountId: line.accountId,
      debit: line.debitMinor as never,
      credit: line.creditMinor as never,
      ...(line.paymentAccountId !== null ? { paymentAccountId: line.paymentAccountId } : {}),
      ...(line.customerId !== null ? { customerId: line.customerId } : {}),
      ...(line.supplierId !== null ? { supplierId: line.supplierId } : {}),
      ...(line.description !== null ? { description: line.description } : {}),
    })),
  );

  const reversal = postJournalEntry(
    tx,
    {
      entryDate: options.entryDate,
      sourceType: options.sourceType ?? 'REVERSAL',
      ...(options.sourceId !== undefined ? { sourceId: options.sourceId } : {}),
      memo: options.memo ?? `Reversal of ${original.entryNo}`,
      lines: mirrored,
      ...(options.occurredAt !== undefined ? { occurredAt: options.occurredAt } : {}),
      isDemo: original.isDemo,
    },
    actor,
  );

  tx.update(journalEntries)
    .set({ reversesEntryId: entryId })
    .where(eq(journalEntries.id, reversal.entryId))
    .run();

  tx.update(journalEntries)
    .set({ reversedByEntryId: reversal.entryId })
    .where(eq(journalEntries.id, entryId))
    .run();

  return reversal;
}
