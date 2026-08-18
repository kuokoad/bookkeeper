import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';

import { accounts, journalLines, journalEntries } from '@/db/schema';
import type { Db } from '@/db/types';
import { minor, type Minor } from '@/domain/money';

/**
 * Splitting a control account into what is owed TO the shop and what the shop
 * holds FOR someone else.
 *
 * Once overpayment is allowed, a customer can end up in credit: they have paid
 * more than they owe. In the general ledger that sits inside Accounts
 * Receivable as a negative balance, and the control-account total quietly nets
 * it off — so the balance sheet would understate what customers actually owe
 * and omit money the shop is holding on their behalf. It still balances, which
 * is exactly why it would go unnoticed.
 *
 * Splitting by the SIGN of each party's own balance reports both honestly:
 * debtors as an asset, credits as the liability they are. The two still sum to
 * the control account, so nothing is invented.
 */

export interface SubledgerSplit {
  /** Parties with a debit balance — genuinely owed to the shop. */
  owed: Minor;
  /** Parties in credit — money held on their behalf. Reported positive. */
  inCredit: Minor;
  /** owed − inCredit. Always equals the control account balance. */
  net: Minor;
  /** How many parties are in credit, for a note on the report. */
  creditCount: number;
}

function split(
  db: Db,
  accountCode: string,
  partyColumn: typeof journalLines.customerId | typeof journalLines.supplierId,
  asAt: string | undefined,
  /** A/R is debit-normal, A/P credit-normal, so the sign flips. */
  normal: 'debit' | 'credit',
): SubledgerSplit {
  const conditions = [eq(accounts.code, accountCode), isNotNull(partyColumn)];
  if (asAt) conditions.push(lte(journalEntries.entryDate, asAt));

  const rows = db
    .select({
      party: partyColumn,
      debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...conditions))
    .groupBy(partyColumn)
    .all();

  let owed = 0;
  let inCredit = 0;

  for (const row of rows) {
    const balance = normal === 'debit' ? row.debit - row.credit : row.credit - row.debit;
    if (balance > 0) owed += balance;
    else if (balance < 0) inCredit += -balance;
  }

  return {
    owed: minor(owed),
    inCredit: minor(inCredit),
    net: minor(owed - inCredit),
    creditCount: rows.filter((row) => {
      const balance = normal === 'debit' ? row.debit - row.credit : row.credit - row.debit;
      return balance < 0;
    }).length,
  };
}

/** Customers who owe, against customers in credit. */
export function getReceivablesSplit(db: Db, asAt?: string): SubledgerSplit {
  return split(db, '1100', journalLines.customerId, asAt, 'debit');
}

/** Suppliers owed, against suppliers the shop has paid in advance. */
export function getPayablesSplit(db: Db, asAt?: string): SubledgerSplit {
  return split(db, '2000', journalLines.supplierId, asAt, 'credit');
}
