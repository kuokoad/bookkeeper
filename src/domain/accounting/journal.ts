import { absolute, isZero, subtract, sum, ZERO, type Minor } from '../money';
import { UnbalancedEntryError, ValidationError } from '../errors';
import type { AccountType, JournalSourceType, NormalBalance } from '@/db/schema/accounting';

/**
 * Construction and validation of double-entry journal entries.
 *
 * Pure functions only — no database, no clock, no ids generated here. A service
 * builds a DraftEntry, this module proves it balances, and only then does the
 * service write it inside a transaction.
 */

export interface DraftLine {
  accountId: number;
  debit: Minor;
  credit: Minor;
  paymentAccountId?: number;
  /**
   * Subledger tag for lines hitting Accounts Receivable. Tagging the line is
   * what makes "what does this customer owe?" a query over the ledger rather
   * than a separately maintained total that can drift.
   */
  customerId?: number;
  /** The same idea for Accounts Payable lines. */
  supplierId?: number;
  description?: string;
}

export interface LineOptions {
  paymentAccountId?: number;
  customerId?: number;
  supplierId?: number;
  description?: string;
}

export interface DraftEntry {
  /** Shop-local business day, 'YYYY-MM-DD'. */
  entryDate: string;
  sourceType: JournalSourceType;
  sourceId?: number;
  memo?: string;
  isOpening?: boolean;
  lines: DraftLine[];
}

// --- line construction -----------------------------------------------------

function assertPositiveAmount(amount: Minor, side: string): void {
  if (amount < 0) {
    throw new ValidationError(
      `A ${side} amount cannot be negative (received ${amount}). Post it to the opposite side instead.`,
      { amount, side },
    );
  }
}

export function debit(accountId: number, amount: Minor, options: LineOptions = {}): DraftLine {
  assertPositiveAmount(amount, 'debit');
  return { accountId, debit: amount, credit: ZERO, ...options };
}

export function credit(accountId: number, amount: Minor, options: LineOptions = {}): DraftLine {
  assertPositiveAmount(amount, 'credit');
  return { accountId, debit: ZERO, credit: amount, ...options };
}

/**
 * Post a signed amount: positive becomes a debit, negative becomes a credit of
 * the absolute value. Useful when a computed figure may legitimately go either
 * way (a reconciliation difference, a net adjustment).
 */
export function postSigned(
  accountId: number,
  amount: Minor,
  options: LineOptions = {},
): DraftLine {
  return amount >= 0
    ? debit(accountId, amount, options)
    : credit(accountId, absolute(amount), options);
}

// --- totals and validation -------------------------------------------------

export function totalDebits(lines: readonly DraftLine[]): Minor {
  return sum(lines.map((l) => l.debit));
}

export function totalCredits(lines: readonly DraftLine[]): Minor {
  return sum(lines.map((l) => l.credit));
}

/**
 * Remove lines that move no money.
 *
 * A zero line is meaningless bookkeeping and would also violate the database
 * CHECK that every line is exactly one-sided, so it is stripped before writing
 * rather than allowed to fail at the storage layer with an opaque error.
 */
export function dropZeroLines(lines: readonly DraftLine[]): DraftLine[] {
  return lines.filter((l) => !(isZero(l.debit) && isZero(l.credit)));
}

/** Throws unless every line is one-sided and non-negative. */
export function assertLinesWellFormed(lines: readonly DraftLine[]): void {
  lines.forEach((line, index) => {
    if (line.debit < 0 || line.credit < 0) {
      throw new ValidationError(`Journal line ${index + 1} has a negative amount.`, { line });
    }
    if (!isZero(line.debit) && !isZero(line.credit)) {
      throw new ValidationError(
        `Journal line ${index + 1} is both a debit and a credit. Each line must be one or the other.`,
        { line },
      );
    }
    if (!Number.isInteger(line.accountId) || line.accountId <= 0) {
      throw new ValidationError(`Journal line ${index + 1} has an invalid account.`, { line });
    }
  });
}

/**
 * The central invariant of the whole application: debits must equal credits.
 *
 * Called inside the database transaction, immediately before commit. If it
 * throws, the entire business operation rolls back — no sale, no stock movement,
 * no payment. An unbalanced ledger is never written, not even briefly.
 */
export function assertBalanced(lines: readonly DraftLine[]): void {
  if (lines.length === 0) {
    throw new ValidationError('A journal entry must have at least one line.');
  }
  if (lines.length < 2) {
    throw new ValidationError('A journal entry must have at least two lines to balance.');
  }

  assertLinesWellFormed(lines);

  const debits = totalDebits(lines);
  const credits = totalCredits(lines);

  if (!isZero(subtract(debits, credits))) {
    throw new UnbalancedEntryError(debits, credits, {
      difference: subtract(debits, credits),
      lineCount: lines.length,
    });
  }

  if (isZero(debits)) {
    throw new ValidationError('A journal entry must move a non-zero amount.');
  }
}

/**
 * Normalise a draft into the exact set of lines to persist: strip zero lines,
 * validate, and prove it balances.
 */
export function finaliseLines(lines: readonly DraftLine[]): DraftLine[] {
  const cleaned = dropZeroLines(lines);
  assertBalanced(cleaned);
  return cleaned;
}

// --- balances --------------------------------------------------------------

export function normalBalanceOf(type: AccountType): NormalBalance {
  switch (type) {
    case 'ASSET':
    case 'EXPENSE':
    case 'COGS':
    case 'CONTRA_EQUITY':
    case 'CONTRA_REVENUE':
      return 'DEBIT';
    case 'LIABILITY':
    case 'EQUITY':
    case 'REVENUE':
      return 'CREDIT';
  }
}

/**
 * Convert raw debit/credit totals into the balance a human expects to see.
 *
 * Cash with 500 debit and 200 credit reads as 300, not -300. A liability with
 * 600 credit reads as 600. The sign convention is applied here, once, so no
 * report has to remember it.
 */
export function signedBalance(type: AccountType, debits: Minor, credits: Minor): Minor {
  return normalBalanceOf(type) === 'DEBIT' ? subtract(debits, credits) : subtract(credits, debits);
}

// --- reversal --------------------------------------------------------------

/**
 * Mirror an entry's lines to undo it.
 *
 * Every debit becomes a credit of the same amount and vice versa, so the pair
 * nets to zero. This is how a void or correction is recorded: the original rows
 * are never edited or deleted, so the history of what actually happened, and of
 * the correction, both survive.
 */
export function reverseLines(lines: readonly DraftLine[]): DraftLine[] {
  return lines.map((line) => ({
    accountId: line.accountId,
    debit: line.credit,
    credit: line.debit,
    ...(line.paymentAccountId !== undefined ? { paymentAccountId: line.paymentAccountId } : {}),
    // The subledger tag must survive a reversal, or the customer's balance
    // would be reduced on the control account but not against them.
    ...(line.customerId !== undefined ? { customerId: line.customerId } : {}),
    ...(line.supplierId !== undefined ? { supplierId: line.supplierId } : {}),
    ...(line.description !== undefined ? { description: `Reversal: ${line.description}` } : {}),
  }));
}
