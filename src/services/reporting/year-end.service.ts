import { and, gte, lte, sql } from 'drizzle-orm';

import { businessSettings, journalEntries } from '@/db/schema';
import type { Db } from '@/db/types';
import { minor, subtract, ZERO, type Minor } from '@/domain/money';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import {
  financialYear,
  financialYearsBetween,
  previousFinancialYear,
  type FinancialYear,
} from '@/domain/financial-year';
import { getSettings } from '@/services/settings.service';
import { toBusinessDate } from '@/lib/format';
import {
  getBalanceSheet,
  getCashFlow,
  getProfitAndLoss,
  type BalanceSheet,
  type CashFlow,
  type ProfitAndLoss,
} from './financial.service';
import { getAccountBalances, getTrialBalance, type TrialBalance } from './balances.service';
import {
  checkBooksIntegrity,
  getPayablesAgeing,
  getReceivablesAgeing,
  type AgeingRow,
  type BooksIntegrity,
} from './ledger.service';

/**
 * The year-end pack an accountant is handed.
 *
 * It composes the statements that already exist rather than recomputing
 * anything: if the pack disagreed with the on-screen Profit & Loss, one of them
 * would be wrong, and there would be no way to tell which. Everything here is
 * therefore a call into the same reporting services the app uses all year.
 *
 * What it adds is what an accountant needs and a shop owner does not: a fixed
 * period, prior-year comparatives, the movement in the owner's stake, and an
 * honest statement of the basis the figures were prepared on.
 */

export interface EquityMovement {
  openingEquity: Minor;
  capitalIntroduced: Minor;
  drawings: Minor;
  /**
   * Movement in Opening Balance Equity — the account used when stock or a bank
   * balance is entered as a starting position rather than bought or earned.
   *
   * Easy to leave out, and leaving it out is wrong: a shop that enters its
   * opening stock partway through the year increases the owner's stake without
   * any capital being introduced and without it passing through profit. Omitted
   * from this statement, that appears as an unexplained difference.
   */
  openingBalancesRecognised: Minor;
  profitForYear: Minor;
  closingEquity: Minor;
  /** Opening + capital − drawings + opening balances + profit, exactly. */
  reconciles: boolean;
  difference: Minor;
}

export interface YearEndPack {
  year: FinancialYear;
  previous: FinancialYear;

  shop: {
    name: string;
    address: string | null;
    phone: string | null;
    email: string | null;
    currencyCode: string;
  };

  profitAndLoss: ProfitAndLoss;
  previousProfitAndLoss: ProfitAndLoss;
  balanceSheet: BalanceSheet;
  previousBalanceSheet: BalanceSheet;
  cashFlow: CashFlow;
  trialBalance: TrialBalance;

  receivables: AgeingRow[];
  payables: AgeingRow[];

  equity: EquityMovement;
  integrity: BooksIntegrity;

  /** Entries dated inside the year — what the statements are drawn from. */
  entryCount: number;
  /** True when the books are closed to at least the year end. */
  isLocked: boolean;
  booksLockedBefore: string | null;
  /** True when the year has not finished yet: the pack is then provisional. */
  isProvisional: boolean;
}

/** The financial years the shop actually has entries in, newest first. */
export function availableFinancialYears(db: Db): FinancialYear[] {
  const startMonth = getSettings(db).financialYearStartMonth;

  const span = db
    .select({
      earliest: sql<string | null>`MIN(${journalEntries.entryDate})`,
      latest: sql<string | null>`MAX(${journalEntries.entryDate})`,
    })
    .from(journalEntries)
    .get();

  if (!span?.earliest || !span.latest) {
    // Nothing posted yet. Offer the year we are in, so the page still works.
    const today = toBusinessDate();
    return [financialYearsBetween(today, today, startMonth)[0] as FinancialYear];
  }

  return financialYearsBetween(span.earliest, span.latest, startMonth);
}

function countEntriesIn(db: Db, year: FinancialYear): number {
  const row = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(journalEntries)
    .where(and(gte(journalEntries.entryDate, year.start), lte(journalEntries.entryDate, year.end)))
    .get();
  return row?.count ?? 0;
}

/**
 * What the owner took out of the shop during the year.
 *
 * Read from the movement on the drawings account within the year, NOT from the
 * difference between two balance-sheet snapshots. Closing a year sweeps
 * drawings into retained earnings, so the account finishes the year at zero:
 * a snapshot comparison reports that nothing was taken out the moment the year
 * is closed — and the year-end pack is precisely the document an owner opens
 * after closing.
 *
 * The closing entry itself is excluded for the same reason. Counting it would
 * cancel out the very movements being measured.
 */
function drawingsDuringYear(db: Db, year: FinancialYear): Minor {
  const row = getAccountBalances(db, {
    from: year.start,
    to: year.end,
    excludeClosing: true,
  }).find((account) => account.code === ACCOUNT_CODES.OWNERS_DRAWINGS);

  return row?.balance ?? ZERO;
}

/**
 * How the owner's stake moved over the year.
 *
 * The balance sheet shows where equity stands on a date; it does not show what
 * *this year* did to it. This does, and it is checked to tie back exactly — a
 * pack that does not reconcile says so on its face rather than presenting tidy
 * figures that do not add up.
 */
function equityMovement(
  opening: BalanceSheet,
  closing: BalanceSheet,
  profitForYear: Minor,
  drawings: Minor,
): EquityMovement {
  const capitalIntroduced = subtract(closing.ownersCapital, opening.ownersCapital);
  const openingBalancesRecognised = subtract(
    closing.openingBalanceEquity,
    opening.openingBalanceEquity,
  );

  const expected = minor(
    opening.totalEquity + capitalIntroduced - drawings + openingBalancesRecognised + profitForYear,
  );
  const difference = subtract(closing.totalEquity, expected);

  return {
    openingEquity: opening.totalEquity,
    capitalIntroduced,
    drawings,
    openingBalancesRecognised,
    profitForYear,
    closingEquity: closing.totalEquity,
    reconciles: difference === 0,
    difference,
  };
}

export function getYearEndPack(db: Db, startYear: number): YearEndPack {
  const settings = getSettings(db);
  const startMonth = settings.financialYearStartMonth;

  const year = financialYear(startYear, startMonth);
  const previous = previousFinancialYear(year, startMonth);

  const period = { from: year.start, to: year.end };
  const previousPeriod = { from: previous.start, to: previous.end };

  const profitAndLoss = getProfitAndLoss(db, period);
  const previousProfitAndLoss = getProfitAndLoss(db, previousPeriod);

  const balanceSheet = getBalanceSheet(db, year.end);
  // The opening position is the closing position of the day before, which is
  // the previous year's end — not the first day of this one.
  const previousBalanceSheet = getBalanceSheet(db, previous.end);

  const lockedBefore = db
    .select({ lockedBefore: businessSettings.booksLockedBefore })
    .from(businessSettings)
    .get()?.lockedBefore ?? null;

  // The shop's local day, not UTC. `toISOString()` would give the UTC date,
  // which east of UTC is tomorrow for part of every evening — and would mark a
  // finished year as still in progress, or the reverse.
  const today = toBusinessDate();

  return {
    year,
    previous,
    shop: {
      name: settings.businessName,
      address: settings.address,
      phone: settings.phone,
      email: settings.email,
      currencyCode: settings.currencyCode,
    },
    profitAndLoss,
    previousProfitAndLoss,
    balanceSheet,
    previousBalanceSheet,
    cashFlow: getCashFlow(db, period),
    trialBalance: getTrialBalance(db, { to: year.end }),
    receivables: getReceivablesAgeing(db, year.end),
    payables: getPayablesAgeing(db, year.end),
    equity: equityMovement(
      previousBalanceSheet,
      balanceSheet,
      profitAndLoss.netProfit,
      drawingsDuringYear(db, year),
    ),
    integrity: checkBooksIntegrity(db),
    entryCount: countEntriesIn(db, year),
    isLocked: lockedBefore !== null && lockedBefore >= year.end,
    booksLockedBefore: lockedBefore,
    // A pack for a year still in progress is a draft, and must say so rather
    // than looking like final accounts.
    isProvisional: today <= year.end,
  };
}
