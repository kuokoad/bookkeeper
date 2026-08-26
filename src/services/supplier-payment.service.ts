import { desc, eq } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db } from '@/db/types';
import {
  accounts,
  businessSettings,
  paymentAccounts,
  purchases,
  supplierPaymentAllocations,
  supplierPayments,
  suppliers,
} from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { credit, debit, type DraftLine } from '@/domain/accounting/journal';
import { subtract, type Minor } from '@/domain/money';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';
import { postJournalEntry, reverseJournalEntry, type Actor } from './journal.service';
import { DOC_TYPES, nextDocumentNumber } from './sequence.service';
import { getSupplierBalance } from './supplier.service';
import { getOpenPurchases, getPurchaseOutstanding } from './purchase.service';

/**
 * Paying a supplier what is owed.
 *
 *   Dr Accounts Payable   (tagged with the supplier)
 *     Cr Cash / MoMo / Bank
 *
 * The debt falls and the money leaves. Because the A/P line carries the
 * supplier tag, their balance drops by exactly what the control account does.
 */

export interface SupplierAllocationRequest {
  purchaseId: number;
  amount: Minor;
}

export interface CreateSupplierPaymentInput {
  supplierId: number;
  businessDate: string;
  paymentAccountId: number;
  amount: Minor;
  reference?: string | undefined;
  note?: string | undefined;
  allocations?: SupplierAllocationRequest[];
  occurredAt?: Date;
  isDemo?: boolean;
}

export function recordSupplierPayment(
  db: Db,
  input: CreateSupplierPaymentInput,
  actor: Actor,
): { paymentId: number; paymentNo: string; journalEntryId: number; newBalance: Minor } {
  if (input.amount <= 0) {
    throw new ValidationError('Enter an amount greater than zero.');
  }

  return writeTransaction(db, (tx) => {
    const occurredAt = input.occurredAt ?? new Date();

    const supplier = tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId)).get();
    if (!supplier) throw new NotFoundError('Supplier', input.supplierId);

    const account = tx
      .select()
      .from(paymentAccounts)
      .where(eq(paymentAccounts.id, input.paymentAccountId))
      .get();
    if (!account) throw new NotFoundError('Payment account', input.paymentAccountId);
    if (!account.isActive) {
      throw new ValidationError(`Payment account "${account.name}" is not active.`);
    }

    // Whether the shop may pay a supplier more than it owes is policy, not this
    // function's decision. Off by default: an amount larger than the balance is
    // usually a typo, and money sent in error is harder to get back than a
    // mistyped figure is to correct. Switched on, the excess stays on the
    // supplier's account and settles against the next delivery.
    const currentBalance = getSupplierBalance(tx, input.supplierId);
    const allowOverpayment =
      tx.select().from(businessSettings).where(eq(businessSettings.id, 1)).get()
        ?.allowOverpayment ?? false;

    if (input.amount > currentBalance && !allowOverpayment) {
      throw new ValidationError(
        `You owe ${supplier.name} ${formatForError(currentBalance)}. You cannot pay more than that. ` +
          'To pay in advance, switch on "Allow paying more than is owed" in Settings.',
        { currentBalance, amount: input.amount },
      );
    }

    const paymentNo = nextDocumentNumber(tx, DOC_TYPES.PAYMENT_OUT);

    const payment = tx
      .insert(supplierPayments)
      .values({
        paymentNo,
        supplierId: input.supplierId,
        businessDate: input.businessDate,
        occurredAt,
        paymentAccountId: input.paymentAccountId,
        amountMinor: input.amount,
        reference: input.reference ?? null,
        note: input.note ?? null,
        status: 'POSTED',
        createdBy: actor.id,
        isDemo: input.isDemo ?? false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .returning({ id: supplierPayments.id })
      .get();

    if (!payment) throw new ConflictError('Could not record the payment.');

    const allocations =
      input.allocations ?? autoAllocate(tx, input.supplierId, input.amount);

    for (const allocation of allocations) {
      if (allocation.amount <= 0) continue;

      const purchase = tx
        .select()
        .from(purchases)
        .where(eq(purchases.id, allocation.purchaseId))
        .get();
      if (!purchase) throw new NotFoundError('Purchase', allocation.purchaseId);
      if (purchase.supplierId !== input.supplierId) {
        throw new ValidationError('That purchase belongs to a different supplier.');
      }

      const outstanding = getPurchaseOutstanding(tx, allocation.purchaseId);
      if (allocation.amount > outstanding) {
        throw new ValidationError(
          `Cannot allocate more than is outstanding on ${purchase.purchaseNo}.`,
        );
      }

      tx.insert(supplierPaymentAllocations)
        .values({
          paymentId: payment.id,
          purchaseId: allocation.purchaseId,
          amountMinor: allocation.amount,
          createdAt: occurredAt,
        })
        .run();
    }

    const lines: DraftLine[] = [
      debit(accountIdByCode(tx, ACCOUNT_CODES.ACCOUNTS_PAYABLE), input.amount, {
        supplierId: input.supplierId,
        description: `${paymentNo} settles debt`,
      }),
      credit(account.glAccountId, input.amount, {
        paymentAccountId: input.paymentAccountId,
        description: `${paymentNo} paid to ${supplier.name}`,
      }),
    ];

    const posted = postJournalEntry(
      tx,
      {
        entryDate: input.businessDate,
        sourceType: 'SUPPLIER_PAYMENT',
        sourceId: payment.id,
        memo: `${paymentNo} — payment to ${supplier.name}`,
        lines,
        occurredAt,
        isDemo: input.isDemo ?? false,
      },
      actor,
    );

    tx.update(supplierPayments)
      .set({ journalEntryId: posted.entryId, updatedAt: occurredAt })
      .where(eq(supplierPayments.id, payment.id))
      .run();

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'supplier_payment',
      entityId: payment.id,
      userId: actor.id,
      username: actor.username,
      summary: `${paymentNo}: paid ${input.amount} to ${supplier.name}`,
      metadata: { amountMinor: input.amount, entryNo: posted.entryNo },
      at: occurredAt,
    });

    return {
      paymentId: payment.id,
      paymentNo,
      journalEntryId: posted.entryId,
      newBalance: subtract(currentBalance, input.amount),
    };
  });
}

/** Oldest unpaid purchase first. */
function autoAllocate(db: Db, supplierId: number, amount: Minor): SupplierAllocationRequest[] {
  const allocations: SupplierAllocationRequest[] = [];
  let remaining = amount;

  for (const purchase of getOpenPurchases(db, supplierId)) {
    if (remaining <= 0) break;
    const applied = purchase.outstandingMinor < remaining ? purchase.outstandingMinor : remaining;
    allocations.push({ purchaseId: purchase.id, amount: applied });
    remaining = subtract(remaining, applied);
  }

  return allocations;
}

function accountIdByCode(db: Db, code: string): number {
  const account = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code)).get();
  if (!account) throw new NotFoundError('Account', code);
  return account.id;
}

function formatForError(value: Minor): string {
  const digits = Math.abs(value).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${value < 0 ? '-' : ''}${whole}.${digits.slice(-2)}`;
}

export function voidSupplierPayment(
  db: Db,
  paymentId: number,
  reason: string,
  actor: Actor,
  now: Date = new Date(),
): void {
  if (reason.trim().length < 3) {
    throw new ValidationError('Give a reason for voiding this payment.');
  }

  writeTransaction(db, (tx) => {
    const payment = tx
      .select()
      .from(supplierPayments)
      .where(eq(supplierPayments.id, paymentId))
      .get();

    if (!payment) throw new NotFoundError('Supplier payment', paymentId);
    if (payment.status === 'VOIDED') {
      throw new ConflictError('That payment has already been voided.');
    }

    if (payment.journalEntryId !== null) {
      reverseJournalEntry(
        tx,
        payment.journalEntryId,
        {
          entryDate: toBusinessDateString(now),
          sourceType: 'SUPPLIER_PAYMENT',
          sourceId: paymentId,
          memo: `Void of ${payment.paymentNo}: ${reason.trim()}`,
          occurredAt: now,
        },
        actor,
      );
    }

    /**
     * The allocations STAY.
     *
     * They used to be deleted here, so the sales this payment had settled would
     * become outstanding again. They already do: every reader of these rows
     * joins back to the payment and counts only `status = 'POSTED'` — all six
     * of them, in `sale.service.ts`, `purchase.service.ts` and here. Marking the
     * payment voided on the next line is what frees the sales.
     *
     * So the delete freed nothing and cost the only record of what this payment
     * had settled. In an application whose rule is that history is corrected by
     * a reversing entry and never by deleting, it was the one place that broke
     * it — and the answer to "what did this payment pay for?" is exactly what
     * somebody asks months later when a customer disputes a receipt.
     */

    tx.update(supplierPayments)
      .set({ status: 'VOIDED', voidedAt: now, voidReason: reason.trim(), updatedAt: now })
      .where(eq(supplierPayments.id, paymentId))
      .run();

    writeAudit(tx, {
      action: 'VOID',
      entityType: 'supplier_payment',
      entityId: paymentId,
      userId: actor.id,
      username: actor.username,
      summary: `Voided payment ${payment.paymentNo}`,
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

export function listSupplierPayments(db: Db, supplierId?: number, limit = 100) {
  const base = db
    .select({
      id: supplierPayments.id,
      paymentNo: supplierPayments.paymentNo,
      supplierId: supplierPayments.supplierId,
      supplierName: suppliers.name,
      businessDate: supplierPayments.businessDate,
      occurredAt: supplierPayments.occurredAt,
      amountMinor: supplierPayments.amountMinor,
      accountName: paymentAccounts.name,
      reference: supplierPayments.reference,
      status: supplierPayments.status,
    })
    .from(supplierPayments)
    .innerJoin(suppliers, eq(suppliers.id, supplierPayments.supplierId))
    .innerJoin(paymentAccounts, eq(paymentAccounts.id, supplierPayments.paymentAccountId));

  const filtered =
    supplierId === undefined ? base : base.where(eq(supplierPayments.supplierId, supplierId));

  return filtered
    .orderBy(desc(supplierPayments.occurredAt), desc(supplierPayments.id))
    .limit(Math.min(limit, 500))
    .all();
}
