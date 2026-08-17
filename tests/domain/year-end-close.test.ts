import { describe, expect, it } from 'vitest';

import { buildClosingEntry, type ClosableAccount } from '@/domain/accounting/year-end-close';
import { assertBalanced, finaliseLines } from '@/domain/accounting/journal';
import { minor } from '@/domain/money';
import { ValidationError } from '@/domain/errors';

const RETAINED = 3200;

const account = (accountId: number, name: string, balance: number): ClosableAccount => ({
  accountId,
  code: String(accountId),
  name,
  balance: minor(balance),
});

/** Every closing entry must balance, whatever the shape of the year. */
const expectBalanced = (lines: ReturnType<typeof buildClosingEntry>['lines']) => {
  expect(() => assertBalanced(finaliseLines(lines))).not.toThrow();
};

describe('a profitable year', () => {
  const result = buildClosingEntry({
    revenue: [account(4000, 'Sales', 100_000)],
    expenses: [account(5000, 'Cost of goods sold', 60_000), account(6010, 'Rent', 10_000)],
    drawings: [],
    retainedEarningsAccountId: RETAINED,
  });

  it('works out the profit', () => {
    expect(result.totalRevenue).toBe(100_000);
    expect(result.totalExpenses).toBe(70_000);
    expect(result.profit).toBe(30_000);
  });

  it('balances', () => {
    expectBalanced(result.lines);
  });

  it('zeroes every trading account and credits the profit to retained earnings', () => {
    // Revenue carries a credit balance, so it is closed with a debit.
    const sales = result.lines.find((line) => line.accountId === 4000);
    expect(sales?.debit).toBe(100_000);

    // Expenses carry debits, so they are closed with credits.
    expect(result.lines.find((line) => line.accountId === 5000)?.credit).toBe(60_000);
    expect(result.lines.find((line) => line.accountId === 6010)?.credit).toBe(10_000);

    const retained = result.lines.find((line) => line.accountId === RETAINED);
    expect(retained?.credit).toBe(30_000);
  });
});

describe('a loss-making year', () => {
  const result = buildClosingEntry({
    revenue: [account(4000, 'Sales', 40_000)],
    expenses: [account(6010, 'Rent', 55_000)],
    drawings: [],
    retainedEarningsAccountId: RETAINED,
  });

  it('reports a negative profit rather than hiding the sign', () => {
    expect(result.profit).toBe(-15_000);
  });

  it('debits retained earnings, reducing the owner\'s stake', () => {
    expect(result.lines.find((line) => line.accountId === RETAINED)?.debit).toBe(15_000);
    expectBalanced(result.lines);
  });
});

describe('drawings', () => {
  it('are closed alongside profit, and pull retained earnings down', () => {
    const result = buildClosingEntry({
      revenue: [account(4000, 'Sales', 100_000)],
      expenses: [account(6010, 'Rent', 40_000)],
      drawings: [account(3100, "Owner's Drawings", 25_000)],
      retainedEarningsAccountId: RETAINED,
    });

    expect(result.profit).toBe(60_000);
    expect(result.totalDrawings).toBe(25_000);
    expect(result.netToRetainedEarnings).toBe(35_000);

    // Drawings carry a debit balance, so closing them is a credit.
    expect(result.lines.find((line) => line.accountId === 3100)?.credit).toBe(25_000);
    expect(result.lines.find((line) => line.accountId === RETAINED)?.credit).toBe(35_000);
    expectBalanced(result.lines);
  });

  it('can exceed the profit, leaving retained earnings in debit', () => {
    // The owner took out more than the shop earned — real, and it must balance.
    const result = buildClosingEntry({
      revenue: [account(4000, 'Sales', 50_000)],
      expenses: [account(6010, 'Rent', 20_000)],
      drawings: [account(3100, "Owner's Drawings", 45_000)],
      retainedEarningsAccountId: RETAINED,
    });

    expect(result.profit).toBe(30_000);
    expect(result.netToRetainedEarnings).toBe(-15_000);
    expect(result.lines.find((line) => line.accountId === RETAINED)?.debit).toBe(15_000);
    expectBalanced(result.lines);
  });
});

describe('awkward but real shapes', () => {
  it('skips accounts that are already at zero', () => {
    const result = buildClosingEntry({
      revenue: [account(4000, 'Sales', 50_000), account(4200, 'Other income', 0)],
      expenses: [account(6010, 'Rent', 20_000), account(6020, 'Electricity', 0)],
      drawings: [],
      retainedEarningsAccountId: RETAINED,
    });

    // A line moving nothing is noise in the ledger for ever.
    expect(result.lines.some((line) => line.accountId === 4200)).toBe(false);
    expect(result.lines.some((line) => line.accountId === 6020)).toBe(false);
    expectBalanced(result.lines);
  });

  it('closes an account sitting on the wrong side of itself', () => {
    // Returns exceeded sales in a small category: the revenue account carries a
    // debit balance. It still has to be zeroed, from the other direction.
    const result = buildClosingEntry({
      revenue: [account(4000, 'Sales', 80_000), account(4150, 'Sales returns', -5_000)],
      expenses: [account(6010, 'Rent', 20_000)],
      drawings: [],
      retainedEarningsAccountId: RETAINED,
    });

    expect(result.lines.find((line) => line.accountId === 4150)?.credit).toBe(5_000);
    expect(result.totalRevenue).toBe(75_000);
    expect(result.profit).toBe(55_000);
    expectBalanced(result.lines);
  });

  it('balances a year that broke exactly even', () => {
    const result = buildClosingEntry({
      revenue: [account(4000, 'Sales', 50_000)],
      expenses: [account(6010, 'Rent', 50_000)],
      drawings: [],
      retainedEarningsAccountId: RETAINED,
    });

    expect(result.profit).toBe(0);
    // Nothing moves to retained earnings, but the trading accounts still close.
    expect(result.lines.some((line) => line.accountId === RETAINED)).toBe(false);
    expect(result.lines).toHaveLength(2);
    expectBalanced(result.lines);
  });

  it('refuses a year with nothing in it', () => {
    // Posting an empty entry would put a meaningless row in the ledger.
    expect(() =>
      buildClosingEntry({
        revenue: [account(4000, 'Sales', 0)],
        expenses: [],
        drawings: [],
        retainedEarningsAccountId: RETAINED,
      }),
    ).toThrow(ValidationError);
  });
});
