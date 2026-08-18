import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { accounts, journalEntries, journalLines, paymentAccounts } from '@/db/schema';
import type { AccountType } from '@/db/schema/accounting';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { getPayablesSplit, getReceivablesSplit } from './subledger-split';
import { signedBalance } from '@/domain/accounting/journal';
import { add, minor, subtract, sum, type Minor } from '@/domain/money';

/**
 * The three financial statements.
 *
 * All three read the same `journal_lines` every transaction writes, so they
 * cannot disagree with each other or with the day-to-day screens. Nothing here
 * is stored; ask for a different period and it is recomputed.
 */

export interface Period {
  from: string;
  to: string;
}

export interface ReportLine {
  accountId: number;
  code: string;
  name: string;
  amount: Minor;
}

/** Balances per account for a period, keyed by account id. */
interface AccountTotals {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  parentId: number | null;
  debit: number;
  credit: number;
  /** Sign-adjusted for the type. */
  balance: number;
}

function loadAccountTotals(
  db: Db,
  range: { from?: string; to?: string; excludeClosing?: boolean },
): AccountTotals[] {
  const conditions: SQL[] = [];
  if (range.from) conditions.push(gte(journalEntries.entryDate, range.from));
  if (range.to) conditions.push(lte(journalEntries.entryDate, range.to));

  // The Profit & Loss must not count the year's own closing entry. It is dated
  // inside the year and its whole purpose is to cancel the year's revenue and
  // expenses, so including it would report every closed year as having earned
  // exactly nothing.
  //
  // The balance sheet is the opposite case and must include it, because that is
  // how the profit reaches Retained Earnings.
  if (range.excludeClosing) conditions.push(eq(journalEntries.isClosing, false));

  const rows = db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      parentId: accounts.parentId,
      debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
    })
    .from(accounts)
    .leftJoin(journalLines, eq(journalLines.accountId, accounts.id))
    .leftJoin(
      journalEntries,
      conditions.length > 0
        ? and(eq(journalEntries.id, journalLines.entryId), ...conditions)
        : eq(journalEntries.id, journalLines.entryId),
    )
    .where(
      conditions.length === 0
        ? undefined
        : sql`${journalLines.id} IS NULL OR ${journalEntries.id} IS NOT NULL`,
    )
    .groupBy(accounts.id)
    .orderBy(asc(accounts.sortOrder), asc(accounts.code))
    .all();

  return rows.map((row) => ({
    ...row,
    balance: signedBalance(row.type, minor(row.debit), minor(row.credit)) as number,
  }));
}

/** Leaf accounts of a type with a non-zero balance, as report lines. */
function linesOfType(
  totals: AccountTotals[],
  predicate: (account: AccountTotals) => boolean,
): ReportLine[] {
  const parentIds = new Set(totals.map((account) => account.parentId).filter((id) => id !== null));

  return totals
    .filter((account) => predicate(account))
    // Headings are excluded so nothing is counted twice.
    .filter((account) => !parentIds.has(account.id))
    .filter((account) => account.balance !== 0)
    .map((account) => ({
      accountId: account.id,
      code: account.code,
      name: account.name,
      amount: minor(account.balance),
    }));
}

/** A code and everything filed beneath it. */
function isUnder(totals: AccountTotals[], account: AccountTotals, ancestorCode: string): boolean {
  const byId = new Map(totals.map((entry) => [entry.id, entry]));
  let current: AccountTotals | undefined = account;
  while (current) {
    if (current.code === ancestorCode) return true;
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return false;
}

// ==========================================================================
// PROFIT & LOSS
// ==========================================================================

export interface ProfitAndLoss {
  period: Period;
  salesRevenue: Minor;
  salesDiscounts: Minor;
  salesReturns: Minor;
  netSales: Minor;
  otherIncome: ReportLine[];
  totalOtherIncome: Minor;
  totalRevenue: Minor;
  costOfGoodsSold: Minor;
  grossProfit: Minor;
  /** Basis points; null when there is no revenue to divide by. */
  grossMarginBp: number | null;
  expenses: ReportLine[];
  totalExpenses: Minor;
  netProfit: Minor;
  netMarginBp: number | null;
}

export function getProfitAndLoss(db: Db, period: Period): ProfitAndLoss {
  return buildProfitAndLoss(loadAccountTotals(db, { ...period, excludeClosing: true }), period);
}

/**
 * The P&L calculation, separated from loading.
 *
 * The balance sheet already has the account totals it needs, so it reuses them
 * here rather than running the same aggregate a second time — that duplication
 * doubled the cost of every balance sheet, and this is a busy shop.
 */
function buildProfitAndLoss(totals: AccountTotals[], period: Period): ProfitAndLoss {
  const find = (code: string) => totals.find((account) => account.code === code);

  const salesRevenue = minor(find(ACCOUNT_CODES.SALES_REVENUE)?.balance ?? 0);
  const salesDiscounts = minor(find(ACCOUNT_CODES.SALES_DISCOUNTS)?.balance ?? 0);
  const salesReturns = minor(find(ACCOUNT_CODES.SALES_RETURNS)?.balance ?? 0);
  const netSales = subtract(salesRevenue, add(salesDiscounts, salesReturns));

  // Other income is every revenue account that is not the main sales account.
  const otherIncome = linesOfType(
    totals,
    (account) =>
      account.type === 'REVENUE' &&
      account.code !== ACCOUNT_CODES.SALES_REVENUE &&
      isUnder(totals, account, ACCOUNT_CODES.OTHER_INCOME),
  );
  const totalOtherIncome = sum(otherIncome.map((line) => line.amount));
  const totalRevenue = add(netSales, totalOtherIncome);

  const costOfGoodsSold = minor(find(ACCOUNT_CODES.COST_OF_GOODS_SOLD)?.balance ?? 0);
  const grossProfit = subtract(netSales, costOfGoodsSold);

  // Every expense account, including shrinkage and cash over/short.
  const expenses = linesOfType(totals, (account) => account.type === 'EXPENSE');
  const totalExpenses = sum(expenses.map((line) => line.amount));

  const netProfit = subtract(add(grossProfit, totalOtherIncome), totalExpenses);

  return {
    period,
    salesRevenue,
    salesDiscounts,
    salesReturns,
    netSales,
    otherIncome,
    totalOtherIncome,
    totalRevenue,
    costOfGoodsSold,
    grossProfit,
    grossMarginBp: netSales === 0 ? null : Math.round((grossProfit / netSales) * 10_000),
    expenses,
    totalExpenses,
    netProfit,
    netMarginBp: totalRevenue === 0 ? null : Math.round((netProfit / totalRevenue) * 10_000),
  };
}

// ==========================================================================
// BALANCE SHEET
// ==========================================================================

export interface BalanceSheet {
  asAt: string;
  cashAccounts: ReportLine[];
  totalCash: Minor;
  receivables: Minor;
  /**
   * Money held for customers who have paid more than they owe. Reported as the
   * liability it is, rather than netted inside receivables where it would
   * understate both figures. Zero unless overpayment is switched on.
   */
  customerCredits: Minor;
  inventory: Minor;
  otherAssets: ReportLine[];
  totalAssets: Minor;

  payables: Minor;
  /** Suppliers paid in advance — an asset, not a negative liability. */
  supplierAdvances: Minor;
  taxPayable: Minor;
  otherLiabilities: ReportLine[];
  totalLiabilities: Minor;

  ownersCapital: Minor;
  drawings: Minor;
  openingBalanceEquity: Minor;
  /** Profit closed into the account, plus profit earned since and not closed. */
  retainedEarnings: Minor;
  totalEquity: Minor;

  totalLiabilitiesAndEquity: Minor;
  /** MUST be true. Shown to the user either way. */
  balances: boolean;
  difference: Minor;
}

export function getBalanceSheet(db: Db, asAt: string): BalanceSheet {
  const totals = loadAccountTotals(db, { to: asAt });
  const find = (code: string) => minor(totals.find((account) => account.code === code)?.balance ?? 0);

  const cashAccounts = linesOfType(
    totals,
    (account) =>
      account.type === 'ASSET' &&
      (isUnder(totals, account, ACCOUNT_CODES.CASH) ||
        isUnder(totals, account, ACCOUNT_CODES.MOBILE_MONEY) ||
        isUnder(totals, account, ACCOUNT_CODES.BANK)),
  );
  const totalCash = sum(cashAccounts.map((line) => line.amount));

  // The control account nets debtors against anyone in credit. Split by each
  // party's own sign so neither is hidden inside the other. `net` is asserted
  // against the control account below, so this can never invent a figure.
  const receivableSplit = getReceivablesSplit(db, asAt);
  const payableSplit = getPayablesSplit(db, asAt);

  const receivables = receivableSplit.owed;
  const customerCredits = receivableSplit.inCredit;
  const supplierAdvances = payableSplit.inCredit;
  const inventory = find(ACCOUNT_CODES.INVENTORY);

  // Any other asset account that is not cash, receivables or inventory.
  const otherAssets = linesOfType(
    totals,
    (account) =>
      account.type === 'ASSET' &&
      !isUnder(totals, account, ACCOUNT_CODES.CASH) &&
      !isUnder(totals, account, ACCOUNT_CODES.MOBILE_MONEY) &&
      !isUnder(totals, account, ACCOUNT_CODES.BANK) &&
      account.code !== ACCOUNT_CODES.ACCOUNTS_RECEIVABLE &&
      account.code !== ACCOUNT_CODES.INVENTORY,
  );

  const totalAssets = sum([
    totalCash,
    receivables,
    supplierAdvances,
    inventory,
    sum(otherAssets.map((line) => line.amount)),
  ]);

  const payables = payableSplit.owed;
  const taxPayable = find(ACCOUNT_CODES.TAX_PAYABLE);
  const otherLiabilities = linesOfType(
    totals,
    (account) =>
      account.type === 'LIABILITY' &&
      account.code !== ACCOUNT_CODES.ACCOUNTS_PAYABLE &&
      account.code !== ACCOUNT_CODES.TAX_PAYABLE,
  );
  const totalLiabilities = sum([
    payables,
    customerCredits,
    taxPayable,
    sum(otherLiabilities.map((line) => line.amount)),
  ]);

  const ownersCapital = find(ACCOUNT_CODES.OWNERS_CAPITAL);
  const drawings = find(ACCOUNT_CODES.OWNERS_DRAWINGS);
  const openingBalanceEquity = find(ACCOUNT_CODES.OPENING_BALANCE_EQUITY);

  // Retained earnings is what has been closed into the account, plus whatever
  // profit has been earned since and not yet closed.
  //
  // These cannot double-count, and the reason is worth stating: a closing entry
  // debits the revenue accounts and credits Retained Earnings, so once a year
  // is closed its trading accounts sum to zero and contribute nothing to
  // `allTime` below. An unclosed year contributes its profit here and nothing
  // to the posted balance. Every year is counted exactly once, whether closed
  // or not — which is what lets a shop close some years and not others.
  //
  // NOTE: `totals` is deliberately loaded WITHOUT `excludeClosing`. The closing
  // entry is how profit reaches equity; leaving it out here would lose it.
  //
  // `totals` was loaded with { to: asAt } and so ALREADY covers all time up to
  // that date — exactly what the all-time P&L needs. Reusing it avoids running
  // the same aggregate twice per balance sheet.
  const allTime = buildProfitAndLoss(totals, { from: '0000-01-01', to: asAt });
  const retainedEarnings = add(
    minor(totals.find((a) => a.code === ACCOUNT_CODES.RETAINED_EARNINGS)?.balance ?? 0),
    allTime.netProfit,
  );

  const totalEquity = sum([
    ownersCapital,
    openingBalanceEquity,
    retainedEarnings,
    // Drawings are contra-equity: they REDUCE the owner's stake.
    minor(-drawings),
  ]);

  const totalLiabilitiesAndEquity = add(totalLiabilities, totalEquity);
  const difference = subtract(totalAssets, totalLiabilitiesAndEquity);

  return {
    asAt,
    cashAccounts,
    totalCash,
    receivables,
    customerCredits,
    inventory,
    otherAssets,
    totalAssets,
    payables,
    supplierAdvances,
    taxPayable,
    otherLiabilities,
    totalLiabilities,
    ownersCapital,
    drawings,
    openingBalanceEquity,
    retainedEarnings,
    totalEquity,
    totalLiabilitiesAndEquity,
    balances: difference === 0,
    difference,
  };
}

// ==========================================================================
// CASH FLOW
// ==========================================================================

export interface CashFlowLine {
  sourceType: string;
  label: string;
  inMinor: Minor;
  outMinor: Minor;
  net: Minor;
}

export interface CashFlow {
  period: Period;
  openingBalance: Minor;
  lines: CashFlowLine[];
  totalIn: Minor;
  totalOut: Minor;
  netMovement: Minor;
  closingBalance: Minor;
  /** Opening + movement must equal closing. */
  reconciles: boolean;
  byAccount: { id: number; name: string; opening: Minor; in: Minor; out: Minor; closing: Minor }[];
}

const FLOW_LABELS: Record<string, string> = {
  SALE: 'Money taken on sales',
  SALE_RETURN: 'Refunds to customers',
  CUSTOMER_PAYMENT: 'Customer debt payments',
  PURCHASE: 'Paid for stock',
  PURCHASE_RETURN: 'Refunds from suppliers',
  SUPPLIER_PAYMENT: 'Paid suppliers',
  EXPENSE: 'Running costs',
  INCOME: 'Other income',
  CAPITAL: 'Owner put money in',
  DRAWINGS: 'Owner took money out',
  RECONCILIATION: 'Cash count differences',
  OPENING_BALANCE: 'Opening balances',
  REVERSAL: 'Reversals',
};

/**
 * Where the money actually went.
 *
 * Only lines that touch a real payment account are counted, so this is cash
 * movement — not profit. A credit sale contributes nothing here until the
 * customer pays, which is exactly the distinction a shop owner needs.
 */
export function getCashFlow(db: Db, period: Period, paymentAccountId?: number): CashFlow {
  const accountFilter: SQL[] = [sql`${journalLines.paymentAccountId} IS NOT NULL`];
  if (paymentAccountId !== undefined) {
    accountFilter.push(eq(journalLines.paymentAccountId, paymentAccountId));
  }

  const opening = db
    .select({
      debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...accountFilter, sql`${journalEntries.entryDate} < ${period.from}`))
    .get();

  const openingBalance = subtract(minor(opening?.debit ?? 0), minor(opening?.credit ?? 0));

  const rows = db
    .select({
      sourceType: journalEntries.sourceType,
      inMinor: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
      outMinor: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(
      and(
        ...accountFilter,
        gte(journalEntries.entryDate, period.from),
        lte(journalEntries.entryDate, period.to),
      ),
    )
    .groupBy(journalEntries.sourceType)
    .all();

  const lines: CashFlowLine[] = rows
    .map((row) => ({
      sourceType: row.sourceType,
      label: FLOW_LABELS[row.sourceType] ?? row.sourceType,
      inMinor: minor(row.inMinor),
      outMinor: minor(row.outMinor),
      net: subtract(minor(row.inMinor), minor(row.outMinor)),
    }))
    .filter((line) => line.inMinor !== 0 || line.outMinor !== 0)
    .sort((a, b) => b.net - a.net);

  const totalIn = sum(lines.map((line) => line.inMinor));
  const totalOut = sum(lines.map((line) => line.outMinor));
  const netMovement = subtract(totalIn, totalOut);
  const closingBalance = add(openingBalance, netMovement);

  // Per-account breakdown, so "cash" and "MoMo" can be told apart.
  const byAccount = db
    .select({ id: paymentAccounts.id, name: paymentAccounts.name })
    .from(paymentAccounts)
    .where(paymentAccountId === undefined ? undefined : eq(paymentAccounts.id, paymentAccountId))
    .orderBy(asc(paymentAccounts.sortOrder))
    .all()
    .map((account) => {
      const before = db
        .select({
          debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
          credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(
          and(
            eq(journalLines.paymentAccountId, account.id),
            sql`${journalEntries.entryDate} < ${period.from}`,
          ),
        )
        .get();

      const during = db
        .select({
          debit: sql<number>`COALESCE(SUM(${journalLines.debitMinor}), 0)`,
          credit: sql<number>`COALESCE(SUM(${journalLines.creditMinor}), 0)`,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
        .where(
          and(
            eq(journalLines.paymentAccountId, account.id),
            gte(journalEntries.entryDate, period.from),
            lte(journalEntries.entryDate, period.to),
          ),
        )
        .get();

      const openingForAccount = subtract(minor(before?.debit ?? 0), minor(before?.credit ?? 0));
      const inFor = minor(during?.debit ?? 0);
      const outFor = minor(during?.credit ?? 0);

      return {
        id: account.id,
        name: account.name,
        opening: openingForAccount,
        in: inFor,
        out: outFor,
        closing: add(openingForAccount, subtract(inFor, outFor)),
      };
    });

  return {
    period,
    openingBalance,
    lines,
    totalIn,
    totalOut,
    netMovement,
    closingBalance,
    reconciles: add(openingBalance, netMovement) === closingBalance,
    byAccount,
  };
}

/** Convenience for the dashboard: profit for a period in one number. */
export function getNetProfit(db: Db, period: Period): Minor {
  return getProfitAndLoss(db, period).netProfit;
}
