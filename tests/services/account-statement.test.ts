import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts } from '@/db/schema';
import { recordExpense, recordIncome } from '@/services/cashbook.service';
import { listExpenseCategories, listIncomeCategories } from '@/services/payment-account.service';
import {
  countAccountMovements,
  getAccountStatement,
  getPaymentAccount,
  listAccountSourceTypes,
} from '@/services/payment-account.service';
import { minor, type Minor } from '@/domain/money';

/**
 * Filtering an account's movements by date.
 *
 * This is the filter with an accounting answer rather than a UI one. Narrow a
 * cash account to "this month" and the shop must still be told what the account
 * HELD when the month opened — otherwise the running balance restarts at zero
 * and the last row of a statement contradicts the balance printed above it.
 *
 * The rule asserted throughout: opening + money in − money out = closing, and
 * the running balance on the newest row in the window equals closing.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const m = (n: number): Minor => minor(n);

let CASH = 0;
let EXPENSE_CATEGORY = 0;
let INCOME_CATEGORY = 0;

function spend(date: string, amount: number, description = 'Taxi'): void {
  recordExpense(
    context.db,
    {
      businessDate: date,
      categoryAccountId: EXPENSE_CATEGORY,
      description,
      amount: m(amount),
      paymentAccountId: CASH,
    },
    ACTOR,
  );
}

function receive(date: string, amount: number, description = 'Commission'): void {
  recordIncome(
    context.db,
    {
      businessDate: date,
      categoryAccountId: INCOME_CATEGORY,
      description,
      amount: m(amount),
      paymentAccountId: CASH,
    },
    ACTOR,
  );
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');

  CASH = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;
  EXPENSE_CATEGORY = listExpenseCategories(context.db)[0]!.id;
  INCOME_CATEGORY = listIncomeCategories(context.db)[0]!.id;
});

afterEach(() => {
  context.cleanup();
});

describe('opening and closing balances', () => {
  /**
   * The bug this replaced: the running balance was computed from zero over
   * whatever rows the filter selected, so a cash account genuinely holding
   * GHS 2,092.70 showed a closing balance of MINUS 907.30 the moment somebody
   * asked for the last week — under a heading that quoted the real balance.
   */
  it('carries the balance from before the window rather than restarting at zero', () => {
    receive('2026-07-10', 300_000); // 3,000.00 in, before the window
    spend('2026-08-05', 45_000); // 450.00 out, inside it
    receive('2026-08-06', 2_200); // 22.00 in, inside it

    const statement = getAccountStatement(context.db, CASH, {
      from: '2026-08-01',
      to: '2026-08-31',
    });

    expect(statement.opening).toBe(300_000);
    expect(statement.moneyIn).toBe(2_200);
    expect(statement.moneyOut).toBe(45_000);
    expect(statement.closing).toBe(300_000 + 2_200 - 45_000);

    // And the newest row's running balance IS the closing figure.
    expect(statement.movements[0]?.runningBalance).toBe(statement.closing);
  });

  it('opens at nothing when the window starts before the account was ever used', () => {
    receive('2026-08-06', 2_200);

    const statement = getAccountStatement(context.db, CASH, {
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(statement.opening).toBe(0);
    expect(statement.closing).toBe(2_200);
  });

  it('closes at the account balance when the window ends today', () => {
    receive('2026-07-10', 300_000);
    spend('2026-08-05', 45_000);

    const statement = getAccountStatement(context.db, CASH, { from: '0000-01-01', to: '2099-12-31' });
    expect(statement.closing).toBe(getPaymentAccount(context.db, CASH).balance);
  });

  it('does not work the opening balance backwards from today', () => {
    receive('2026-06-01', 100_000);
    spend('2026-09-01', 40_000); // AFTER the window — must not touch its opening

    const statement = getAccountStatement(context.db, CASH, {
      from: '2026-07-01',
      to: '2026-07-31',
    });

    // The account holds 60,000 today. July opened at 100,000 and nothing moved.
    expect(getPaymentAccount(context.db, CASH).balance).toBe(60_000);
    expect(statement.opening).toBe(100_000);
    expect(statement.closing).toBe(100_000);
    expect(statement.movements).toEqual([]);
  });

  it('includes a movement on the last day of the window', () => {
    spend('2026-08-31', 1_000);
    const statement = getAccountStatement(context.db, CASH, {
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(statement.total).toBe(1);
    expect(statement.moneyOut).toBe(1_000);
  });

  it('excludes a movement one day past the window', () => {
    spend('2026-09-01', 1_000);
    const statement = getAccountStatement(context.db, CASH, {
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(statement.total).toBe(0);
    expect(statement.moneyOut).toBe(0);
  });
});

describe('the running balance across pages', () => {
  /**
   * Page two must carry on from where page one stopped. A running balance
   * recomputed per page restarts at the opening figure on every page, which
   * makes a long statement unreadable and unverifiable.
   */
  it('continues from one page to the next', () => {
    receive('2026-07-31', 100_000);
    for (let day = 1; day <= 12; day++) {
      spend(`2026-08-${String(day).padStart(2, '0')}`, 1_000);
    }

    const window = { from: '2026-08-01', to: '2026-08-31' };
    const first = getAccountStatement(context.db, CASH, { ...window, limit: 5, offset: 0 });
    const second = getAccountStatement(context.db, CASH, { ...window, limit: 5, offset: 5 });

    expect(first.movements).toHaveLength(5);
    expect(second.movements).toHaveLength(5);

    // Rows come back newest first, so the oldest row of page one sits directly
    // above the newest row of page two: they differ by exactly that movement.
    const oldestOnPageOne = first.movements[4]!;
    const newestOnPageTwo = second.movements[0]!;
    expect(oldestOnPageOne.runningBalance).toBe(
      newestOnPageTwo.runningBalance + oldestOnPageOne.inMinor - oldestOnPageOne.outMinor,
    );

    // No page repeats a row, and the balances stay in step across both.
    expect(first.opening).toBe(second.opening);
    expect(first.closing).toBe(second.closing);
    expect(first.total).toBe(12);
  });
});

describe('the other filters', () => {
  it('separates money in from money out', () => {
    receive('2026-08-02', 5_000);
    spend('2026-08-03', 2_000);

    const window = { from: '2026-08-01', to: '2026-08-31' };
    expect(getAccountStatement(context.db, CASH, { ...window, flow: 'in' }).total).toBe(1);
    expect(getAccountStatement(context.db, CASH, { ...window, flow: 'out' }).total).toBe(1);
  });

  it('narrows to one kind of transaction', () => {
    receive('2026-08-02', 5_000);
    spend('2026-08-03', 2_000);

    const window = { from: '2026-08-01', to: '2026-08-31' };
    expect(getAccountStatement(context.db, CASH, { ...window, sourceType: 'EXPENSE' }).total).toBe(1);
    expect(getAccountStatement(context.db, CASH, { ...window, sourceType: 'INCOME' }).total).toBe(1);
    // A type this account has never seen matches nothing rather than erroring.
    expect(getAccountStatement(context.db, CASH, { ...window, sourceType: 'NONSENSE' }).total).toBe(
      0,
    );
  });

  it('offers only the transaction kinds this account has actually seen', () => {
    receive('2026-08-02', 5_000);
    spend('2026-08-03', 2_000);

    const types = listAccountSourceTypes(context.db, CASH);
    expect(types).toContain('EXPENSE');
    expect(types).toContain('INCOME');
    expect(types).not.toContain('PURCHASE');
  });

  it('searches the entry number, memo and line description', () => {
    spend('2026-08-03', 2_000, 'Taxi to Madina market');

    const window = { from: '2026-08-01', to: '2026-08-31' };
    expect(getAccountStatement(context.db, CASH, { ...window, search: 'madina' }).total).toBe(1);
    expect(getAccountStatement(context.db, CASH, { ...window, search: 'JE-' }).total).toBe(1);
    expect(getAccountStatement(context.db, CASH, { ...window, search: 'nothing' }).total).toBe(0);
  });

  it('narrows to a band of amounts', () => {
    spend('2026-08-02', 1_000);
    spend('2026-08-03', 50_000);

    const window = { from: '2026-08-01', to: '2026-08-31' };
    expect(
      getAccountStatement(context.db, CASH, { ...window, minAmount: m(10_000) }).total,
    ).toBe(1);
    expect(
      getAccountStatement(context.db, CASH, { ...window, maxAmount: m(10_000) }).total,
    ).toBe(1);
  });

  /**
   * The opening balance is what the account HELD, not a subtotal of the rows a
   * search box happens to match. Narrowing by type must not move it.
   */
  it('leaves the opening balance alone whatever else is filtered', () => {
    receive('2026-07-10', 300_000);
    spend('2026-08-05', 45_000);
    receive('2026-08-06', 2_200);

    const window = { from: '2026-08-01', to: '2026-08-31' };
    const all = getAccountStatement(context.db, CASH, window);
    const outOnly = getAccountStatement(context.db, CASH, { ...window, flow: 'out' });

    expect(outOnly.opening).toBe(all.opening);
    expect(outOnly.moneyIn).toBe(0);
    expect(outOnly.moneyOut).toBe(45_000);
  });

  it('counts the same movements the statement returns', () => {
    for (let day = 1; day <= 7; day++) {
      spend(`2026-08-0${day}`, 1_000);
    }
    const window = { from: '2026-08-01', to: '2026-08-31' };
    expect(countAccountMovements(context.db, CASH, window)).toBe(7);
    expect(getAccountStatement(context.db, CASH, { ...window, limit: 3 }).total).toBe(7);
  });
});

describe('an account that does not exist', () => {
  it('is reported as not found rather than as an empty statement', () => {
    expect(() => getAccountStatement(context.db, 9_999, {})).toThrow();
    expect(() => countAccountMovements(context.db, 9_999, {})).toThrow();
  });
});
