import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { accounts, journalEntries, journalLines, paymentAccounts } from '@/db/schema';
import type { AccountType } from '@/db/schema/accounting';
import { minor, subtract, sum, ZERO, type Minor } from '@/domain/money';
import { signedBalance } from '@/domain/accounting/journal';

/**
 * Account balances, derived from the ledger every single time.
 *
 * There is no stored balance column anywhere in this application. Every figure
 * returned here is `SUM(debit) - SUM(credit)` over real journal lines, which is
 * what makes "why is cash GHS 5,240?" answerable: the same rows that produce
 * the number can be listed underneath it.
 */

export interface DateRange {
  /** Inclusive 'YYYY-MM-DD'. */
  from?: string;
  /** Inclusive 'YYYY-MM-DD'. */
  to?: string;
  /**
   * Leave out year-end closing entries.
   *
   * Needed when working out what a year *traded*, as opposed to what its
   * accounts hold now. Closing a year already closed would otherwise sweep the
   * previous sweep and post a second, opposite entry.
   */
  excludeClosing?: boolean;
}

export interface AccountBalance {
  accountId: number;
  code: string;
  name: string;
  type: AccountType;
  parentId: number | null;
  isHeader: boolean;
  totalDebit: Minor;
  totalCredit: Minor;
  /** Sign-adjusted for the account type, so it reads the way a human expects. */
  balance: Minor;
}

/**
 * Date filtering lives in the JOIN condition, not in WHERE.
 *
 * With a LEFT JOIN, a WHERE clause on the right-hand table silently turns it
 * into an INNER JOIN and drops every account that has no movement in the
 * period — which would quietly hide accounts from a trial balance instead of
 * showing them as zero.
 */
function periodConditions(range: DateRange): SQL[] {
  const conditions: SQL[] = [];
  if (range.from) conditions.push(gte(journalEntries.entryDate, range.from));
  if (range.to) conditions.push(lte(journalEntries.entryDate, range.to));
  if (range.excludeClosing) conditions.push(eq(journalEntries.isClosing, false));
  return conditions;
}

export function getAccountBalances(db: Db, range: DateRange = {}): AccountBalance[] {
  const joinConditions = [eq(journalEntries.id, journalLines.entryId), ...periodConditions(range)];

  const rows = db
    .select({
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      parentId: accounts.parentId,
      totalDebit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      totalCredit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
      childCount: sql<number>`(SELECT COUNT(*) FROM ${accounts} AS child WHERE child.parent_id = ${accounts.id})`,
    })
    .from(accounts)
    .leftJoin(journalLines, eq(journalLines.accountId, accounts.id))
    .leftJoin(journalEntries, and(...joinConditions))
    // A line whose entry fell outside the period must not contribute.
    .where(
      range.from === undefined && range.to === undefined
        ? undefined
        : sql`${journalLines.id} IS NULL OR ${journalEntries.id} IS NOT NULL`,
    )
    .groupBy(accounts.id)
    .orderBy(asc(accounts.sortOrder), asc(accounts.code))
    .all();

  return rows.map((row) => {
    const totalDebit = minor(row.totalDebit);
    const totalCredit = minor(row.totalCredit);
    return {
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      type: row.type,
      parentId: row.parentId,
      isHeader: row.childCount > 0,
      totalDebit,
      totalCredit,
      balance: signedBalance(row.type, totalDebit, totalCredit),
    };
  });
}

export function getAccountBalanceByCode(
  db: Db,
  code: string,
  range: DateRange = {},
): Minor {
  const balances = getAccountBalances(db, range);
  const account = balances.find((entry) => entry.code === code);
  if (!account) return ZERO;

  // A heading's balance is the sum of its children plus anything posted to it.
  if (account.isHeader) {
    const children = balances.filter((entry) => entry.parentId === account.accountId);
    return sum([account.balance, ...children.map((child) => child.balance)]);
  }
  return account.balance;
}

export interface TrialBalanceLine {
  accountId: number;
  code: string;
  name: string;
  type: AccountType;
  /** The account's NET balance, on whichever side it falls. One is always zero. */
  debit: Minor;
  credit: Minor;
}

export interface TrialBalance {
  lines: TrialBalanceLine[];
  totalDebit: Minor;
  totalCredit: Minor;
  difference: Minor;
  /**
   * The headline integrity check. If this is ever false the books are broken
   * and the UI says so loudly rather than presenting a tidy but wrong report.
   */
  balanced: boolean;
}

/**
 * A trial balance of BALANCES, not of gross totals.
 *
 * Each account appears once, with its net balance in the debit or credit
 * column, and an account whose debits and credits cancel does not appear at
 * all. The gross form — every account listing everything ever posted to both
 * sides — made a closed year unreadable: after a year-end close, Sales Revenue
 * would still show a year of sales on one side and the closing entry on the
 * other, when the account in fact holds nothing.
 *
 * The totals still tie: since debits equal credits over the whole ledger, the
 * positive nets sum to the negative nets.
 */
export function getTrialBalance(db: Db, range: DateRange = {}): TrialBalance {
  const lines: TrialBalanceLine[] = [];

  // Headings are excluded so amounts are not counted twice.
  for (const account of getAccountBalances(db, range)) {
    if (account.isHeader) continue;

    const net = account.totalDebit - account.totalCredit;
    if (net === 0) continue;

    lines.push({
      accountId: account.accountId,
      code: account.code,
      name: account.name,
      type: account.type,
      debit: minor(net > 0 ? net : 0),
      credit: minor(net < 0 ? -net : 0),
    });
  }

  const totalDebit = sum(lines.map((line) => line.debit));
  const totalCredit = sum(lines.map((line) => line.credit));
  const difference = subtract(totalDebit, totalCredit);

  return { lines, totalDebit, totalCredit, difference, balanced: difference === 0 };
}

export interface PaymentAccountBalance {
  id: number;
  name: string;
  kind: string;
  provider: string | null;
  glCode: string;
  balance: Minor;
}

/** What the owner means by "how much is in cash / MoMo / the bank right now". */
export function getPaymentAccountBalances(
  db: Db,
  range: DateRange = {},
): PaymentAccountBalance[] {
  const balances = new Map(getAccountBalances(db, range).map((entry) => [entry.accountId, entry]));

  return db
    .select({
      id: paymentAccounts.id,
      name: paymentAccounts.name,
      kind: paymentAccounts.kind,
      provider: paymentAccounts.provider,
      glAccountId: paymentAccounts.glAccountId,
      sortOrder: paymentAccounts.sortOrder,
    })
    .from(paymentAccounts)
    .where(eq(paymentAccounts.isActive, true))
    .orderBy(asc(paymentAccounts.sortOrder))
    .all()
    .map((account) => {
      const ledger = balances.get(account.glAccountId);
      return {
        id: account.id,
        name: account.name,
        kind: account.kind,
        provider: account.provider,
        glCode: ledger?.code ?? '',
        balance: ledger?.balance ?? ZERO,
      };
    });
}

/**
 * Count of journal entries in the period — used to distinguish "genuinely zero"
 * from "nothing recorded yet", which are very different messages to show.
 */
export function countJournalEntries(db: Db, range: DateRange = {}): number {
  const conditions = periodConditions(range);
  const query = db.select({ count: sql<number>`COUNT(*)` }).from(journalEntries);
  const row = conditions.length > 0 ? query.where(and(...conditions)).get() : query.get();
  return row?.count ?? 0;
}
