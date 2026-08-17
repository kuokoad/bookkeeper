import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeFinancialYear,
  isYearClosed,
  listClosings,
  reopenFinancialYear,
} from '@/services/year-end-close.service';
import { postJournalEntry } from '@/services/journal.service';
import { getProfitAndLoss, getBalanceSheet } from '@/services/reporting/financial.service';
import { getTrialBalance } from '@/services/reporting/balances.service';
import { checkBooksIntegrity } from '@/services/reporting/ledger.service';
import { credit, debit } from '@/domain/accounting/journal';
import { minor } from '@/domain/money';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createUser } from '@/services/auth.service';
import { businessSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { createTestDatabase, accountIdFor, type TestDatabase } from '../helpers/test-db';

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
  // Every test closes a year in the past; "today" must be after it.
  vi.setSystemTime(new Date('2027-06-15T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  context.cleanup();
});

const account = (code: string) => accountIdFor(context.db, code);

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

const sale = (date: string, amount: number) => post(date, '1001', ACCOUNT_CODES.SALES_REVENUE, amount);
const expense = (date: string, amount: number) => post(date, '6010', '1001', amount);
const drawing = (date: string, amount: number) =>
  post(date, ACCOUNT_CODES.OWNERS_DRAWINGS, '1001', amount);
const capital = (date: string, amount: number) =>
  post(date, '1001', ACCOUNT_CODES.OWNERS_CAPITAL, amount);

const lockDate = () =>
  context.db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get()
    ?.booksLockedBefore ?? null;

/** A year that traded: 100,000 in, 40,000 out, 60,000 profit. */
function tradeIn(year: number): void {
  sale(`${year}-03-01`, 100_000);
  expense(`${year}-04-01`, 40_000);
}

describe('closing a year', () => {
  it('posts one balanced entry and reports the profit', () => {
    tradeIn(2025);
    const result = closeFinancialYear(context.db, 2025, ACTOR);

    expect(result.profit).toBe(60_000);
    expect(checkBooksIntegrity(context.db).trialBalanced).toBe(true);
  });

  it('leaves the year\'s Profit & Loss unchanged', () => {
    tradeIn(2025);
    const before = getProfitAndLoss(context.db, { from: '2025-01-01', to: '2025-12-31' });
    closeFinancialYear(context.db, 2025, ACTOR);
    const after = getProfitAndLoss(context.db, { from: '2025-01-01', to: '2025-12-31' });

    // The closing entry is dated inside the year and cancels its revenue and
    // expenses. Counted, it would report a well-traded year as earning nothing.
    expect(after.netProfit).toBe(before.netProfit);
    expect(after.netProfit).toBe(60_000);
    expect(after.netSales).toBe(100_000);
  });

  it('carries the profit into retained earnings without changing total equity', () => {
    capital('2025-01-02', 200_000);
    tradeIn(2025);

    const before = getBalanceSheet(context.db, '2025-12-31');
    closeFinancialYear(context.db, 2025, ACTOR);
    const after = getBalanceSheet(context.db, '2025-12-31');

    // Closing moves profit within equity. It must not create or destroy any.
    expect(after.totalEquity).toBe(before.totalEquity);
    expect(after.totalAssets).toBe(before.totalAssets);
    expect(after.balances).toBe(true);
    expect(after.retainedEarnings).toBe(60_000);
  });

  it('zeroes the trading accounts, which is what fixes the trial balance', () => {
    tradeIn(2025);
    closeFinancialYear(context.db, 2025, ACTOR);

    const trial = getTrialBalance(context.db, { to: '2025-12-31' });
    const codes = trial.lines.map((line) => line.code);

    // Revenue and expense accounts no longer carry all-time figures.
    expect(codes).not.toContain(ACCOUNT_CODES.SALES_REVENUE);
    expect(codes).not.toContain('6010');
    expect(trial.balanced).toBe(true);
  });

  it('closes drawings too, so the next year starts clean', () => {
    capital('2025-01-02', 200_000);
    tradeIn(2025);
    drawing('2025-08-01', 25_000);

    const result = closeFinancialYear(context.db, 2025, ACTOR);
    expect(result.drawings).toBe(25_000);

    const after = getBalanceSheet(context.db, '2025-12-31');
    expect(after.drawings).toBe(0);
    // Profit 60,000 less drawings 25,000.
    expect(after.retainedEarnings).toBe(35_000);
    expect(after.balances).toBe(true);
  });

  it('locks the books to the year end', () => {
    tradeIn(2025);
    closeFinancialYear(context.db, 2025, ACTOR);
    expect(lockDate()).toBe('2025-12-31');
  });

  it('refuses a new transaction dated inside the closed year', () => {
    tradeIn(2025);
    closeFinancialYear(context.db, 2025, ACTOR);
    expect(() => sale('2025-07-01', 5_000)).toThrow();
  });
});

describe('refusing to close when it would mislead', () => {
  it('refuses a year that has not finished', () => {
    vi.setSystemTime(new Date('2026-06-15T10:00:00Z'));
    tradeIn(2026);
    expect(() => closeFinancialYear(context.db, 2026, ACTOR)).toThrow(/has not finished/i);
  });

  it('refuses to close the same year twice', () => {
    tradeIn(2025);
    closeFinancialYear(context.db, 2025, ACTOR);
    expect(() => closeFinancialYear(context.db, 2025, ACTOR)).toThrow(/already closed/i);
  });

  it('refuses to close out of order', () => {
    tradeIn(2024);
    tradeIn(2025);
    expect(() => closeFinancialYear(context.db, 2025, ACTOR)).toThrow(/Close 2024 first/i);
  });

  it('refuses a year with nothing in it', () => {
    tradeIn(2024);
    closeFinancialYear(context.db, 2024, ACTOR);
    expect(() => closeFinancialYear(context.db, 2025, ACTOR)).toThrow(/nothing to close/i);
  });

  it('leaves nothing behind when it refuses', () => {
    tradeIn(2024);
    tradeIn(2025);
    expect(() => closeFinancialYear(context.db, 2025, ACTOR)).toThrow();

    // A refused close must not have posted a partial entry or moved the lock.
    expect(isYearClosed(context.db, 2025)).toBe(false);
    expect(lockDate()).toBeNull();
    expect(checkBooksIntegrity(context.db).trialBalanced).toBe(true);
  });
});

describe('closing several years in a row', () => {
  it('keeps each year\'s profit separate and the books balanced', () => {
    tradeIn(2024);
    sale('2025-03-01', 50_000);
    expense('2025-04-01', 20_000);

    closeFinancialYear(context.db, 2024, ACTOR);
    closeFinancialYear(context.db, 2025, ACTOR);

    expect(getProfitAndLoss(context.db, { from: '2024-01-01', to: '2024-12-31' }).netProfit).toBe(60_000);
    expect(getProfitAndLoss(context.db, { from: '2025-01-01', to: '2025-12-31' }).netProfit).toBe(30_000);

    const sheet = getBalanceSheet(context.db, '2025-12-31');
    expect(sheet.retainedEarnings).toBe(90_000);
    expect(sheet.balances).toBe(true);
    expect(checkBooksIntegrity(context.db).trialBalanced).toBe(true);
  });
});

describe('reopening a year', () => {
  it('reverses the close rather than deleting it', () => {
    tradeIn(2025);
    closeFinancialYear(context.db, 2025, ACTOR);
    reopenFinancialYear(context.db, 2025, ACTOR);

    expect(isYearClosed(context.db, 2025)).toBe(false);
    // Both the close and its reversal remain on record.
    const closings = listClosings(context.db);
    expect(closings).toHaveLength(1);
    expect(closings[0]?.reversedAt).not.toBeNull();
    expect(checkBooksIntegrity(context.db).trialBalanced).toBe(true);
  });

  it('puts the balance sheet back exactly where it was', () => {
    capital('2025-01-02', 200_000);
    tradeIn(2025);

    const before = getBalanceSheet(context.db, '2025-12-31');
    closeFinancialYear(context.db, 2025, ACTOR);
    reopenFinancialYear(context.db, 2025, ACTOR);
    const after = getBalanceSheet(context.db, '2025-12-31');

    expect(after.totalEquity).toBe(before.totalEquity);
    expect(after.retainedEarnings).toBe(before.retainedEarnings);
    expect(after.balances).toBe(true);
  });

  it('does not double-count the profit in the Profit & Loss', () => {
    tradeIn(2025);
    closeFinancialYear(context.db, 2025, ACTOR);
    reopenFinancialYear(context.db, 2025, ACTOR);

    // The reversal is dated inside the year too. Unless it is also marked as a
    // closing entry, the P&L counts it and reports double.
    expect(getProfitAndLoss(context.db, { from: '2025-01-01', to: '2025-12-31' }).netProfit).toBe(60_000);
  });

  it('moves the books lock back', () => {
    tradeIn(2024);
    tradeIn(2025);
    closeFinancialYear(context.db, 2024, ACTOR);
    closeFinancialYear(context.db, 2025, ACTOR);
    expect(lockDate()).toBe('2025-12-31');

    reopenFinancialYear(context.db, 2025, ACTOR);
    // Back to the end of the newest year still closed.
    expect(lockDate()).toBe('2024-12-31');

    reopenFinancialYear(context.db, 2024, ACTOR);
    expect(lockDate()).toBeNull();
  });

  it('refuses to reopen underneath a later closed year', () => {
    tradeIn(2024);
    tradeIn(2025);
    closeFinancialYear(context.db, 2024, ACTOR);
    closeFinancialYear(context.db, 2025, ACTOR);

    expect(() => reopenFinancialYear(context.db, 2024, ACTOR)).toThrow(/Reopen 2025 first/i);
  });

  it('refuses to reopen a year that is not closed', () => {
    expect(() => reopenFinancialYear(context.db, 2025, ACTOR)).toThrow(/not closed/i);
  });

  it('allows the year to be closed again afterwards', () => {
    tradeIn(2025);
    closeFinancialYear(context.db, 2025, ACTOR);
    reopenFinancialYear(context.db, 2025, ACTOR);
    sale('2025-09-01', 10_000);

    const again = closeFinancialYear(context.db, 2025, ACTOR);
    // The extra sale is included the second time round.
    expect(again.profit).toBe(70_000);
    expect(getBalanceSheet(context.db, '2025-12-31').balances).toBe(true);
    expect(listClosings(context.db)).toHaveLength(2);
  });
});
