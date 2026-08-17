import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { journalLines, paymentAccounts } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createCategory, createProduct, listCategories } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale } from '@/services/sale.service';
import { createCustomer } from '@/services/customer.service';
import { createSupplier } from '@/services/supplier.service';
import { createPurchase } from '@/services/purchase.service';
import { recordExpense } from '@/services/cashbook.service';
import { listExpenseCategories } from '@/services/payment-account.service';
import {
  checkBooksIntegrity,
  getChartOfAccounts,
  getGeneralLedger,
  getJournalEntry,
  getPayablesAgeing,
  getReceivablesAgeing,
  listJournalEntries,
} from '@/services/reporting/ledger.service';
import { minor, sum, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-17';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;

function accountIdByCode(code: string): number {
  const found = getChartOfAccounts(context.db).find((account) => account.code === code);
  if (!found) throw new Error(`No account ${code}`);
  return found.id;
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  CASH = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;
});

afterEach(() => {
  context.cleanup();
});

describe('chart of accounts', () => {
  it('returns a tree with headings above their children', () => {
    const chart = getChartOfAccounts(context.db);

    const cashHeading = chart.find((account) => account.code === ACCOUNT_CODES.CASH);
    const cashOnHand = chart.find((account) => account.code === '1001');

    expect(cashHeading?.isHeader).toBe(true);
    expect(cashOnHand?.isHeader).toBe(false);
    expect(cashOnHand?.parentId).toBe(cashHeading?.id);
    // Children are indented beneath their heading.
    expect(cashOnHand?.depth).toBe((cashHeading?.depth ?? 0) + 1);

    // And the heading appears before its child in the ordering.
    expect(chart.indexOf(cashHeading!)).toBeLessThan(chart.indexOf(cashOnHand!));
  });

  it('rolls a heading’s balance up from its children', () => {
    const id = createProduct(
      context.db,
      { name: 'Milo', costPrice: m(500), sellingPrice: m(800) },
      ACTOR,
    );
    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'OPENING_STOCK',
        items: [{ productId: id, direction: 'IN', qty: u(10), totalCost: m(5_000) }],
      },
      ACTOR,
    );
    createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(2) }],
        tenders: [{ paymentAccountId: CASH, amount: m(1_600) }],
      },
      ACTOR,
    );

    const chart = getChartOfAccounts(context.db);
    const cashHeading = chart.find((account) => account.code === ACCOUNT_CODES.CASH);
    const cashOnHand = chart.find((account) => account.code === '1001');

    // The heading itself has no postings, but rolls up its child's balance.
    expect(cashHeading?.balance).toBe(0);
    expect(cashHeading?.rollup).toBe(1_600);
    expect(cashOnHand?.balance).toBe(1_600);
  });

  it('shows sign-adjusted balances so each type reads naturally', () => {
    const id = createProduct(
      context.db,
      { name: 'Milo', costPrice: m(500), sellingPrice: m(800) },
      ACTOR,
    );
    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'OPENING_STOCK',
        items: [{ productId: id, direction: 'IN', qty: u(10), totalCost: m(5_000) }],
      },
      ACTOR,
    );
    createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(2) }],
        tenders: [{ paymentAccountId: CASH, amount: m(1_600) }],
      },
      ACTOR,
    );

    const chart = getChartOfAccounts(context.db);
    // Revenue is credit-normal and must read as a positive 16.00, not -16.00.
    expect(chart.find((a) => a.code === ACCOUNT_CODES.SALES_REVENUE)?.balance).toBe(1_600);
    // COGS is debit-normal and also reads positive.
    expect(chart.find((a) => a.code === ACCOUNT_CODES.COST_OF_GOODS_SOLD)?.balance).toBe(1_000);
  });
});

describe('journal', () => {
  function makeSale() {
    const id = createProduct(
      context.db,
      { name: 'Milo', costPrice: m(500), sellingPrice: m(800) },
      ACTOR,
    );
    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'OPENING_STOCK',
        items: [{ productId: id, direction: 'IN', qty: u(10), totalCost: m(5_000) }],
      },
      ACTOR,
    );
    return createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(2) }],
        tenders: [{ paymentAccountId: CASH, amount: m(1_600) }],
      },
      ACTOR,
    );
  }

  it('lists entries newest first and reports each as balanced', () => {
    makeSale();
    const entries = listJournalEntries(context.db, { from: TODAY, to: TODAY });

    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((entry) => entry.balanced)).toBe(true);
    // The sale is the most recent entry.
    expect(entries[0]?.sourceType).toBe('SALE');
  });

  /**
   * Regression guard for a real bug: drizzle emits UNQUALIFIED column names in
   * single-table queries, so a correlated subquery silently binds to the wrong
   * table and returns nonsense instead of failing. Comparing the list totals
   * against the per-entry detail catches any recurrence.
   */
  it('list totals agree with each entry’s own lines', () => {
    makeSale();
    recordExpense(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: listExpenseCategories(context.db).find((c) => c.name === 'Rent')!.id,
        description: 'Rent',
        amount: m(3_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );

    const entries = listJournalEntries(context.db);
    expect(entries.length).toBeGreaterThanOrEqual(3);

    for (const summary of entries) {
      const detail = getJournalEntry(context.db, summary.id);
      expect(summary.total, `${summary.entryNo} total`).toBe(detail.totalDebit);
      expect(summary.lineCount, `${summary.entryNo} line count`).toBe(detail.lines.length);
      expect(summary.balanced, `${summary.entryNo} balanced`).toBe(true);
      // Each entry must have its OWN total, not a repeat of some other entry's.
      expect(detail.totalDebit).toBe(detail.totalCredit);
    }

    // Distinct entries must not all report the same figure.
    const totals = new Set(entries.map((entry) => entry.total));
    expect(totals.size).toBeGreaterThan(1);
  });

  it('filters by kind and by account', () => {
    makeSale();

    expect(listJournalEntries(context.db, { sourceType: 'SALE' })).toHaveLength(1);
    expect(listJournalEntries(context.db, { sourceType: 'PURCHASE' })).toHaveLength(0);

    const cashLines = listJournalEntries(context.db, { accountId: accountIdByCode('1001') });
    expect(cashLines).toHaveLength(1);
    expect(cashLines[0]?.sourceType).toBe('SALE');
  });

  it('shows an entry’s lines with its subledger tags', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const id = createProduct(
      context.db,
      { name: 'Milo', costPrice: m(500), sellingPrice: m(800) },
      ACTOR,
    );
    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'OPENING_STOCK',
        items: [{ productId: id, direction: 'IN', qty: u(10), totalCost: m(5_000) }],
      },
      ACTOR,
    );
    const sale = createSale(
      context.db,
      { businessDate: TODAY, customerId, items: [{ productId: id, qty: u(2) }], tenders: [] },
      ACTOR,
    );

    const detail = getJournalEntry(context.db, sale.journalEntryId);
    expect(detail.balanced).toBe(true);
    expect(detail.totalDebit).toBe(detail.totalCredit);

    // The receivable line carries the customer's name.
    const receivable = detail.lines.find(
      (line) => line.accountCode === ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
    );
    expect(receivable?.customerName).toBe('Ama');
  });
});

describe('category product counts', () => {
  it('counts each category’s own products, not another table’s rows', () => {
    const drinks = createCategory(context.db, { name: 'Drinks' }, ACTOR);
    const food = createCategory(context.db, { name: 'Food' }, ACTOR);
    createCategory(context.db, { name: 'Empty' }, ACTOR);

    createProduct(
      context.db,
      { name: 'Cola', categoryId: drinks, costPrice: m(100), sellingPrice: m(200) },
      ACTOR,
    );
    createProduct(
      context.db,
      { name: 'Water', categoryId: drinks, costPrice: m(100), sellingPrice: m(200) },
      ACTOR,
    );
    createProduct(
      context.db,
      { name: 'Bread', categoryId: food, costPrice: m(100), sellingPrice: m(200) },
      ACTOR,
    );

    const counts = new Map(
      listCategories(context.db).map((category) => [category.name, category.productCount]),
    );
    expect(counts.get('Drinks')).toBe(2);
    expect(counts.get('Food')).toBe(1);
    expect(counts.get('Empty')).toBe(0);
  });
});

describe('general ledger', () => {
  it('produces a running balance that ends at the account balance', () => {
    const categoryId = listExpenseCategories(context.db).find((c) => c.name === 'Transport')!.id;

    recordExpense(
      context.db,
      {
        businessDate: '2026-08-01',
        categoryAccountId: categoryId,
        description: 'Taxi one',
        amount: m(1_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );
    recordExpense(
      context.db,
      {
        businessDate: '2026-08-05',
        categoryAccountId: categoryId,
        description: 'Taxi two',
        amount: m(2_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );

    const ledger = getGeneralLedger(context.db, categoryId);
    expect(ledger.lines).toHaveLength(2);
    // Oldest first, accumulating.
    expect(ledger.lines[0]?.runningBalance).toBe(1_000);
    expect(ledger.lines[1]?.runningBalance).toBe(3_000);
    expect(ledger.closingBalance).toBe(3_000);
    expect(ledger.account.balance).toBe(3_000);
  });

  it('carries an opening balance when a period is given', () => {
    const categoryId = listExpenseCategories(context.db).find((c) => c.name === 'Rent')!.id;

    recordExpense(
      context.db,
      {
        businessDate: '2026-07-01',
        categoryAccountId: categoryId,
        description: 'July rent',
        amount: m(50_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );
    recordExpense(
      context.db,
      {
        businessDate: '2026-08-01',
        categoryAccountId: categoryId,
        description: 'August rent',
        amount: m(50_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );

    const august = getGeneralLedger(context.db, categoryId, { from: '2026-08-01' });
    expect(august.openingBalance).toBe(50_000); // July carried forward
    expect(august.lines).toHaveLength(1);
    expect(august.closingBalance).toBe(100_000);
  });

  it('reads a credit-normal account the right way round', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = createProduct(
      context.db,
      { name: 'Milo', costPrice: m(500), sellingPrice: m(800) },
      ACTOR,
    );
    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10), unitCost: m(500) }],
        tenders: [],
      },
      ACTOR,
    );

    const ledger = getGeneralLedger(context.db, accountIdByCode(ACCOUNT_CODES.ACCOUNTS_PAYABLE));
    // A/P is credit-normal, so a credit INCREASES what is owed.
    expect(ledger.closingBalance).toBe(5_000);
    expect(ledger.lines[0]?.credit).toBe(5_000);
  });
});

describe('ageing', () => {
  function creditSale(businessDate: string, amountMinor: number, customerId: number) {
    const id = createProduct(
      context.db,
      { name: `P${Math.random()}`, costPrice: m(100), sellingPrice: m(amountMinor) },
      ACTOR,
    );
    createStockAdjustment(
      context.db,
      {
        businessDate: '2026-01-01',
        reason: 'OPENING_STOCK',
        items: [{ productId: id, direction: 'IN', qty: u(10), totalCost: m(1_000) }],
      },
      ACTOR,
    );
    return createSale(
      context.db,
      { businessDate, customerId, items: [{ productId: id, qty: u(1) }], tenders: [] },
      ACTOR,
    );
  }

  it('places each debt in the right bucket by age', () => {
    const customerId = createCustomer(context.db, { name: 'Ama', phone: '024' }, ACTOR);

    creditSale('2026-08-17', 1_000, customerId); // today -> not due
    creditSale('2026-08-01', 2_000, customerId); // 16 days
    creditSale('2026-07-01', 3_000, customerId); // 47 days
    creditSale('2026-06-01', 4_000, customerId); // 77 days
    creditSale('2026-01-01', 5_000, customerId); // way over 90

    const ageing = getReceivablesAgeing(context.db, '2026-08-17');
    expect(ageing).toHaveLength(1);

    const row = ageing[0]!;
    expect(row.current).toBe(1_000);
    expect(row.days1to30).toBe(2_000);
    expect(row.days31to60).toBe(3_000);
    expect(row.days61to90).toBe(4_000);
    expect(row.over90).toBe(5_000);
    expect(row.total).toBe(15_000);
    expect(row.oldestDate).toBe('2026-01-01');
  });

  it('adds up to the same total as the receivables control account', () => {
    const ama = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const kofi = createCustomer(context.db, { name: 'Kofi' }, ACTOR);

    creditSale('2026-08-01', 2_500, ama);
    creditSale('2026-07-15', 4_000, kofi);

    const ageing = getReceivablesAgeing(context.db, '2026-08-17');
    const ageingTotal = sum(ageing.map((row) => row.total));

    const control = getChartOfAccounts(context.db).find(
      (account) => account.code === ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
    );
    expect(ageingTotal).toBe(control?.balance);
  });

  it('leaves out anything already paid', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const id = createProduct(
      context.db,
      { name: 'Milo', costPrice: m(500), sellingPrice: m(800) },
      ACTOR,
    );
    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'OPENING_STOCK',
        items: [{ productId: id, direction: 'IN', qty: u(10), totalCost: m(5_000) }],
      },
      ACTOR,
    );
    // Fully paid at the till — should not appear.
    createSale(
      context.db,
      {
        businessDate: TODAY,
        customerId,
        items: [{ productId: id, qty: u(1) }],
        tenders: [{ paymentAccountId: CASH, amount: m(800) }],
      },
      ACTOR,
    );

    expect(getReceivablesAgeing(context.db, TODAY)).toHaveLength(0);
  });

  it('ages what is owed to suppliers the same way', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = createProduct(
      context.db,
      { name: 'Milo', costPrice: m(500), sellingPrice: m(800) },
      ACTOR,
    );

    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: '2026-08-17',
        items: [{ productId: id, qty: u(2), unitCost: m(500) }],
        tenders: [],
      },
      ACTOR,
    );
    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: '2026-05-01',
        items: [{ productId: id, qty: u(4), unitCost: m(500) }],
        tenders: [],
      },
      ACTOR,
    );

    const ageing = getPayablesAgeing(context.db, '2026-08-17');
    expect(ageing).toHaveLength(1);
    expect(ageing[0]?.current).toBe(1_000);
    expect(ageing[0]?.over90).toBe(2_000);
    expect(ageing[0]?.total).toBe(3_000);
  });
});

describe('books integrity check', () => {
  it('reports healthy books after ordinary trading', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = createProduct(
      context.db,
      { name: 'Milo', costPrice: m(500), sellingPrice: m(1_000) },
      ACTOR,
    );

    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(20), unitCost: m(500) }],
        tenders: [],
      },
      ACTOR,
    );
    createSale(
      context.db,
      { businessDate: TODAY, customerId, items: [{ productId: id, qty: u(5) }], tenders: [] },
      ACTOR,
    );
    recordExpense(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: listExpenseCategories(context.db).find((c) => c.name === 'Rent')!.id,
        description: 'Rent',
        amount: m(2_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );

    const integrity = checkBooksIntegrity(context.db);
    expect(integrity.trialBalanced).toBe(true);
    expect(integrity.unbalancedEntries).toHaveLength(0);
    expect(integrity.receivablesMatch).toBe(true);
    expect(integrity.payablesMatch).toBe(true);
    expect(integrity.untracedEntries).toBe(0);
  });

  it('detects an unbalanced entry if one is forced into the database', () => {
    const id = createProduct(
      context.db,
      { name: 'Milo', costPrice: m(500), sellingPrice: m(800) },
      ACTOR,
    );
    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'OPENING_STOCK',
        items: [{ productId: id, direction: 'IN', qty: u(10), totalCost: m(5_000) }],
      },
      ACTOR,
    );

    expect(checkBooksIntegrity(context.db).trialBalanced).toBe(true);

    // Tamper directly, bypassing every service-layer guard.
    const line = context.db.select().from(journalLines).all()[0]!;
    context.db
      .update(journalLines)
      .set({ debitMinor: line.debitMinor + 1 })
      .where(eq(journalLines.id, line.id))
      .run();

    const integrity = checkBooksIntegrity(context.db);
    expect(integrity.trialBalanced).toBe(false);
    expect(integrity.unbalancedEntries.length).toBeGreaterThan(0);
    expect(integrity.difference).not.toBe(0);
  });

  it('detects a receivable that lost its customer tag', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const id = createProduct(
      context.db,
      { name: 'Milo', costPrice: m(500), sellingPrice: m(800) },
      ACTOR,
    );
    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'OPENING_STOCK',
        items: [{ productId: id, direction: 'IN', qty: u(10), totalCost: m(5_000) }],
      },
      ACTOR,
    );
    createSale(
      context.db,
      { businessDate: TODAY, customerId, items: [{ productId: id, qty: u(2) }], tenders: [] },
      ACTOR,
    );

    expect(checkBooksIntegrity(context.db).receivablesMatch).toBe(true);

    // Strip the subledger tag — the control account would then disagree with
    // the sum of customer balances, which is exactly what this check catches.
    context.db.update(journalLines).set({ customerId: null }).run();

    expect(checkBooksIntegrity(context.db).receivablesMatch).toBe(false);
  });
});
