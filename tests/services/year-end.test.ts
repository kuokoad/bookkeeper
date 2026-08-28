import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { availableFinancialYears, getYearEndPack } from '@/services/reporting/year-end.service';
import { updateSettings, getSettings } from '@/services/settings.service';
import { postJournalEntry } from '@/services/journal.service';
import { credit, debit } from '@/domain/accounting/journal';
import { minor } from '@/domain/money';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createTestDatabase, accountIdFor, type TestDatabase } from '../helpers/test-db';
import { createUser } from '@/services/auth.service';
import { featuresFromRow } from '@/lib/business-type';

let context: TestDatabase;
let ACTOR: { id: number; username: string };

beforeEach(async () => {
  context = createTestDatabase();
  const id = await createUser(
    context.db,
    { username: 'kwame', displayName: 'Kwame Owusu', password: 'owner-password-2026', role: 'OWNER' },
    null,
  );
  ACTOR = { id, username: 'kwame' };
});

afterEach(() => {
  context.cleanup();
});

const account = (code: string) => accountIdFor(context.db, code);

/** A balanced entry on a given day. */
function post(entryDate: string, debitCode: string, creditCode: string, amount: number): void {
  postJournalEntry(
    context.db,
    {
      entryDate,
      memo: 'test entry',
      sourceType: 'OPENING_BALANCE',
      isOpening: true,
      lines: [debit(account(debitCode), minor(amount)), credit(account(creditCode), minor(amount))],
    },
    null,
  );
}

/** Owner puts money in: cash up, capital up. */
const capital = (date: string, amount: number) =>
  post(date, '1001', ACCOUNT_CODES.OWNERS_CAPITAL, amount);

/** A cash sale: cash up, revenue up. */
const sale = (date: string, amount: number) =>
  post(date, '1001', ACCOUNT_CODES.SALES_REVENUE, amount);

/** An expense paid in cash. 6010 is Rent, a postable leaf under the heading. */
const expense = (date: string, amount: number) => post(date, '6010', '1001', amount);

/** Owner takes money out. */
const drawing = (date: string, amount: number) =>
  post(date, ACCOUNT_CODES.OWNERS_DRAWINGS, '1001', amount);

function setStartMonth(month: number): void {
  const settings = getSettings(context.db);
  updateSettings(
    context.db,
    {
      businessName: settings.businessName,
    tagline: settings.tagline,
      address: settings.address,
      phone: settings.phone,
      email: settings.email,
      currencyCode: settings.currencyCode,
      currencySymbol: settings.currencySymbol,
      look: settings.look,
    businessType: settings.businessType,
    features: featuresFromRow(settings),
      taxEnabled: settings.taxEnabled,
        taxInclusive: settings.taxInclusive,
        lowStockThresholdMilli: settings.lowStockThresholdMilli,
      allowNegativeStock: settings.allowNegativeStock,
    expiryWarningDays: settings.expiryWarningDays,
    expiryBlocksSales: settings.expiryBlocksSales,
    allowOverpayment: settings.allowOverpayment,
    defaultTermsDays: settings.defaultTermsDays,
      financialYearStartMonth: month,
    },
    ACTOR,
  );
}

describe('the period covered', () => {
  it('uses the calendar year when the year starts in January', () => {
    const pack = getYearEndPack(context.db, 2025);
    expect(pack.year.start).toBe('2025-01-01');
    expect(pack.year.end).toBe('2025-12-31');
    expect(pack.previous.label).toBe('2024');
  });

  it('follows the shop\'s own financial year', () => {
    setStartMonth(4);
    const pack = getYearEndPack(context.db, 2025);
    expect(pack.year.start).toBe('2025-04-01');
    expect(pack.year.end).toBe('2026-03-31');
    expect(pack.year.label).toBe('2025/26');
  });

  it('offers only years the shop actually traded in', () => {
    sale('2024-06-01', 10_000);
    sale('2026-02-01', 10_000);

    const labels = availableFinancialYears(context.db).map((year) => year.label);
    expect(labels).toEqual(['2026', '2025', '2024']);
  });

  it('marks a year that has not finished as provisional', () => {
    // A year ending far in the future cannot be final accounts.
    const future = new Date().getFullYear() + 1;
    expect(getYearEndPack(context.db, future).isProvisional).toBe(true);
    expect(getYearEndPack(context.db, 2020).isProvisional).toBe(false);
  });
});

describe('the figures', () => {
  it('counts only what falls inside the year', () => {
    sale('2024-12-31', 50_000); // the day before
    sale('2025-01-01', 10_000); // first day
    sale('2025-12-31', 20_000); // last day
    sale('2026-01-01', 70_000); // the day after

    const pack = getYearEndPack(context.db, 2025);
    expect(pack.profitAndLoss.netSales).toBe(30_000);
    expect(pack.entryCount).toBe(2);
  });

  it('gives the prior year as a comparative', () => {
    sale('2024-06-01', 40_000);
    sale('2025-06-01', 60_000);

    const pack = getYearEndPack(context.db, 2025);
    expect(pack.profitAndLoss.netSales).toBe(60_000);
    expect(pack.previousProfitAndLoss.netSales).toBe(40_000);
  });

  it('opens where the previous year closed, with no gap or overlap', () => {
    capital('2024-03-01', 100_000);
    sale('2024-06-01', 40_000);

    const pack = getYearEndPack(context.db, 2025);
    // The opening balance sheet is the prior year END, not this year's first day.
    expect(pack.previousBalanceSheet.asAt).toBe('2024-12-31');
    expect(pack.balanceSheet.asAt).toBe('2025-12-31');
    expect(pack.equity.openingEquity).toBe(pack.previousBalanceSheet.totalEquity);
  });
});

describe('the movement in the owner\'s stake', () => {
  it('ties opening, capital, drawings and profit back to closing', () => {
    capital('2024-01-10', 100_000); // before the year
    sale('2024-05-01', 30_000);

    capital('2025-02-01', 50_000); // during the year
    sale('2025-03-01', 80_000);
    expense('2025-04-01', 20_000);
    drawing('2025-05-01', 15_000);

    const { equity } = getYearEndPack(context.db, 2025);

    expect(equity.capitalIntroduced).toBe(50_000);
    expect(equity.drawings).toBe(15_000);
    expect(equity.profitForYear).toBe(60_000); // 80,000 sales − 20,000 expenses

    // The statement an accountant checks first.
    expect(
      equity.openingEquity + equity.capitalIntroduced - equity.drawings + equity.profitForYear,
    ).toBe(equity.closingEquity);
    expect(equity.reconciles).toBe(true);
    expect(equity.difference).toBe(0);
  });

  it('reconciles even when nothing happened all year', () => {
    capital('2024-01-10', 100_000);
    const { equity } = getYearEndPack(context.db, 2025);

    expect(equity.profitForYear).toBe(0);
    expect(equity.capitalIntroduced).toBe(0);
    expect(equity.closingEquity).toBe(equity.openingEquity);
    expect(equity.reconciles).toBe(true);
  });

  it('accounts for opening balances brought in during the year', () => {
    // Entering opening stock raises the owner's stake without any capital
    // being introduced and without passing through profit. Left out of this
    // statement it shows up as an unexplained difference — which is exactly
    // what happened on real data before this was handled.
    capital('2024-01-10', 100_000);
    post('2025-03-01', '1200', ACCOUNT_CODES.OPENING_BALANCE_EQUITY, 45_000);
    sale('2025-06-01', 20_000);

    const { equity } = getYearEndPack(context.db, 2025);

    expect(equity.openingBalancesRecognised).toBe(45_000);
    expect(
      equity.openingEquity +
        equity.capitalIntroduced -
        equity.drawings +
        equity.openingBalancesRecognised +
        equity.profitForYear,
    ).toBe(equity.closingEquity);
    expect(equity.reconciles).toBe(true);
  });

  it('reconciles when the year made a loss', () => {
    capital('2024-01-10', 100_000);
    expense('2025-06-01', 30_000);

    const { equity } = getYearEndPack(context.db, 2025);
    expect(equity.profitForYear).toBe(-30_000);
    expect(equity.reconciles).toBe(true);
    expect(equity.closingEquity).toBe(equity.openingEquity - 30_000);
  });
});

describe('what the pack asserts about itself', () => {
  it('reports the books as balanced and intact', () => {
    sale('2025-06-01', 25_000);
    const pack = getYearEndPack(context.db, 2025);

    expect(pack.integrity.trialBalanced).toBe(true);
    expect(pack.balanceSheet.balances).toBe(true);
    expect(pack.trialBalance.balanced).toBe(true);
  });

  it('says whether the year is closed to further entries', () => {
    sale('2025-06-01', 25_000);
    expect(getYearEndPack(context.db, 2025).isLocked).toBe(false);
  });

  it('carries the shop details the accountant needs to identify it', () => {
    const pack = getYearEndPack(context.db, 2025);
    expect(pack.shop.name).toBeTruthy();
    expect(pack.shop.currencyCode).toBe('GHS');
  });
});

describe('the year-end pack after the year has been closed', () => {
  /**
   * Closing a year sweeps drawings into retained earnings, so the drawings
   * account ends the year at zero. Reading "what the owner took out this year"
   * as the difference between two balance-sheet snapshots therefore reports
   * nothing the moment the year is closed — and the year-end pack is exactly
   * the document an owner opens AFTER closing.
   *
   * The figure has to come from what moved during the year, not from where the
   * account finished.
   */
  it('still shows what the owner took out', async () => {
    const { closeFinancialYear } = await import('@/services/year-end-close.service');

    capital('2025-01-02', 200_000);
    sale('2025-03-01', 100_000);
    expense('2025-04-01', 40_000);
    drawing('2025-08-01', 25_000);

    const before = getYearEndPack(context.db, 2025).equity;
    expect(before.drawings).toBe(25_000);

    closeFinancialYear(context.db, 2025, ACTOR);

    const after = getYearEndPack(context.db, 2025).equity;
    expect(after.drawings).toBe(25_000);
  });

  it('still reconciles', async () => {
    const { closeFinancialYear } = await import('@/services/year-end-close.service');

    capital('2025-01-02', 200_000);
    sale('2025-03-01', 100_000);
    expense('2025-04-01', 40_000);
    drawing('2025-08-01', 25_000);

    closeFinancialYear(context.db, 2025, ACTOR);

    const pack = getYearEndPack(context.db, 2025);
    expect(pack.equity.reconciles).toBe(true);
    expect(pack.equity.difference).toBe(0);
  });
});
