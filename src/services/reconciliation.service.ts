import { and, desc, eq, lte } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db } from '@/db/types';
import { accounts, businessSettings, paymentAccounts, reconciliations } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { credit, debit, type DraftLine } from '@/domain/accounting/journal';
import { absolute, formatMoney, isZero, minor, subtract, type Minor } from '@/domain/money';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';
import { postJournalEntry, reverseJournalEntry, type Actor } from './journal.service';
import { DOC_TYPES, nextDocumentNumber } from './sequence.service';
import { getPaymentAccountBalance } from './payment-account.service';

/**
 * Reconciliation — checking the books against reality.
 *
 * The rule that shapes everything here: history is never edited to make the
 * numbers agree. A difference is recorded as a permanent fact, and if the owner
 * accepts it, an adjusting entry is POSTED to Cash Over / Short so the shortage
 * or surplus appears in the accounts. A shop that quietly "corrects" its cash
 * book learns nothing about where the money went.
 */

export interface ReconciliationContext {
  paymentAccountId: number;
  accountName: string;
  kind: string;
  /** What the ledger says, as at the date being counted. */
  expected: Minor;
  /** The previous count on this account, if any. */
  lastReconciliation: {
    id: number;
    reconciliationNo: string;
    businessDate: string;
    actual: Minor;
    difference: Minor;
    adjusted: boolean;
  } | null;
}

/**
 * Everything needed to start a count.
 *
 * The expected balance is computed as at the chosen date, so counting last
 * Friday's till compares against last Friday's book balance, not today's.
 */
export function getReconciliationContext(
  db: Db,
  paymentAccountId: number,
  asAt: string,
): ReconciliationContext {
  const account = db
    .select()
    .from(paymentAccounts)
    .where(eq(paymentAccounts.id, paymentAccountId))
    .get();
  if (!account) throw new NotFoundError('Payment account', paymentAccountId);

  const previous = db
    .select()
    .from(reconciliations)
    .where(
      and(
        eq(reconciliations.paymentAccountId, paymentAccountId),
        eq(reconciliations.status, 'POSTED'),
        lte(reconciliations.businessDate, asAt),
      ),
    )
    .orderBy(desc(reconciliations.businessDate), desc(reconciliations.id))
    .limit(1)
    .get();

  return {
    paymentAccountId,
    accountName: account.name,
    kind: account.kind,
    expected: getPaymentAccountBalance(db, paymentAccountId, asAt),
    lastReconciliation: previous
      ? {
          id: previous.id,
          reconciliationNo: previous.reconciliationNo,
          businessDate: previous.businessDate,
          actual: minor(previous.actualMinor),
          difference: minor(previous.differenceMinor),
          adjusted: previous.adjusted,
        }
      : null,
  };
}

export interface CreateReconciliationInput {
  paymentAccountId: number;
  businessDate: string;
  /** What was actually counted. */
  actual: Minor;
  explanation?: string | undefined;
  /**
   * Post an adjusting entry so the books match the count.
   *
   * True: the difference goes to Cash Over / Short and the account balance
   * becomes the counted figure. False: the difference is recorded and left
   * open, because the owner wants to look for the money first.
   */
  adjust: boolean;
  occurredAt?: Date;
  isDemo?: boolean;
}

export interface CreatedReconciliation {
  reconciliationId: number;
  reconciliationNo: string;
  expected: Minor;
  actual: Minor;
  difference: Minor;
  adjusted: boolean;
  journalEntryId: number | null;
}

export function createReconciliation(
  db: Db,
  input: CreateReconciliationInput,
  actor: Actor,
): CreatedReconciliation {
  return writeTransaction(db, (tx) => {
    const occurredAt = input.occurredAt ?? new Date();

    const account = tx
      .select()
      .from(paymentAccounts)
      .where(eq(paymentAccounts.id, input.paymentAccountId))
      .get();
    if (!account) throw new NotFoundError('Payment account', input.paymentAccountId);
    if (!account.isActive) {
      throw new ValidationError(`"${account.name}" is archived and cannot be counted.`);
    }

    // Snapshot what the books claimed AT THIS MOMENT. This is the evidence.
    const expected = getPaymentAccountBalance(tx, input.paymentAccountId, input.businessDate);
    const difference = subtract(input.actual, expected);

    // The audit summary is written once and never revised, so the figure in it
    // has to read the way the shop reads money. Settings refuses a currency
    // change once anything is posted, so the code recorded here can never come
    // to disagree with the books it describes.
    const currencyCode =
      tx.select().from(businessSettings).where(eq(businessSettings.id, 1)).get()?.currencyCode ??
      'GHS';

    const explanation = input.explanation?.trim() ?? '';
    if (!isZero(difference) && explanation.length === 0) {
      throw new ValidationError(
        'There is a difference between the books and the count. Explain what you think happened before saving.',
        { expected, actual: input.actual, difference },
      );
    }

    const reconciliationNo = nextDocumentNumber(tx, DOC_TYPES.RECONCILIATION);

    const inserted = tx
      .insert(reconciliations)
      .values({
        reconciliationNo,
        paymentAccountId: input.paymentAccountId,
        businessDate: input.businessDate,
        occurredAt,
        expectedMinor: expected,
        actualMinor: input.actual,
        differenceMinor: difference,
        explanation: explanation.length > 0 ? explanation : null,
        adjusted: false,
        status: 'POSTED',
        createdBy: actor.id,
        isDemo: input.isDemo ?? false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .returning({ id: reconciliations.id })
      .get();

    if (!inserted) throw new ConflictError('Could not save the count.');

    let journalEntryId: number | null = null;
    let adjusted = false;

    // Only a real difference the owner has accepted produces an entry.
    if (!isZero(difference) && input.adjust) {
      const overShortAccount = tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.code, ACCOUNT_CODES.CASH_OVER_SHORT))
        .get();
      if (!overShortAccount) throw new NotFoundError('Account', ACCOUNT_CODES.CASH_OVER_SHORT);

      const amount = absolute(difference);
      const surplus = difference > 0;

      // Surplus: more money than the books say -> the account goes UP and the
      // Cash Over / Short expense goes down (a gain).
      // Shortage: the reverse.
      const lines: DraftLine[] = surplus
        ? [
            debit(account.glAccountId, amount, {
              paymentAccountId: input.paymentAccountId,
              description: `${reconciliationNo} surplus found`,
            }),
            credit(overShortAccount.id, amount, {
              description: `${reconciliationNo} cash over`,
            }),
          ]
        : [
            debit(overShortAccount.id, amount, {
              description: `${reconciliationNo} cash short`,
            }),
            credit(account.glAccountId, amount, {
              paymentAccountId: input.paymentAccountId,
              description: `${reconciliationNo} shortage`,
            }),
          ];

      const posted = postJournalEntry(
        tx,
        {
          entryDate: input.businessDate,
          sourceType: 'RECONCILIATION',
          sourceId: inserted.id,
          memo: `${reconciliationNo} — ${account.name} ${surplus ? 'over' : 'short'}: ${explanation}`,
          lines,
          occurredAt,
          isDemo: input.isDemo ?? false,
        },
        actor,
      );

      journalEntryId = posted.entryId;
      adjusted = true;

      tx.update(reconciliations)
        .set({ adjusted: true, journalEntryId: posted.entryId, updatedAt: occurredAt })
        .where(eq(reconciliations.id, inserted.id))
        .run();
    }

    writeAudit(tx, {
      action: 'RECONCILE',
      entityType: 'reconciliation',
      entityId: inserted.id,
      userId: actor.id,
      username: actor.username,
      summary: isZero(difference)
        ? `${reconciliationNo}: ${account.name} counted and agreed exactly`
        : `${reconciliationNo}: ${account.name} ${difference > 0 ? 'over' : 'short'} by ${formatMoney(absolute(difference), currencyCode)}${adjusted ? ' (adjusted)' : ' (left open)'}`,
      metadata: {
        expectedMinor: expected,
        actualMinor: input.actual,
        differenceMinor: difference,
        adjusted,
        explanation: explanation || null,
      },
      at: occurredAt,
    });

    return {
      reconciliationId: inserted.id,
      reconciliationNo,
      expected,
      actual: input.actual,
      difference,
      adjusted,
      journalEntryId,
    };
  });
}

/**
 * Void a count. The record is kept; any adjusting entry is reversed, so the
 * books return to what they said before the count was accepted.
 */
export function voidReconciliation(
  db: Db,
  reconciliationId: number,
  reason: string,
  actor: Actor,
  now: Date = new Date(),
): void {
  if (reason.trim().length < 3) {
    throw new ValidationError('Give a reason for voiding this count.');
  }

  writeTransaction(db, (tx) => {
    const record = tx
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.id, reconciliationId))
      .get();

    if (!record) throw new NotFoundError('Reconciliation', reconciliationId);
    if (record.status === 'VOIDED') throw new ConflictError('That count has already been voided.');

    if (record.journalEntryId !== null) {
      reverseJournalEntry(
        tx,
        record.journalEntryId,
        {
          entryDate: toBusinessDateString(now),
          sourceType: 'RECONCILIATION',
          sourceId: reconciliationId,
          memo: `Void of ${record.reconciliationNo}: ${reason.trim()}`,
          occurredAt: now,
        },
        actor,
      );
    }

    tx.update(reconciliations)
      .set({ status: 'VOIDED', voidedAt: now, voidReason: reason.trim(), updatedAt: now })
      .where(eq(reconciliations.id, reconciliationId))
      .run();

    writeAudit(tx, {
      action: 'VOID',
      entityType: 'reconciliation',
      entityId: reconciliationId,
      userId: actor.id,
      username: actor.username,
      summary: `Voided count ${record.reconciliationNo}`,
      metadata: { reason: reason.trim() },
      at: now,
    });
  });
}

function toBusinessDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// --- reads ----------------------------------------------------------------

export function listReconciliations(db: Db, paymentAccountId?: number, limit = 100) {
  const base = db
    .select({
      id: reconciliations.id,
      reconciliationNo: reconciliations.reconciliationNo,
      paymentAccountId: reconciliations.paymentAccountId,
      accountName: paymentAccounts.name,
      businessDate: reconciliations.businessDate,
      occurredAt: reconciliations.occurredAt,
      expectedMinor: reconciliations.expectedMinor,
      actualMinor: reconciliations.actualMinor,
      differenceMinor: reconciliations.differenceMinor,
      explanation: reconciliations.explanation,
      adjusted: reconciliations.adjusted,
      status: reconciliations.status,
      journalEntryId: reconciliations.journalEntryId,
    })
    .from(reconciliations)
    .innerJoin(paymentAccounts, eq(paymentAccounts.id, reconciliations.paymentAccountId));

  const filtered =
    paymentAccountId === undefined
      ? base
      : base.where(eq(reconciliations.paymentAccountId, paymentAccountId));

  return filtered
    .orderBy(desc(reconciliations.businessDate), desc(reconciliations.id))
    .limit(Math.min(limit, 500))
    .all();
}

export function getReconciliation(db: Db, id: number) {
  const found = listReconciliations(db).find((row) => row.id === id);
  if (!found) throw new NotFoundError('Reconciliation', id);
  return found;
}

export interface AccountReconciliationState {
  paymentAccountId: number;
  accountName: string;
  kind: string;
  currentBalance: Minor;
  lastCountedOn: string | null;
  lastDifference: Minor | null;
  /** Differences recorded but never adjusted — money still unaccounted for. */
  unresolvedDifference: Minor;
  countsRecorded: number;
}

/** One row per account for the reconciliation overview. */
export function getReconciliationOverview(db: Db): AccountReconciliationState[] {
  return db
    .select()
    .from(paymentAccounts)
    .where(eq(paymentAccounts.isActive, true))
    .orderBy(paymentAccounts.sortOrder)
    .all()
    .map((account) => {
      const counts = db
        .select()
        .from(reconciliations)
        .where(
          and(
            eq(reconciliations.paymentAccountId, account.id),
            eq(reconciliations.status, 'POSTED'),
          ),
        )
        .orderBy(desc(reconciliations.businessDate), desc(reconciliations.id))
        .all();

      const latest = counts[0];
      const unresolved = counts
        .filter((row) => !row.adjusted)
        .reduce((total, row) => total + row.differenceMinor, 0);

      return {
        paymentAccountId: account.id,
        accountName: account.name,
        kind: account.kind,
        currentBalance: getPaymentAccountBalance(db, account.id),
        lastCountedOn: latest?.businessDate ?? null,
        lastDifference: latest ? minor(latest.differenceMinor) : null,
        unresolvedDifference: minor(unresolved),
        countsRecorded: counts.length,
      };
    });
}
