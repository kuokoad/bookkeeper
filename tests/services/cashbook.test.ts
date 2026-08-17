import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import {
  accounts,
  expenses,
  incomes,
  journalEntries,
  ownerMovements,
  paymentAccounts,
  products,
} from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import {
  getExpensesByCategory,
  getExpensesTotal,
  getIncomesTotal,
  listExpenses,
  listIncomes,
  recordExpense,
  recordIncome,
  recordOwnerCapital,
  recordOwnerDrawings,
  voidExpense,
  voidIncome,
} from '@/services/cashbook.service';
import {
  createCategory,
  createPaymentAccount,
  getAccountMovements,
  getPaymentAccountBalance,
  listExpenseCategories,
  listIncomeCategories,
  listPaymentAccounts,
  setPaymentAccountActive,
  updatePaymentAccount,
} from '@/services/payment-account.service';
import { getTotalReceivables } from '@/services/customer.service';
import { getTotalPayables } from '@/services/supplier.service';
import { getInventoryValue, verifyProductStock } from '@/services/inventory.service';
import { getAccountBalanceByCode, getTrialBalance } from '@/services/reporting/balances.service';
import { minor, type Minor } from '@/domain/money';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-17';

const m = (n: number): Minor => minor(n);

let CASH = 0;
let MOMO = 0;

function categoryId(name: string): number {
  const found = listExpenseCategories(context.db).find((category) => category.name === name);
  if (!found) throw new Error(`No expense category "${name}"`);
  return found.id;
}

function incomeCategoryId(name: string): number {
  const found = listIncomeCategories(context.db).find((category) => category.name === name);
  if (!found) throw new Error(`No income category "${name}"`);
  return found.id;
}

function assertBooksHealthy(label: string) {
  expect(getTrialBalance(context.db).balanced, `${label}: trial balance`).toBe(true);
  expect(getInventoryValue(context.db), `${label}: inventory vs GL`).toBe(
    getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY),
  );
  expect(getTotalReceivables(context.db), `${label}: A/R`).toBe(
    getAccountBalanceByCode(context.db, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE),
  );
  expect(getTotalPayables(context.db), `${label}: A/P`).toBe(
    getAccountBalanceByCode(context.db, ACCOUNT_CODES.ACCOUNTS_PAYABLE),
  );
  for (const row of context.db.select({ id: products.id }).from(products).all()) {
    expect(verifyProductStock(context.db, row.id).ok, `${label}: stock p${row.id}`).toBe(true);
  }
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');

  const accountRows = context.db.select().from(paymentAccounts).all();
  CASH = accountRows.find((a) => a.kind === 'CASH')!.id;
  MOMO = accountRows.find((a) => a.kind === 'MOBILE_MONEY')!.id;
});

afterEach(() => {
  context.cleanup();
});

describe('expenses', () => {
  it('reduces the paying account and records the cost', () => {
    const result = recordExpense(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: categoryId('Transport'),
        description: 'Taxi to Madina market',
        amount: m(4_500),
        paymentAccountId: CASH,
      },
      ACTOR,
    );

    expect(result.documentNo).toMatch(/^EXP-/);
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(-4_500);
    expect(getAccountBalanceByCode(context.db, '6050')).toBe(4_500); // Transport
    assertBooksHealthy('cash expense');
  });

  it('can be paid from MoMo, leaving cash untouched', () => {
    recordExpense(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: categoryId('MoMo Charges'),
        description: 'Withdrawal fee',
        amount: m(350),
        paymentAccountId: MOMO,
        reference: 'MM-77120',
      },
      ACTOR,
    );

    expect(getAccountBalanceByCode(context.db, '1011')).toBe(-350);
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(0);
    assertBooksHealthy('momo expense');
  });

  it('rejects zero, negative and blank entries', () => {
    const base = {
      businessDate: TODAY,
      categoryAccountId: categoryId('Rent'),
      description: 'Rent',
      paymentAccountId: CASH,
    };
    expect(() => recordExpense(context.db, { ...base, amount: m(0) }, ACTOR)).toThrow(
      ValidationError,
    );
    expect(() => recordExpense(context.db, { ...base, amount: m(-100) }, ACTOR)).toThrow(
      ValidationError,
    );
    expect(() =>
      recordExpense(context.db, { ...base, description: '   ', amount: m(100) }, ACTOR),
    ).toThrow(ValidationError);
  });

  it('refuses a category that is not an expense account', () => {
    const revenue = context.db
      .select()
      .from(accounts)
      .where(eq(accounts.code, ACCOUNT_CODES.SALES_REVENUE))
      .get();

    expect(() =>
      recordExpense(
        context.db,
        {
          businessDate: TODAY,
          categoryAccountId: revenue!.id,
          description: 'Wrong account',
          amount: m(1_000),
          paymentAccountId: CASH,
        },
        ACTOR,
      ),
    ).toThrow(/not a valid expense category/i);
  });

  it('refuses to post to a heading that groups other categories', () => {
    const heading = context.db
      .select()
      .from(accounts)
      .where(eq(accounts.code, ACCOUNT_CODES.OPERATING_EXPENSES))
      .get();

    expect(() =>
      recordExpense(
        context.db,
        {
          businessDate: TODAY,
          categoryAccountId: heading!.id,
          description: 'To a heading',
          amount: m(1_000),
          paymentAccountId: CASH,
        },
        ACTOR,
      ),
    ).toThrow(/is a heading/i);
  });

  it('totals and groups by category for a period', () => {
    recordExpense(
      context.db,
      {
        businessDate: '2026-08-01',
        categoryAccountId: categoryId('Rent'),
        description: 'August rent',
        amount: m(50_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );
    recordExpense(
      context.db,
      {
        businessDate: '2026-08-10',
        categoryAccountId: categoryId('Transport'),
        description: 'Deliveries',
        amount: m(6_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );
    recordExpense(
      context.db,
      {
        businessDate: '2026-08-15',
        categoryAccountId: categoryId('Transport'),
        description: 'More deliveries',
        amount: m(4_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );

    expect(getExpensesTotal(context.db, '2026-08-01', '2026-08-31')).toBe(60_000);
    // A narrower window excludes the rent.
    expect(getExpensesTotal(context.db, '2026-08-10', '2026-08-31')).toBe(10_000);

    const byCategory = getExpensesByCategory(context.db, '2026-08-01', '2026-08-31');
    expect(byCategory[0]?.categoryName).toBe('Rent'); // biggest first
    expect(byCategory[0]?.total).toBe(50_000);
    const transport = byCategory.find((row) => row.categoryName === 'Transport');
    expect(transport?.total).toBe(10_000);
    expect(transport?.count).toBe(2);
  });

  it('voids by reversal, keeping the original record', () => {
    const result = recordExpense(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: categoryId('Repairs & Maintenance'),
        description: 'Fridge repair',
        amount: m(12_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );

    expect(getAccountBalanceByCode(context.db, '1001')).toBe(-12_000);

    voidExpense(context.db, result.id, 'Recorded twice by mistake', ACTOR);

    expect(getAccountBalanceByCode(context.db, '1001')).toBe(0);
    expect(getAccountBalanceByCode(context.db, '6070')).toBe(0);
    assertBooksHealthy('void expense');

    const original = context.db.select().from(expenses).where(eq(expenses.id, result.id)).get();
    expect(original?.status).toBe('VOIDED');
    expect(original?.voidReason).toBe('Recorded twice by mistake');
    expect(original?.amountMinor).toBe(12_000); // untouched

    // A voided expense no longer counts toward the period total.
    expect(getExpensesTotal(context.db, TODAY, TODAY)).toBe(0);
  });

  it('refuses to void twice or without a reason', () => {
    const result = recordExpense(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: categoryId('Rent'),
        description: 'Rent',
        amount: m(1_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );

    expect(() => voidExpense(context.db, result.id, 'x', ACTOR)).toThrow(ValidationError);
    voidExpense(context.db, result.id, 'Wrong month', ACTOR);
    expect(() => voidExpense(context.db, result.id, 'Again', ACTOR)).toThrow(ConflictError);
  });
});

describe('other income', () => {
  it('increases the receiving account and records the income', () => {
    recordIncome(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: incomeCategoryId('Commission'),
        description: 'Airtime commission',
        amount: m(8_000),
        paymentAccountId: MOMO,
      },
      ACTOR,
    );

    expect(getAccountBalanceByCode(context.db, '1011')).toBe(8_000);
    expect(getAccountBalanceByCode(context.db, '4210')).toBe(8_000);
    assertBooksHealthy('income');
  });

  it('is kept separate from sales revenue', () => {
    recordIncome(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: incomeCategoryId('Service Income'),
        description: 'Phone charging',
        amount: m(2_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );

    // Other income must NOT inflate sales revenue.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.SALES_REVENUE)).toBe(0);
    expect(getIncomesTotal(context.db, TODAY, TODAY)).toBe(2_000);
  });

  it('refuses an expense account as an income category', () => {
    expect(() =>
      recordIncome(
        context.db,
        {
          businessDate: TODAY,
          categoryAccountId: categoryId('Rent'),
          description: 'Wrong',
          amount: m(1_000),
          paymentAccountId: CASH,
        },
        ACTOR,
      ),
    ).toThrow(/not a valid income category/i);
  });

  it('voids by reversal', () => {
    const result = recordIncome(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: incomeCategoryId('Commission'),
        description: 'Commission',
        amount: m(5_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );
    voidIncome(context.db, result.id, 'Duplicated', ACTOR);

    expect(getAccountBalanceByCode(context.db, '1001')).toBe(0);
    expect(getIncomesTotal(context.db, TODAY, TODAY)).toBe(0);
    expect(context.db.select().from(incomes).where(eq(incomes.id, result.id)).get()?.status).toBe(
      'VOIDED',
    );
    assertBooksHealthy('void income');
  });
});

describe('payment accounts', () => {
  it('lets the owner add a mobile money account without a code change', () => {
    const id = createPaymentAccount(
      context.db,
      { name: 'Telecel Cash', kind: 'MOBILE_MONEY', provider: 'Telecel' },
      ACTOR,
    );

    const account = listPaymentAccounts(context.db).find((row) => row.id === id);
    expect(account?.provider).toBe('Telecel');
    expect(account?.balance).toBe(0);
    // It got its own ledger account under the Mobile Money heading.
    expect(account?.glCode).toMatch(/^101\d$/);

    // And it works immediately for real money movement.
    recordIncome(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: incomeCategoryId('Commission'),
        description: 'Telecel commission',
        amount: m(3_000),
        paymentAccountId: id,
      },
      ACTOR,
    );
    expect(getPaymentAccountBalance(context.db, id)).toBe(3_000);
    assertBooksHealthy('new payment account');
  });

  it('refuses a duplicate name', () => {
    createPaymentAccount(context.db, { name: 'Telecel Cash', kind: 'MOBILE_MONEY' }, ACTOR);
    expect(() =>
      createPaymentAccount(context.db, { name: 'telecel cash', kind: 'MOBILE_MONEY' }, ACTOR),
    ).toThrow(ConflictError);
  });

  it('keeps exactly one default', () => {
    const id = createPaymentAccount(
      context.db,
      { name: 'Telecel Cash', kind: 'MOBILE_MONEY', isDefault: true },
      ACTOR,
    );

    const defaults = listPaymentAccounts(context.db).filter((row) => row.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.id).toBe(id);
  });

  it('refuses to archive an account still holding money', () => {
    recordIncome(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: incomeCategoryId('Commission'),
        description: 'Commission',
        amount: m(5_000),
        paymentAccountId: MOMO,
      },
      ACTOR,
    );

    expect(() => setPaymentAccountActive(context.db, MOMO, false, ACTOR)).toThrow(/still holds money/i);
  });

  it('refuses to archive the default account', () => {
    // Cash is the seeded default and has a zero balance.
    expect(() => setPaymentAccountActive(context.db, CASH, false, ACTOR)).toThrow(
      /make another account the default/i,
    );
  });

  it('renames the ledger account when the payment account is renamed', () => {
    updatePaymentAccount(
      context.db,
      MOMO,
      { name: 'MTN MoMo (shop line)', kind: 'MOBILE_MONEY', provider: 'MTN' },
      ACTOR,
    );

    const account = listPaymentAccounts(context.db).find((row) => row.id === MOMO);
    expect(account?.name).toBe('MTN MoMo (shop line)');

    const gl = context.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, account!.glAccountId))
      .get();
    expect(gl?.name).toBe('MTN MoMo (shop line)');
  });
});

describe('account movements — answering "why is the balance this?"', () => {
  it('lists every movement with a running balance that ends at the balance', () => {
    recordIncome(
      context.db,
      {
        businessDate: '2026-08-01',
        categoryAccountId: incomeCategoryId('Commission'),
        description: 'Commission',
        amount: m(10_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );
    recordExpense(
      context.db,
      {
        businessDate: '2026-08-02',
        categoryAccountId: categoryId('Transport'),
        description: 'Taxi',
        amount: m(3_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );
    recordExpense(
      context.db,
      {
        businessDate: '2026-08-03',
        categoryAccountId: categoryId('Rent'),
        description: 'Rent',
        amount: m(2_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );

    const movements = getAccountMovements(context.db, CASH);
    expect(movements).toHaveLength(3);

    // Newest first, and the newest running balance IS the account balance.
    expect(movements[0]?.runningBalance).toBe(5_000);
    expect(getPaymentAccountBalance(context.db, CASH)).toBe(5_000);

    // The oldest movement is the money coming in.
    expect(movements[2]?.inMinor).toBe(10_000);
    expect(movements[2]?.outMinor).toBe(0);
    expect(movements[0]?.outMinor).toBe(2_000);
  });

  it('filters by date without breaking the balance', () => {
    recordIncome(
      context.db,
      {
        businessDate: '2026-07-01',
        categoryAccountId: incomeCategoryId('Commission'),
        description: 'July',
        amount: m(10_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );
    recordIncome(
      context.db,
      {
        businessDate: '2026-08-01',
        categoryAccountId: incomeCategoryId('Commission'),
        description: 'August',
        amount: m(5_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );

    expect(getAccountMovements(context.db, CASH, { from: '2026-08-01' })).toHaveLength(1);
    // Balance as at the end of July.
    expect(getPaymentAccountBalance(context.db, CASH, '2026-07-31')).toBe(10_000);
    expect(getPaymentAccountBalance(context.db, CASH)).toBe(15_000);
  });

  it('throws for an unknown account rather than returning zero', () => {
    expect(() => getPaymentAccountBalance(context.db, 999_999)).toThrow(NotFoundError);
  });
});

describe('categories', () => {
  it('adds an expense category as a real account under Operating Expenses', () => {
    const id = createCategory(context.db, 'EXPENSE', 'Security guard', ACTOR);

    const category = listExpenseCategories(context.db).find((row) => row.id === id);
    expect(category?.name).toBe('Security guard');
    expect(Number(category?.code)).toBeGreaterThan(6000);

    // It can be used immediately.
    recordExpense(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: id,
        description: 'Night guard',
        amount: m(20_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );
    assertBooksHealthy('new category');
  });

  it('adds an income category under Other Income', () => {
    const id = createCategory(context.db, 'INCOME', 'Table rental', ACTOR);
    expect(listIncomeCategories(context.db).some((row) => row.id === id)).toBe(true);
    // And is refused as an expense category.
    expect(() =>
      recordExpense(
        context.db,
        {
          businessDate: TODAY,
          categoryAccountId: id,
          description: 'Wrong',
          amount: m(100),
          paymentAccountId: CASH,
        },
        ACTOR,
      ),
    ).toThrow(/not a valid expense category/i);
  });

  it('refuses a duplicate category name', () => {
    createCategory(context.db, 'EXPENSE', 'Security guard', ACTOR);
    expect(() => createCategory(context.db, 'EXPENSE', 'security guard', ACTOR)).toThrow(
      ConflictError,
    );
  });

  it('ships sensible defaults for a Ghanaian shop', () => {
    const names = listExpenseCategories(context.db).map((row) => row.name);
    expect(names).toContain('Rent');
    expect(names).toContain('Electricity');
    expect(names).toContain('MoMo Charges');
    expect(names).toContain('Transport');
  });
});

describe('owner capital and drawings', () => {
  it('capital increases the account and the owner’s stake, not revenue', () => {
    recordOwnerCapital(
      context.db,
      {
        businessDate: TODAY,
        paymentAccountId: CASH,
        amount: m(300_000),
        description: 'Opening float',
      },
      ACTOR,
    );

    expect(getAccountBalanceByCode(context.db, '1001')).toBe(300_000);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.OWNERS_CAPITAL)).toBe(300_000);
    // Money the owner puts in is NOT income.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.SALES_REVENUE)).toBe(0);
    expect(getIncomesTotal(context.db, TODAY, TODAY)).toBe(0);
    assertBooksHealthy('owner capital');
  });

  it('drawings reduce the owner’s stake, not the profit', () => {
    recordOwnerCapital(
      context.db,
      { businessDate: TODAY, paymentAccountId: CASH, amount: m(300_000) },
      ACTOR,
    );
    recordOwnerDrawings(
      context.db,
      {
        businessDate: TODAY,
        paymentAccountId: CASH,
        amount: m(50_000),
        description: 'Owner took cash for school fees',
      },
      ACTOR,
    );

    expect(getAccountBalanceByCode(context.db, '1001')).toBe(250_000);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.OWNERS_DRAWINGS)).toBe(50_000);
    // Crucially NOT an expense — it must not reduce reported profit.
    expect(getExpensesTotal(context.db, TODAY, TODAY)).toBe(0);
    assertBooksHealthy('owner drawings');
  });

  it('creates a real source row so the entry is traceable', () => {
    const result = recordOwnerCapital(
      context.db,
      { businessDate: TODAY, paymentAccountId: CASH, amount: m(1_000) },
      ACTOR,
    );

    const movement = context.db
      .select()
      .from(ownerMovements)
      .where(eq(ownerMovements.id, result.id))
      .get();
    expect(movement?.kind).toBe('CAPITAL');
    expect(movement?.journalEntryId).toBe(result.journalEntryId);

    // The journal entry points back at that row.
    const entry = context.db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, result.journalEntryId))
      .get();
    expect(entry?.sourceType).toBe('CAPITAL');
    expect(entry?.sourceId).toBe(result.id);
  });

  it('rejects a zero or negative amount', () => {
    expect(() =>
      recordOwnerCapital(
        context.db,
        { businessDate: TODAY, paymentAccountId: CASH, amount: m(0) },
        ACTOR,
      ),
    ).toThrow(ValidationError);
  });
});

describe('lists', () => {
  it('shows expenses newest first with their category and account', () => {
    recordExpense(
      context.db,
      {
        businessDate: '2026-08-01',
        categoryAccountId: categoryId('Rent'),
        description: 'Rent',
        amount: m(50_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );
    recordExpense(
      context.db,
      {
        businessDate: '2026-08-15',
        categoryAccountId: categoryId('Electricity'),
        description: 'ECG top-up',
        amount: m(8_000),
        paymentAccountId: MOMO,
      },
      ACTOR,
    );

    const rows = listExpenses(context.db);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.description).toBe('ECG top-up');
    expect(rows[0]?.categoryName).toBe('Electricity');
    expect(rows[0]?.paymentAccountName).toBe('MTN MoMo');
  });

  it('shows income separately from expenses', () => {
    recordExpense(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: categoryId('Rent'),
        description: 'Rent',
        amount: m(1_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );
    recordIncome(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: incomeCategoryId('Commission'),
        description: 'Commission',
        amount: m(2_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );

    expect(listExpenses(context.db)).toHaveLength(1);
    expect(listIncomes(context.db)).toHaveLength(1);
  });
});
