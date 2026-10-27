import { desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { writeTransaction } from '@/db/transaction';

import type { Db, Tx } from '@/db/types';
import { accountTransfers, paymentAccounts, users } from '@/db/schema';
import { credit, debit } from '@/domain/accounting/journal';
import { minor, type Minor } from '@/domain/money';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { toBusinessDate } from '@/lib/format';
import { writeAudit } from './audit.service';
import { postJournalEntry, reverseJournalEntry, type Actor } from './journal.service';
import { DOC_TYPES, nextDocumentNumber } from './sequence.service';

/**
 * Moving money between the shop's own accounts — banking the day's cash,
 * drawing MoMo into the till.
 *
 *   Dr To-account (Bank)   Cr From-account (Cash)
 *
 * Both lines sit on payment accounts, so the shop's total money held is the
 * same afterwards and nothing reaches the Profit & Loss or the owner's equity.
 * The date is the day the money moved: the books lock applies to it like any
 * other posting, through `postJournalEntry`.
 */

export interface TransferInput {
  businessDate: string;
  fromAccountId: number;
  toAccountId: number;
  amount: Minor;
  reference?: string | undefined;
  note?: string | undefined;
  occurredAt?: Date;
  isDemo?: boolean;
}

export interface TransferResult {
  id: number;
  transferNo: string;
  journalEntryId: number;
}

/** An account money can move into or out of today. Archived ones cannot. */
function usableAccount(tx: Tx, id: number) {
  const account = tx.select().from(paymentAccounts).where(eq(paymentAccounts.id, id)).get();
  if (!account) throw new NotFoundError('Payment account', id);
  if (!account.isActive) {
    throw new ValidationError(`"${account.name}" is archived. Choose an account still in use.`);
  }
  return account;
}

export function recordTransfer(db: Db, input: TransferInput, actor: Actor): TransferResult {
  if (input.amount <= 0) {
    throw new ValidationError('Enter an amount greater than zero.');
  }
  if (input.fromAccountId === input.toAccountId) {
    throw new ValidationError('Choose two different accounts to move money between.');
  }

  return writeTransaction(db, (tx) => {
    const occurredAt = input.occurredAt ?? new Date();
    const from = usableAccount(tx, input.fromAccountId);
    const to = usableAccount(tx, input.toAccountId);

    const transferNo = nextDocumentNumber(tx, DOC_TYPES.TRANSFER);
    const reference = input.reference?.trim() || null;
    const note = input.note?.trim() || null;

    const inserted = tx
      .insert(accountTransfers)
      .values({
        transferNo,
        businessDate: input.businessDate,
        occurredAt,
        fromAccountId: from.id,
        toAccountId: to.id,
        amountMinor: input.amount,
        reference,
        note,
        status: 'POSTED',
        createdBy: actor.id,
        isDemo: input.isDemo ?? false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .returning({ id: accountTransfers.id })
      .get();

    if (!inserted) throw new ConflictError('Could not save the transfer.');

    const description = `${transferNo} ${from.name} to ${to.name}`;
    const posted = postJournalEntry(
      tx,
      {
        entryDate: input.businessDate,
        sourceType: 'TRANSFER',
        sourceId: inserted.id,
        memo: reference ? `${description} — ${reference}` : description,
        lines: [
          debit(to.glAccountId, input.amount, {
            paymentAccountId: to.id,
            description: `${transferNo} from ${from.name}`,
          }),
          credit(from.glAccountId, input.amount, {
            paymentAccountId: from.id,
            description: `${transferNo} to ${to.name}`,
          }),
        ],
        occurredAt,
        isDemo: input.isDemo ?? false,
      },
      actor,
    );

    tx.update(accountTransfers)
      .set({ journalEntryId: posted.entryId, updatedAt: occurredAt })
      .where(eq(accountTransfers.id, inserted.id))
      .run();

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'account_transfer',
      entityId: inserted.id,
      userId: actor.id,
      username: actor.username,
      summary: `${transferNo}: ${from.name} to ${to.name}`,
      metadata: { amountMinor: input.amount, entryNo: posted.entryNo },
      at: occurredAt,
    });

    return { id: inserted.id, transferNo, journalEntryId: posted.entryId };
  });
}

/**
 * Undo a transfer by posting a reversing entry dated today. The original row
 * and entry are kept, so both the mistake and its correction stay visible, and
 * a transfer inside a closed period is corrected without reopening it.
 */
export function voidTransfer(
  db: Db,
  id: number,
  reason: string,
  actor: Actor,
  now: Date = new Date(),
): void {
  if (reason.trim().length < 3) {
    throw new ValidationError('Give a reason for voiding this transfer.');
  }

  writeTransaction(db, (tx) => {
    const row = tx.select().from(accountTransfers).where(eq(accountTransfers.id, id)).get();
    if (!row) throw new NotFoundError('Transfer', id);
    if (row.status === 'VOIDED') throw new ConflictError('That transfer has already been voided.');

    if (row.journalEntryId !== null) {
      reverseJournalEntry(
        tx,
        row.journalEntryId,
        {
          entryDate: toBusinessDate(now),
          sourceType: 'TRANSFER',
          sourceId: id,
          memo: `Void of ${row.transferNo}: ${reason.trim()}`,
          occurredAt: now,
        },
        actor,
      );
    }

    tx.update(accountTransfers)
      .set({ status: 'VOIDED', voidedAt: now, voidReason: reason.trim(), updatedAt: now })
      .where(eq(accountTransfers.id, id))
      .run();

    writeAudit(tx, {
      action: 'VOID',
      entityType: 'account_transfer',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `Voided ${row.transferNo}`,
      metadata: { reason: reason.trim() },
      at: now,
    });
  });
}

// --- reads ----------------------------------------------------------------

export interface TransferRow {
  id: number;
  transferNo: string;
  businessDate: string;
  fromAccountId: number;
  fromAccountName: string;
  toAccountId: number;
  toAccountName: string;
  amount: Minor;
  reference: string | null;
  note: string | null;
  status: 'POSTED' | 'VOIDED';
  voidReason: string | null;
  createdByName: string | null;
}

/** Newest first, by the day the money moved. */
export function listTransfers(
  db: Db,
  query: { limit?: number; offset?: number } = {},
): TransferRow[] {
  const fromAccount = alias(paymentAccounts, 'from_account');
  const toAccount = alias(paymentAccounts, 'to_account');

  return db
    .select({
      id: accountTransfers.id,
      transferNo: accountTransfers.transferNo,
      businessDate: accountTransfers.businessDate,
      fromAccountId: accountTransfers.fromAccountId,
      fromAccountName: fromAccount.name,
      toAccountId: accountTransfers.toAccountId,
      toAccountName: toAccount.name,
      amountMinor: accountTransfers.amountMinor,
      reference: accountTransfers.reference,
      note: accountTransfers.note,
      status: accountTransfers.status,
      voidReason: accountTransfers.voidReason,
      createdByName: users.displayName,
    })
    .from(accountTransfers)
    .innerJoin(fromAccount, eq(fromAccount.id, accountTransfers.fromAccountId))
    .innerJoin(toAccount, eq(toAccount.id, accountTransfers.toAccountId))
    .leftJoin(users, eq(users.id, accountTransfers.createdBy))
    .orderBy(desc(accountTransfers.businessDate), desc(accountTransfers.id))
    .limit(query.limit ?? 50)
    .offset(query.offset ?? 0)
    .all()
    .map(({ amountMinor, ...row }) => ({ ...row, amount: minor(amountMinor) }));
}

export function countTransfers(db: Db): number {
  const row = db.select({ count: sql<number>`COUNT(*)` }).from(accountTransfers).get();
  return row?.count ?? 0;
}
