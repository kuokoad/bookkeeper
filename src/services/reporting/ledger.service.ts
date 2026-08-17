import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';

import type { Db } from '@/db/types';
import {
  accounts,
  customers,
  journalEntries,
  journalLines,
  purchases,
  sales,
  suppliers,
} from '@/db/schema';
import type { AccountType } from '@/db/schema/accounting';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { signedBalance } from '@/domain/accounting/journal';
import { minor, subtract, sum, type Minor } from '@/domain/money';
import { NotFoundError } from '@/domain/errors';
import { getOutstandingBySale } from '../sale.service';
import { getOutstandingByPurchase } from '../purchase.service';

/**
 * Reading the books.
 *
 * Everything here is read-only and derived. These are the screens that make the
 * application auditable: the chart of accounts, the journal, the trial balance
 * and the general ledger all read the same `journal_lines` that every business
 * transaction writes, so what an auditor sees is what actually happened.
 */

export interface DateRange {
  from?: string;
  to?: string;
}

// --- chart of accounts ----------------------------------------------------

export interface ChartAccount {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  parentId: number | null;
  isHeader: boolean;
  isSystem: boolean;
  isActive: boolean;
  depth: number;
  totalDebit: Minor;
  totalCredit: Minor;
  /** Sign-adjusted for the account type. */
  balance: Minor;
  /** Balance including every descendant — what a heading shows. */
  rollup: Minor;
  entryCount: number;
}

/**
 * The chart of accounts with balances, ordered as a tree.
 *
 * Headings show a rolled-up total of everything beneath them; leaves show their
 * own balance. Both are computed from the ledger, never stored.
 */
export function getChartOfAccounts(db: Db, range: DateRange = {}): ChartAccount[] {
  const conditions: SQL[] = [];
  if (range.from) conditions.push(gte(journalEntries.entryDate, range.from));
  if (range.to) conditions.push(lte(journalEntries.entryDate, range.to));

  const rows = db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      parentId: accounts.parentId,
      isSystem: accounts.isSystem,
      isActive: accounts.isActive,
      sortOrder: accounts.sortOrder,
      totalDebit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      totalCredit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
      entryCount: sql<number>`COUNT(${journalLines.id})`,
    })
    .from(accounts)
    .leftJoin(journalLines, eq(journalLines.accountId, accounts.id))
    .leftJoin(
      journalEntries,
      conditions.length > 0
        ? and(eq(journalEntries.id, journalLines.entryId), ...conditions)
        : eq(journalEntries.id, journalLines.entryId),
    )
    // A line whose entry fell outside the period must not contribute.
    .where(
      conditions.length === 0
        ? undefined
        : sql`${journalLines.id} IS NULL OR ${journalEntries.id} IS NOT NULL`,
    )
    .groupBy(accounts.id)
    .orderBy(asc(accounts.sortOrder), asc(accounts.code))
    .all();

  const byId = new Map(rows.map((row) => [row.id, row]));
  const childrenOf = new Map<number | null, typeof rows>();
  for (const row of rows) {
    const list = childrenOf.get(row.parentId) ?? [];
    list.push(row);
    childrenOf.set(row.parentId, list);
  }

  /** Balance of an account plus everything beneath it, in raw minor units. */
  function rollupOf(id: number): number {
    const row = byId.get(id);
    if (!row) return 0;
    let total = signedBalance(row.type, minor(row.totalDebit), minor(row.totalCredit)) as number;
    for (const child of childrenOf.get(id) ?? []) {
      total += rollupOf(child.id);
    }
    return total;
  }

  const ordered: ChartAccount[] = [];

  function walk(parentId: number | null, depth: number): void {
    for (const row of childrenOf.get(parentId) ?? []) {
      const children = childrenOf.get(row.id) ?? [];
      const totalDebit = minor(row.totalDebit);
      const totalCredit = minor(row.totalCredit);

      ordered.push({
        id: row.id,
        code: row.code,
        name: row.name,
        type: row.type,
        parentId: row.parentId,
        isHeader: children.length > 0,
        isSystem: row.isSystem,
        isActive: row.isActive,
        depth,
        totalDebit,
        totalCredit,
        balance: signedBalance(row.type, totalDebit, totalCredit),
        rollup: minor(rollupOf(row.id)),
        entryCount: row.entryCount,
      });

      walk(row.id, depth + 1);
    }
  }

  walk(null, 0);
  return ordered;
}

// --- journal --------------------------------------------------------------

export interface JournalEntrySummary {
  id: number;
  entryNo: string;
  entryDate: string;
  occurredAt: Date;
  sourceType: string;
  sourceId: number | null;
  memo: string | null;
  isOpening: boolean;
  reversesEntryId: number | null;
  reversedByEntryId: number | null;
  lineCount: number;
  total: Minor;
  balanced: boolean;
}

export interface JournalQuery extends DateRange {
  sourceType?: string;
  accountId?: number;
  limit?: number;
  offset?: number;
}

/**
 * NOTE ON CORRELATED SUBQUERIES.
 *
 * Drizzle only qualifies column names with their table when the outer query
 * has a JOIN. In a single-table query it emits bare names, so a correlated
 * subquery like
 *
 *   (SELECT SUM(debit_minor) FROM journal_lines WHERE entry_id = id)
 *
 * silently binds `id` to the SUBQUERY's table and returns nonsense rather than
 * failing. Aggregates here are therefore built with JOIN + GROUP BY, which
 * drizzle qualifies correctly and which is faster besides.
 */
export function listJournalEntries(db: Db, query: JournalQuery = {}): JournalEntrySummary[] {
  const conditions: SQL[] = [];
  if (query.from) conditions.push(gte(journalEntries.entryDate, query.from));
  if (query.to) conditions.push(lte(journalEntries.entryDate, query.to));
  if (query.sourceType) conditions.push(eq(journalEntries.sourceType, query.sourceType as never));

  if (query.accountId !== undefined) {
    // Which entries touch this account, resolved separately so the account
    // filter cannot distort the per-entry totals below.
    const entryIds = db
      .selectDistinct({ entryId: journalLines.entryId })
      .from(journalLines)
      .where(eq(journalLines.accountId, query.accountId))
      .all()
      .map((row) => row.entryId);

    if (entryIds.length === 0) return [];
    conditions.push(inArray(journalEntries.id, entryIds));
  }

  // Page FIRST, then total only the page.
  //
  // Joining the lines before the LIMIT forces SQLite to group every entry in
  // history to produce fifty rows — measured at 314ms across a year of trading,
  // and getting slower every year the shop stays open. Selecting the page from
  // `journal_entries` alone uses the date index and touches fifty rows; the
  // totals are then a second query bounded by that same page.
  const base = db
    .select({
      id: journalEntries.id,
      entryNo: journalEntries.entryNo,
      entryDate: journalEntries.entryDate,
      occurredAt: journalEntries.occurredAt,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      memo: journalEntries.memo,
      isOpening: journalEntries.isOpening,
      reversesEntryId: journalEntries.reversesEntryId,
      reversedByEntryId: journalEntries.reversedByEntryId,
    })
    .from(journalEntries);

  const page = (conditions.length > 0 ? base.where(and(...conditions)) : base)
    .orderBy(desc(journalEntries.entryDate), desc(journalEntries.id))
    .limit(Math.min(query.limit ?? 100, 500))
    .offset(query.offset ?? 0)
    .all();

  if (page.length === 0) return [];

  // One aggregate over just this page's entries. Single-table with an explicit
  // GROUP BY and no correlated subquery, so the unqualified-column trap above
  // does not apply.
  const totals = new Map<number, { lineCount: number; debit: number; credit: number }>();
  for (const row of db
    .select({
      entryId: journalLines.entryId,
      lineCount: sql<number>`COUNT(*)`,
      totalDebit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      totalCredit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .where(inArray(journalLines.entryId, page.map((entry) => entry.id)))
    .groupBy(journalLines.entryId)
    .all()) {
    totals.set(row.entryId, {
      lineCount: row.lineCount,
      debit: row.totalDebit,
      credit: row.totalCredit,
    });
  }

  return page
    .map((entry) => {
      // An entry with no lines cannot exist, but if one ever did it must show
      // as zero rather than vanish from the list.
      const total = totals.get(entry.id) ?? { lineCount: 0, debit: 0, credit: 0 };
      return { ...entry, lineCount: total.lineCount, totalDebit: total.debit, totalCredit: total.credit };
    })
    .map((row) => ({
      id: row.id,
      entryNo: row.entryNo,
      entryDate: row.entryDate,
      occurredAt: row.occurredAt,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      memo: row.memo,
      isOpening: row.isOpening,
      reversesEntryId: row.reversesEntryId,
      reversedByEntryId: row.reversedByEntryId,
      lineCount: row.lineCount,
      total: minor(row.totalDebit),
      // Shown per row so an unbalanced entry could never hide in a long list.
      balanced: row.totalDebit === row.totalCredit,
    }));
}

export function getJournalEntry(db: Db, entryId: number) {
  const entry = db.select().from(journalEntries).where(eq(journalEntries.id, entryId)).get();
  if (!entry) throw new NotFoundError('Journal entry', entryId);

  const lines = db
    .select({
      id: journalLines.id,
      lineNo: journalLines.lineNo,
      accountId: journalLines.accountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      accountType: accounts.type,
      debit: journalLines.debitMinor,
      credit: journalLines.creditMinor,
      description: journalLines.description,
      customerId: journalLines.customerId,
      customerName: customers.name,
      supplierId: journalLines.supplierId,
      supplierName: suppliers.name,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .leftJoin(customers, eq(customers.id, journalLines.customerId))
    .leftJoin(suppliers, eq(suppliers.id, journalLines.supplierId))
    .where(eq(journalLines.entryId, entryId))
    .orderBy(asc(journalLines.lineNo))
    .all();

  const totalDebit = sum(lines.map((line) => minor(line.debit)));
  const totalCredit = sum(lines.map((line) => minor(line.credit)));

  return { entry, lines, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

// --- general ledger -------------------------------------------------------

export interface LedgerLine {
  entryId: number;
  entryNo: string;
  entryDate: string;
  sourceType: string;
  sourceId: number | null;
  memo: string | null;
  description: string | null;
  debit: Minor;
  credit: Minor;
  /** Signed for the account type, so it reads the way a human expects. */
  runningBalance: Minor;
}

export interface GeneralLedger {
  account: ChartAccount;
  openingBalance: Minor;
  lines: LedgerLine[];
  closingBalance: Minor;
  totalDebit: Minor;
  totalCredit: Minor;
}

/**
 * Every movement on one account, with an opening balance and a running total.
 *
 * This is the screen that proves any figure on any report: pick the account,
 * see the exact lines that produced its balance.
 */
export function getGeneralLedger(db: Db, accountId: number, range: DateRange = {}): GeneralLedger {
  const chart = getChartOfAccounts(db);
  const account = chart.find((entry) => entry.id === accountId);
  if (!account) throw new NotFoundError('Account', accountId);

  // Opening balance = everything before the period starts.
  let openingBalance = minor(0);
  if (range.from) {
    const before = db
      .select({
        debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
        credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(
        and(eq(journalLines.accountId, accountId), sql`${journalEntries.entryDate} < ${range.from}`),
      )
      .get();
    openingBalance = signedBalance(
      account.type,
      minor(before?.debit ?? 0),
      minor(before?.credit ?? 0),
    );
  }

  const conditions: SQL[] = [eq(journalLines.accountId, accountId)];
  if (range.from) conditions.push(gte(journalEntries.entryDate, range.from));
  if (range.to) conditions.push(lte(journalEntries.entryDate, range.to));

  const rows = db
    .select({
      entryId: journalEntries.id,
      entryNo: journalEntries.entryNo,
      entryDate: journalEntries.entryDate,
      occurredAt: journalEntries.occurredAt,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      memo: journalEntries.memo,
      description: journalLines.description,
      debit: journalLines.debitMinor,
      credit: journalLines.creditMinor,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...conditions))
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.id), asc(journalLines.lineNo))
    .all();

  let running = openingBalance as number;
  const lines: LedgerLine[] = rows.map((row) => {
    // A debit increases a debit-normal account and decreases a credit-normal one.
    const movement =
      signedBalance(account.type, minor(row.debit), minor(row.credit)) as number;
    running += movement;
    return {
      entryId: row.entryId,
      entryNo: row.entryNo,
      entryDate: row.entryDate,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      memo: row.memo,
      description: row.description,
      debit: minor(row.debit),
      credit: minor(row.credit),
      runningBalance: minor(running),
    };
  });

  return {
    account,
    openingBalance,
    lines,
    closingBalance: minor(running),
    totalDebit: sum(lines.map((line) => line.debit)),
    totalCredit: sum(lines.map((line) => line.credit)),
  };
}

// --- receivables and payables ageing --------------------------------------

export interface AgeingBucket {
  label: string;
  amount: Minor;
}

export interface AgeingRow {
  partyId: number;
  partyName: string;
  phone: string | null;
  total: Minor;
  current: Minor;
  days1to30: Minor;
  days31to60: Minor;
  days61to90: Minor;
  over90: Minor;
  oldestDate: string | null;
}

function bucketFor(days: number): keyof Pick<
  AgeingRow,
  'current' | 'days1to30' | 'days31to60' | 'days61to90' | 'over90'
> {
  if (days <= 0) return 'current';
  if (days <= 30) return 'days1to30';
  if (days <= 60) return 'days31to60';
  if (days <= 90) return 'days61to90';
  return 'over90';
}

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const start = Date.UTC(fy ?? 1970, (fm ?? 1) - 1, fd ?? 1);
  const end = Date.UTC(ty ?? 1970, (tm ?? 1) - 1, td ?? 1);
  return Math.round((end - start) / 86_400_000);
}

/**
 * How long money has been owed.
 *
 * Ageing is measured from the date of the sale or purchase, so "over 90 days"
 * means what a shop owner means by it. Amounts come from the same
 * `getSaleOutstanding` / `getPurchaseOutstanding` used everywhere else, so the
 * ageing report and the customer's profile always agree.
 */
export function getReceivablesAgeing(db: Db, asAt: string): AgeingRow[] {
  const rows = db
    .select({
      saleId: sales.id,
      businessDate: sales.businessDate,
      customerId: sales.customerId,
      customerName: customers.name,
      phone: customers.phone,
    })
    .from(sales)
    .innerJoin(customers, eq(customers.id, sales.customerId))
    .where(and(eq(sales.status, 'POSTED'), lte(sales.businessDate, asAt)))
    .orderBy(asc(sales.businessDate))
    .all();

  // One grouped query for every sale's outstanding amount, rather than three
  // queries per sale. At a few hundred credit sales the difference is the
  // report loading instantly versus visibly hanging.
  const outstandingBySale = getOutstandingBySale(db);
  const byParty = new Map<number, AgeingRow>();

  for (const row of rows) {
    if (row.customerId === null) continue;
    const outstanding = outstandingBySale.get(row.saleId) ?? minor(0);
    if (outstanding <= 0) continue;

    const existing =
      byParty.get(row.customerId) ??
      ({
        partyId: row.customerId,
        partyName: row.customerName,
        phone: row.phone,
        total: minor(0),
        current: minor(0),
        days1to30: minor(0),
        days31to60: minor(0),
        days61to90: minor(0),
        over90: minor(0),
        oldestDate: null,
      } as AgeingRow);

    const bucket = bucketFor(daysBetween(row.businessDate, asAt));
    existing[bucket] = minor((existing[bucket] as number) + outstanding);
    existing.total = minor((existing.total as number) + outstanding);
    if (existing.oldestDate === null || row.businessDate < existing.oldestDate) {
      existing.oldestDate = row.businessDate;
    }

    byParty.set(row.customerId, existing);
  }

  return [...byParty.values()].sort((a, b) => b.total - a.total);
}

export function getPayablesAgeing(db: Db, asAt: string): AgeingRow[] {
  const rows = db
    .select({
      purchaseId: purchases.id,
      businessDate: purchases.businessDate,
      supplierId: purchases.supplierId,
      supplierName: suppliers.name,
      phone: suppliers.phone,
    })
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .where(and(eq(purchases.status, 'POSTED'), lte(purchases.businessDate, asAt)))
    .orderBy(asc(purchases.businessDate))
    .all();

  const outstandingByPurchase = getOutstandingByPurchase(db);
  const byParty = new Map<number, AgeingRow>();

  for (const row of rows) {
    if (row.supplierId === null) continue;
    const outstanding = outstandingByPurchase.get(row.purchaseId) ?? minor(0);
    if (outstanding <= 0) continue;

    const existing =
      byParty.get(row.supplierId) ??
      ({
        partyId: row.supplierId,
        partyName: row.supplierName,
        phone: row.phone,
        total: minor(0),
        current: minor(0),
        days1to30: minor(0),
        days31to60: minor(0),
        days61to90: minor(0),
        over90: minor(0),
        oldestDate: null,
      } as AgeingRow);

    const bucket = bucketFor(daysBetween(row.businessDate, asAt));
    existing[bucket] = minor((existing[bucket] as number) + outstanding);
    existing.total = minor((existing.total as number) + outstanding);
    if (existing.oldestDate === null || row.businessDate < existing.oldestDate) {
      existing.oldestDate = row.businessDate;
    }

    byParty.set(row.supplierId, existing);
  }

  return [...byParty.values()].sort((a, b) => b.total - a.total);
}

// --- integrity ------------------------------------------------------------

export interface BooksIntegrity {
  trialBalanced: boolean;
  totalDebit: Minor;
  totalCredit: Minor;
  difference: Minor;
  unbalancedEntries: { id: number; entryNo: string; difference: Minor }[];
  receivablesMatch: boolean;
  payablesMatch: boolean;
  untracedEntries: number;
}

/**
 * A single health check over the whole ledger.
 *
 * Every one of these SHOULD be impossible given the write-time assertions. This
 * exists so that if one ever is not, the owner is told plainly rather than
 * shown a tidy report built on broken data.
 */
export function checkBooksIntegrity(db: Db): BooksIntegrity {
  const totals = db
    .select({
      debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .get();

  const totalDebit = minor(totals?.debit ?? 0);
  const totalCredit = minor(totals?.credit ?? 0);

  // JOIN + GROUP BY, not a correlated subquery — see the note on
  // listJournalEntries for why.
  const unbalanced = db
    .select({
      id: journalEntries.id,
      entryNo: journalEntries.entryNo,
      debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
    })
    .from(journalEntries)
    .leftJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
    .groupBy(journalEntries.id)
    .all()
    .filter((row) => row.debit !== row.credit)
    .map((row) => ({
      id: row.id,
      entryNo: row.entryNo,
      difference: subtract(minor(row.debit), minor(row.credit)),
    }));

  // Subledger totals must equal their control accounts.
  const control = (code: string, creditNormal: boolean): number => {
    const row = db
      .select({
        debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
        credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
      })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(eq(accounts.code, code))
      .get();
    return creditNormal ? (row?.credit ?? 0) - (row?.debit ?? 0) : (row?.debit ?? 0) - (row?.credit ?? 0);
  };

  const tagged = (code: string, column: 'customerId' | 'supplierId', creditNormal: boolean): number => {
    const row = db
      .select({
        debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
        credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
      })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(
        and(
          eq(accounts.code, code),
          column === 'customerId'
            ? sql`${journalLines.customerId} IS NOT NULL`
            : sql`${journalLines.supplierId} IS NOT NULL`,
        ),
      )
      .get();
    return creditNormal ? (row?.credit ?? 0) - (row?.debit ?? 0) : (row?.debit ?? 0) - (row?.credit ?? 0);
  };

  const untraced = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(journalEntries)
    .where(
      sql`${journalEntries.sourceId} IS NULL AND ${journalEntries.sourceType} <> 'OPENING_BALANCE'`,
    )
    .get();

  return {
    trialBalanced: totalDebit === totalCredit,
    totalDebit,
    totalCredit,
    difference: subtract(totalDebit, totalCredit),
    unbalancedEntries: unbalanced,
    receivablesMatch:
      control(ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, false) ===
      tagged(ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, 'customerId', false),
    payablesMatch:
      control(ACCOUNT_CODES.ACCOUNTS_PAYABLE, true) ===
      tagged(ACCOUNT_CODES.ACCOUNTS_PAYABLE, 'supplierId', true),
    untracedEntries: untraced?.count ?? 0,
  };
}
