import { and, desc, eq } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db } from '@/db/types';
import {
  accounts,
  businessSettings,
  customerPaymentAllocations,
  customerPayments,
  customers,
  paymentAccounts,
  sales,
} from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { credit, debit, type DraftLine } from '@/domain/accounting/journal';
import { subtract, sum, type Minor } from '@/domain/money';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';
import { postJournalEntry, reverseJournalEntry, type Actor } from './journal.service';
import { DOC_TYPES, nextDocumentNumber } from './sequence.service';
import { getCustomerBalance } from './customer.service';
import { getOutstandingBySale, getSaleOutstanding } from './sale.service';
import { minor } from '@/domain/money';

/**
 * Receiving money from a customer against what they owe.
 *
 *   Dr Cash / MoMo / Bank
 *     Cr Accounts Receivable   (tagged with the customer)
 *
 * Cash goes up, the debt goes down, and because the A/R line carries the
 * customer tag their balance falls by exactly the same amount the control
 * account does.
 */

export interface AllocationRequest {
  saleId: number;
  amount: Minor;
}

export interface CreateCustomerPaymentInput {
  customerId: number;
  businessDate: string;
  paymentAccountId: number;
  amount: Minor;
  reference?: string | undefined;
  note?: string | undefined;
  /** Which sales this settles. Left empty, it reduces the overall balance. */
  allocations?: AllocationRequest[];
  occurredAt?: Date;
  isDemo?: boolean;
}

export interface CreatedCustomerPayment {
  paymentId: number;
  paymentNo: string;
  journalEntryId: number;
  newBalance: Minor;
}

export function recordCustomerPayment(
  db: Db,
  input: CreateCustomerPaymentInput,
  actor: Actor,
): CreatedCustomerPayment {
  if (input.amount <= 0) {
    throw new ValidationError('Enter an amount greater than zero.');
  }

  return writeTransaction(db, (tx) => {
    const occurredAt = input.occurredAt ?? new Date();

    const customer = tx.select().from(customers).where(eq(customers.id, input.customerId)).get();
    if (!customer) throw new NotFoundError('Customer', input.customerId);

    const account = tx
      .select()
      .from(paymentAccounts)
      .where(eq(paymentAccounts.id, input.paymentAccountId))
      .get();
    if (!account) throw new NotFoundError('Payment account', input.paymentAccountId);
    if (!account.isActive) {
      throw new ValidationError(`Payment account "${account.name}" is not active.`);
    }

    // Whether a customer may pay more than they owe is the shop's policy, not
    // this function's. Off by default: at a counter, an amount larger than the
    // balance is usually a typo, and refusing it catches the mistake while the
    // customer is still standing there. Switched on, the excess stays on the
    // account as a credit and settles against their next purchase.
    const currentBalance = getCustomerBalance(tx, input.customerId);
    const allowOverpayment =
      tx.select().from(businessSettings).where(eq(businessSettings.id, 1)).get()
        ?.allowOverpayment ?? false;

    if (input.amount > currentBalance && !allowOverpayment) {
      throw new ValidationError(
        `${customer.name} owes ${formatForError(currentBalance)}. You cannot receive more than that. ` +
          'To accept advance payments, switch on "Allow paying more than is owed" in Settings.',
        { currentBalance, amount: input.amount },
      );
    }

    const paymentNo = nextDocumentNumber(tx, DOC_TYPES.PAYMENT_IN);

    const payment = tx
      .insert(customerPayments)
      .values({
        paymentNo,
        customerId: input.customerId,
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
      .returning({ id: customerPayments.id })
      .get();

    if (!payment) throw new ConflictError('Could not record the payment.');

    // --- allocations -----------------------------------------------------
    const allocations = input.allocations ?? autoAllocate(tx, input.customerId, input.amount);
    const allocatedTotal = sum(allocations.map((allocation) => allocation.amount));

    if (allocatedTotal > input.amount) {
      throw new ValidationError('The amounts allocated to invoices exceed the payment.');
    }

    for (const allocation of allocations) {
      if (allocation.amount <= 0) continue;

      const sale = tx.select().from(sales).where(eq(sales.id, allocation.saleId)).get();
      if (!sale) throw new NotFoundError('Sale', allocation.saleId);
      if (sale.customerId !== input.customerId) {
        throw new ValidationError('That sale belongs to a different customer.');
      }
      if (sale.status === 'VOIDED') {
        throw new ValidationError('That sale has been voided and cannot be paid.');
      }

      const outstanding = getSaleOutstanding(tx, allocation.saleId);
      if (allocation.amount > outstanding) {
        throw new ValidationError(
          `Cannot allocate more than is outstanding on ${sale.receiptNo}.`,
          { outstanding, requested: allocation.amount },
        );
      }

      tx.insert(customerPaymentAllocations)
        .values({
          paymentId: payment.id,
          saleId: allocation.saleId,
          amountMinor: allocation.amount,
          createdAt: occurredAt,
        })
        .run();
    }

    // --- the journal entry ------------------------------------------------
    const lines: DraftLine[] = [
      debit(account.glAccountId, input.amount, {
        paymentAccountId: input.paymentAccountId,
        description: `${paymentNo} from ${customer.name}`,
      }),
      credit(accountIdByCode(tx, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE), input.amount, {
        customerId: input.customerId,
        description: `${paymentNo} settles debt`,
      }),
    ];

    const posted = postJournalEntry(
      tx,
      {
        entryDate: input.businessDate,
        sourceType: 'CUSTOMER_PAYMENT',
        sourceId: payment.id,
        memo: `${paymentNo} — payment from ${customer.name}`,
        lines,
        occurredAt,
        isDemo: input.isDemo ?? false,
      },
      actor,
    );

    tx.update(customerPayments)
      .set({ journalEntryId: posted.entryId, updatedAt: occurredAt })
      .where(eq(customerPayments.id, payment.id))
      .run();

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'customer_payment',
      entityId: payment.id,
      userId: actor.id,
      username: actor.username,
      summary: `${paymentNo}: received ${input.amount} from ${customer.name}`,
      metadata: {
        amountMinor: input.amount,
        paymentAccount: account.name,
        entryNo: posted.entryNo,
      },
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

/** Oldest unpaid sale first — the convention a shop owner expects. */
function autoAllocate(
  tx: Db,
  customerId: number,
  amount: Minor,
): AllocationRequest[] {
  const unpaid = tx
    .select({ id: sales.id })
    .from(sales)
    .where(and(eq(sales.customerId, customerId), eq(sales.status, 'POSTED')))
    .orderBy(sales.businessDate, sales.id)
    .all();

  const allocations: AllocationRequest[] = [];
  let remaining = amount;

  for (const sale of unpaid) {
    if (remaining <= 0) break;
    const outstanding = getSaleOutstanding(tx, sale.id);
    if (outstanding <= 0) continue;

    const applied = outstanding < remaining ? outstanding : remaining;
    allocations.push({ saleId: sale.id, amount: applied });
    remaining = subtract(remaining, applied);
  }

  return allocations;
}

function accountIdByCode(tx: Db, code: string): number {
  const account = tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code)).get();
  if (!account) throw new NotFoundError('Account', code);
  return account.id;
}

function formatForError(value: Minor): string {
  const negative = value < 0;
  const digits = Math.abs(value).toString().padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${whole}.${digits.slice(-2)}`;
}

/**
 * Void a payment: the money goes back out of the account and the debt is
 * restored. The original payment row is kept and marked voided.
 */
export function voidCustomerPayment(
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
      .from(customerPayments)
      .where(eq(customerPayments.id, paymentId))
      .get();

    if (!payment) throw new NotFoundError('Customer payment', paymentId);
    if (payment.status === 'VOIDED') {
      throw new ConflictError('That payment has already been voided.');
    }

    if (payment.journalEntryId !== null) {
      reverseJournalEntry(
        tx,
        payment.journalEntryId,
        {
          entryDate: toBusinessDateString(now),
          sourceType: 'CUSTOMER_PAYMENT',
          sourceId: paymentId,
          memo: `Void of ${payment.paymentNo}: ${reason.trim()}`,
          occurredAt: now,
        },
        actor,
      );
    }

    // Allocations are removed so the sales they settled become outstanding
    // again; the payment document itself is kept, marked voided.
    tx.delete(customerPaymentAllocations)
      .where(eq(customerPaymentAllocations.paymentId, paymentId))
      .run();

    tx.update(customerPayments)
      .set({ status: 'VOIDED', voidedAt: now, voidReason: reason.trim(), updatedAt: now })
      .where(eq(customerPayments.id, paymentId))
      .run();

    writeAudit(tx, {
      action: 'VOID',
      entityType: 'customer_payment',
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

// --- reads ----------------------------------------------------------------

export function listCustomerPayments(db: Db, customerId?: number, limit = 100) {
  const base = db
    .select({
      id: customerPayments.id,
      paymentNo: customerPayments.paymentNo,
      customerId: customerPayments.customerId,
      customerName: customers.name,
      businessDate: customerPayments.businessDate,
      occurredAt: customerPayments.occurredAt,
      amountMinor: customerPayments.amountMinor,
      accountName: paymentAccounts.name,
      reference: customerPayments.reference,
      status: customerPayments.status,
    })
    .from(customerPayments)
    .innerJoin(customers, eq(customers.id, customerPayments.customerId))
    .innerJoin(paymentAccounts, eq(paymentAccounts.id, customerPayments.paymentAccountId));

  const filtered =
    customerId === undefined ? base : base.where(eq(customerPayments.customerId, customerId));

  return filtered
    .orderBy(desc(customerPayments.occurredAt), desc(customerPayments.id))
    .limit(Math.min(limit, 500))
    .all();
}

/**
 * Unpaid sales for a customer, oldest first — what the payment form offers.
 *
 * Outstanding is computed per sale with `getSaleOutstanding` rather than by a
 * correlated subquery: a single customer has few open sales, and reusing the
 * one tested definition of "outstanding" removes any chance of this list and
 * the sale detail page disagreeing.
 */
export function getOpenSales(db: Db, customerId: number) {
  const outstanding = getOutstandingBySale(db, { customerId });

  return db
    .select({
      id: sales.id,
      receiptNo: sales.receiptNo,
      businessDate: sales.businessDate,
      totalMinor: sales.totalMinor,
    })
    .from(sales)
    .where(and(eq(sales.customerId, customerId), eq(sales.status, 'POSTED')))
    .orderBy(sales.businessDate, sales.id)
    .all()
    .map((row) => ({ ...row, outstandingMinor: outstanding.get(row.id) ?? minor(0) }))
    .filter((row) => row.outstandingMinor > 0);
}
