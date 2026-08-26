import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts } from '@/db/schema';
import { createCategory, createProduct, countProducts, getStockSummary, listProducts } from '@/services/catalog.service';
import { createSupplier } from '@/services/supplier.service';
import { createCustomer } from '@/services/customer.service';
import { countCustomers, listCustomers } from '@/services/customer.service';
import { countSuppliers, listSuppliers } from '@/services/supplier.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import {
  countPurchases,
  createPurchase,
  getFilteredPurchasesSummary,
  listPurchases,
} from '@/services/purchase.service';
import {
  countExpenses,
  getFilteredExpensesByCategory,
  getFilteredExpensesSummary,
  listExpenses,
  recordExpense,
} from '@/services/cashbook.service';
import { createCategory as createCashbookCategory, listExpenseCategories } from '@/services/payment-account.service';
import { countStockLedger, getStockLedger } from '@/services/inventory.service';
import { createSale } from '@/services/sale.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * Filters on the remaining modules.
 *
 * Same two properties as the sales suite: the filter narrows in SQL before any
 * page limit, and the totals shown above a table are computed from the same
 * clause as the table.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;
let MOMO = 0;
let DRINKS = 0;
let FOOD = 0;
let COKE = 0;
let RICE = 0;
let KASAPREKO = 0;
let MADINA = 0;

beforeEach(() => {
  context = createTestDatabase();
  const insertUser = context.connection.prepare(
    'INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)',
  );
  insertUser.run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  insertUser.run(2, 'ama', 'Ama', 'STAFF', 'scrypt$1$2$3$a$b');

  const accounts = context.db.select().from(paymentAccounts).all();
  CASH = accounts.find((account) => account.kind === 'CASH')!.id;
  MOMO = accounts.find((account) => account.kind === 'MOBILE_MONEY')!.id;

  DRINKS = createCategory(context.db, { name: 'Drinks' }, ACTOR);
  FOOD = createCategory(context.db, { name: 'Food' }, ACTOR);

  COKE = createProduct(
    context.db,
    { name: 'Coca-Cola 500ml', sku: 'COKE-500', categoryId: DRINKS, costPrice: m(300), sellingPrice: m(500), unit: 'pcs', minStock: u(10) },
    ACTOR,
  );
  RICE = createProduct(
    context.db,
    { name: 'Rice 5kg', sku: 'RICE-5', categoryId: FOOD, costPrice: m(4_000), sellingPrice: m(6_000), unit: 'bag', minStock: u(5) },
    ACTOR,
  );

  KASAPREKO = createSupplier(context.db, { name: 'Kasapreko Distributors', phone: '0302000111' }, ACTOR);
  MADINA = createSupplier(context.db, { name: 'Madina Market Wholesale', phone: '0244777888' }, ACTOR);
});

afterEach(() => {
  context.cleanup();
});

function delivery(
  date: string,
  supplierId: number,
  productId: number,
  quantity: number,
  unitCost: number,
  paid: number,
  account = CASH,
): number {
  return createPurchase(
    context.db,
    {
      supplierId,
      businessDate: date,
      items: [{ productId, qty: u(quantity), unitCost: m(unitCost) }],
      tenders: paid > 0 ? [{ paymentAccountId: account, amount: m(paid) }] : [],
    },
    ACTOR,
  ).purchaseId;
}

describe('purchase filters', () => {
  it('narrows by supplier, product, category and payment method', () => {
    delivery('2026-08-02', KASAPREKO, COKE, 100, 300, 30_000);
    delivery('2026-08-03', MADINA, RICE, 10, 4_000, 40_000, MOMO);

    const range = { from: '2026-08-01', to: '2026-08-31' };
    expect(countPurchases(context.db, { ...range, supplierId: KASAPREKO })).toBe(1);
    expect(countPurchases(context.db, { ...range, productId: RICE })).toBe(1);
    expect(countPurchases(context.db, { ...range, categoryId: DRINKS })).toBe(1);
    expect(countPurchases(context.db, { ...range, paymentKind: 'MOBILE_MONEY' })).toBe(1);
    expect(countPurchases(context.db, { ...range, paymentAccountId: CASH })).toBe(1);
  });

  it('tells fully paid from partly paid from outstanding', () => {
    delivery('2026-08-02', KASAPREKO, COKE, 100, 300, 30_000); // paid in full
    delivery('2026-08-03', MADINA, RICE, 10, 4_000, 10_000); // part paid
    delivery('2026-08-04', MADINA, RICE, 5, 4_000, 0); // nothing paid

    const range = { from: '2026-08-01', to: '2026-08-31' };
    expect(countPurchases(context.db, { ...range, paymentState: 'paid' })).toBe(1);
    expect(countPurchases(context.db, { ...range, paymentState: 'partial' })).toBe(1);
    // "Outstanding" covers both the part-paid and the unpaid.
    expect(countPurchases(context.db, { ...range, paymentState: 'outstanding' })).toBe(2);
  });

  it('finds a credit delivery sitting past the page limit', () => {
    const owing = delivery('2026-08-01', MADINA, RICE, 5, 4_000, 0);
    for (let day = 2; day <= 20; day++) {
      delivery(`2026-08-${String(day).padStart(2, '0')}`, KASAPREKO, COKE, 10, 300, 3_000);
    }

    const filters = {
      from: '2026-08-01',
      to: '2026-08-31',
      paymentState: 'outstanding' as const,
    };
    expect(countPurchases(context.db, filters)).toBe(1);
    expect(listPurchases(context.db, { ...filters, limit: 5 })[0]?.id).toBe(owing);
  });

  it('searches purchase number, supplier and product', () => {
    const id = delivery('2026-08-02', KASAPREKO, COKE, 100, 300, 30_000);
    const row = listPurchases(context.db, {}).find((item) => item.id === id)!;

    const range = { from: '2026-08-01', to: '2026-08-31' };
    for (const term of [row.purchaseNo, 'kasapreko', '0302', 'coca', 'COKE-500']) {
      expect(listPurchases(context.db, { ...range, search: term }).map((r) => r.id)).toContain(id);
    }
  });

  it('totals only the deliveries the filter selects', () => {
    delivery('2026-08-02', KASAPREKO, COKE, 100, 300, 30_000); // 300.00
    delivery('2026-08-03', MADINA, RICE, 10, 4_000, 10_000); // 400.00, 300.00 owing
    delivery('2026-09-02', KASAPREKO, COKE, 100, 300, 30_000); // outside the window

    const filters = { from: '2026-08-01', to: '2026-08-31' };
    const summary = getFilteredPurchasesSummary(context.db, filters);
    const rows = listPurchases(context.db, filters);

    expect(summary.count).toBe(2);
    expect(summary.total).toBe(rows.reduce((total, row) => total + row.totalMinor, 0));
    expect(summary.paid).toBe(40_000);
    expect(summary.outstanding).toBe(30_000);
    expect(summary.total).toBe(summary.paid + summary.outstanding);
  });

  it('reports nothing rather than throwing when nothing matches', () => {
    delivery('2026-08-02', KASAPREKO, COKE, 100, 300, 30_000);
    const filters = { from: '2026-01-01', to: '2026-01-31' };
    expect(countPurchases(context.db, filters)).toBe(0);
    expect(getFilteredPurchasesSummary(context.db, filters)).toMatchObject({
      count: 0,
      total: 0,
      paid: 0,
      outstanding: 0,
    });
  });

  it('pages without repeating a delivery', () => {
    for (let day = 1; day <= 15; day++) {
      delivery(`2026-08-${String(day).padStart(2, '0')}`, KASAPREKO, COKE, 10, 300, 3_000);
    }
    const filters = { from: '2026-08-01', to: '2026-08-31' };
    expect(countPurchases(context.db, filters)).toBe(15);

    const seen = new Set<number>();
    for (let page = 0; page < 3; page++) {
      for (const row of listPurchases(context.db, { ...filters, limit: 6, offset: page * 6 })) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
    }
    expect(seen.size).toBe(15);
  });
});

describe('product and stock-status filters', () => {
  function stock(productId: number, quantity: number, cost: number): void {
    createStockAdjustment(
      context.db,
      {
        businessDate: '2026-08-01',
        reason: 'OPENING_STOCK',
        items: [{ productId, direction: 'IN', qty: u(quantity), totalCost: m(cost) }],
      },
      ACTOR,
    );
  }

  it('finds low stock and out of stock, in SQL', () => {
    stock(COKE, 3, 900); // below its minimum of 10
    // RICE is left at zero, so it is out of stock.

    expect(countProducts(context.db, { stockStatus: 'low' })).toBe(2); // out counts as low
    expect(countProducts(context.db, { stockStatus: 'out' })).toBe(1);
    expect(listProducts(context.db, { stockStatus: 'out' })[0]?.id).toBe(RICE);
  });

  it('finds a low-stock product sorted past the page limit', () => {
    // Enough products that the low-stock one cannot be on the first page by name.
    for (let index = 0; index < 30; index++) {
      createProduct(
        context.db,
        {
          name: `Aaa filler ${String(index).padStart(3, '0')}`,
          costPrice: m(100),
          sellingPrice: m(200),
          unit: 'pcs',
          minStock: u(0),
          trackInventory: false,
        },
        ACTOR,
      );
    }
    stock(COKE, 3, 900);

    const low = listProducts(context.db, { stockStatus: 'low', limit: 5 });
    expect(low.map((row) => row.id)).toContain(COKE);
  });

  it('narrows by category and by the supplier who delivered it', () => {
    delivery('2026-08-02', KASAPREKO, COKE, 100, 300, 30_000);

    expect(countProducts(context.db, { categoryId: DRINKS })).toBe(1);
    expect(countProducts(context.db, { supplierId: KASAPREKO })).toBe(1);
    expect(countProducts(context.db, { supplierId: MADINA })).toBe(0);
  });

  it('searches name, SKU and barcode', () => {
    expect(listProducts(context.db, { search: 'coca' }).map((r) => r.id)).toEqual([COKE]);
    expect(listProducts(context.db, { search: 'RICE-5' }).map((r) => r.id)).toEqual([RICE]);
    expect(listProducts(context.db, { search: 'zzz' })).toEqual([]);
  });

  it('sorts by stock value and by quantity, ascending and descending', () => {
    stock(COKE, 100, 30_000);
    stock(RICE, 2, 8_000);

    expect(
      listProducts(context.db, { sort: 'value', direction: 'desc' }).map((row) => row.id)[0],
    ).toBe(COKE);
    expect(
      listProducts(context.db, { sort: 'quantity', direction: 'asc' }).map((row) => row.id)[0],
    ).toBe(RICE);
  });

  /**
   * The summary used to fetch the first five hundred products by name and count
   * them in JavaScript, so a bigger shop was shown a stock value and a reorder
   * count that silently excluded everything sorted after the five hundredth.
   */
  it('summarises the whole catalogue, not just the first page of it', () => {
    stock(COKE, 100, 30_000);
    stock(RICE, 2, 8_000);
    for (let index = 0; index < 600; index++) {
      createProduct(
        context.db,
        {
          name: `Zzz filler ${String(index).padStart(4, '0')}`,
          costPrice: m(100),
          sellingPrice: m(200),
          unit: 'pcs',
          trackInventory: false,
        },
        ACTOR,
      );
    }

    const summary = getStockSummary(context.db);
    expect(summary.productCount).toBe(602);
    expect(summary.totalStockValue).toBe(38_000);
    // RICE holds 2 against a minimum of 5, so it is low but not out.
    expect(summary.lowStockCount).toBe(1);
    expect(summary.outOfStockCount).toBe(0);
  });

  it('describes exactly the products a filter selects', () => {
    stock(COKE, 100, 30_000);
    stock(RICE, 2, 8_000);

    const selection = getStockSummary(context.db, { categoryId: FOOD });
    expect(selection.productCount).toBe(1);
    expect(selection.totalStockValue).toBe(8_000);
  });
});

describe('stock movement filters', () => {
  it('narrows by product, category, movement type and date', () => {
    createStockAdjustment(
      context.db,
      {
        businessDate: '2026-08-01',
        reason: 'OPENING_STOCK',
        items: [
          { productId: COKE, direction: 'IN', qty: u(100), totalCost: m(30_000) },
          { productId: RICE, direction: 'IN', qty: u(10), totalCost: m(40_000) },
        ],
      },
      ACTOR,
    );
    createSale(
      context.db,
      {
        businessDate: '2026-08-05',
        items: [{ productId: COKE, qty: u(5) }],
        tenders: [{ paymentAccountId: CASH, amount: m(2_500) }],
      },
      ACTOR,
    );

    expect(countStockLedger(context.db, {})).toBe(3);
    expect(countStockLedger(context.db, { productId: COKE })).toBe(2);
    expect(countStockLedger(context.db, { categoryId: FOOD })).toBe(1);
    expect(countStockLedger(context.db, { movementType: 'SALE' })).toBe(1);
    expect(countStockLedger(context.db, { from: '2026-08-05', to: '2026-08-05' })).toBe(1);
  });

  it('searches the product name, SKU and the source reference', () => {
    createStockAdjustment(
      context.db,
      {
        businessDate: '2026-08-01',
        reason: 'OPENING_STOCK',
        items: [{ productId: COKE, direction: 'IN', qty: u(100), totalCost: m(30_000) }],
      },
      ACTOR,
    );

    expect(countStockLedger(context.db, { search: 'coca' })).toBe(1);
    expect(countStockLedger(context.db, { search: 'COKE-500' })).toBe(1);
    expect(countStockLedger(context.db, { search: 'zzz' })).toBe(0);
  });

  /**
   * Filtering the ledger must not change what the shop is told it holds. The
   * running balance on each row was recorded when the movement happened; a
   * filter shows fewer rows and the same balances.
   */
  it('never alters the recorded balances', () => {
    createStockAdjustment(
      context.db,
      {
        businessDate: '2026-08-01',
        reason: 'OPENING_STOCK',
        items: [{ productId: COKE, direction: 'IN', qty: u(100), totalCost: m(30_000) }],
      },
      ACTOR,
    );
    createSale(
      context.db,
      {
        businessDate: '2026-08-05',
        items: [{ productId: COKE, qty: u(5) }],
        tenders: [{ paymentAccountId: CASH, amount: m(2_500) }],
      },
      ACTOR,
    );

    const unfiltered = getStockLedger(context.db, { productId: COKE });
    const narrowed = getStockLedger(context.db, { productId: COKE, movementType: 'SALE' });

    const sale = unfiltered.find((row) => row.movementType === 'SALE')!;
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]?.balanceQty).toBe(sale.balanceQty);
    expect(narrowed[0]?.balanceValue).toBe(sale.balanceValue);

    // And the product's own cached figures are untouched by any of this.
    expect(listProducts(context.db, { id: COKE })[0]?.qtyOnHand).toBe(fromUnits(95));
  });
});

describe('expense filters', () => {
  let RENT = 0;
  let TRANSPORT = 0;

  function spend(
    date: string,
    categoryAccountId: number,
    amount: number,
    description: string,
    account = CASH,
  ): void {
    recordExpense(
      context.db,
      { businessDate: date, categoryAccountId, description, amount: m(amount), paymentAccountId: account },
      ACTOR,
    );
  }

  beforeEach(() => {
    RENT = createCashbookCategory(context.db, 'EXPENSE', 'Shed rental', ACTOR);
    TRANSPORT = createCashbookCategory(context.db, 'EXPENSE', 'Market runs', ACTOR);
  });

  it('narrows by date, category, payment method and search', () => {
    spend('2026-08-02', RENT, 80_000, 'Shop rent for August');
    spend('2026-08-03', TRANSPORT, 4_500, 'Taxi to Madina market', MOMO);
    spend('2026-09-02', RENT, 80_000, 'Shop rent for September');

    const range = { from: '2026-08-01', to: '2026-08-31' };
    expect(countExpenses(context.db, range)).toBe(2);
    expect(countExpenses(context.db, { ...range, categoryAccountId: RENT })).toBe(1);
    expect(countExpenses(context.db, { ...range, paymentAccountId: MOMO })).toBe(1);
    expect(countExpenses(context.db, { ...range, search: 'madina' })).toBe(1);
    expect(countExpenses(context.db, { ...range, staffId: 1 })).toBe(2);
    expect(countExpenses(context.db, { ...range, staffId: 2 })).toBe(0);
  });

  it('narrows by amount', () => {
    spend('2026-08-02', RENT, 80_000, 'Rent');
    spend('2026-08-03', TRANSPORT, 4_500, 'Taxi');

    const range = { from: '2026-08-01', to: '2026-08-31' };
    expect(countExpenses(context.db, { ...range, minAmount: m(10_000) })).toBe(1);
    expect(countExpenses(context.db, { ...range, maxAmount: m(10_000) })).toBe(1);
  });

  it('reports the count, total and average of exactly what is filtered', () => {
    spend('2026-08-02', RENT, 80_000, 'Rent');
    spend('2026-08-03', TRANSPORT, 4_000, 'Taxi');
    spend('2026-08-04', TRANSPORT, 6_000, 'Taxi');
    spend('2026-09-01', RENT, 80_000, 'Next month');

    const filters = { from: '2026-08-01', to: '2026-08-31', categoryAccountId: TRANSPORT };
    const summary = getFilteredExpensesSummary(context.db, filters);
    const rows = listExpenses(context.db, filters);

    expect(summary.count).toBe(2);
    expect(rows).toHaveLength(2);
    expect(summary.total).toBe(10_000);
    expect(summary.average).toBe(5_000);
    expect(summary.total).toBe(rows.reduce((total, row) => total + row.amountMinor, 0));
  });

  it('splits by category over the same filter as the table', () => {
    spend('2026-08-02', RENT, 80_000, 'Rent');
    spend('2026-08-03', TRANSPORT, 4_000, 'Taxi');
    spend('2026-09-01', RENT, 80_000, 'Next month');

    const filters = { from: '2026-08-01', to: '2026-08-31' };
    const byCategory = getFilteredExpensesByCategory(context.db, filters);
    const summary = getFilteredExpensesSummary(context.db, filters);

    expect(byCategory).toHaveLength(2);
    expect(byCategory.reduce((total, row) => total + row.total, 0)).toBe(summary.total);
  });

  it('shows an average of nothing rather than dividing by zero', () => {
    const summary = getFilteredExpensesSummary(context.db, { from: '2026-08-01', to: '2026-08-31' });
    expect(summary).toMatchObject({ count: 0, total: 0, average: 0 });
  });
});

describe('customer and supplier balance filters', () => {
  it('finds who owes from the ledger, not from a flag', () => {
    const kofi = createCustomer(context.db, { name: 'Kofi Mensah' }, ACTOR);
    createCustomer(context.db, { name: 'Ama Serwaa' }, ACTOR);

    createStockAdjustment(
      context.db,
      {
        businessDate: '2026-08-01',
        reason: 'OPENING_STOCK',
        items: [{ productId: RICE, direction: 'IN', qty: u(10), totalCost: m(40_000) }],
      },
      ACTOR,
    );
    createSale(
      context.db,
      {
        businessDate: '2026-08-02',
        customerId: kofi,
        items: [{ productId: RICE, qty: u(1) }],
        tenders: [],
      },
      ACTOR,
    );

    expect(countCustomers(context.db, { balanceState: 'owing' })).toBe(1);
    expect(listCustomers(context.db, { balanceState: 'owing' })[0]?.id).toBe(kofi);
    expect(countCustomers(context.db, { balanceState: 'zero' })).toBe(1);
  });

  it('finds a debtor sorted past the page limit', () => {
    for (let index = 0; index < 30; index++) {
      createCustomer(context.db, { name: `Aaa customer ${String(index).padStart(3, '0')}` }, ACTOR);
    }
    const zoe = createCustomer(context.db, { name: 'Zoe Owusu' }, ACTOR);

    createStockAdjustment(
      context.db,
      {
        businessDate: '2026-08-01',
        reason: 'OPENING_STOCK',
        items: [{ productId: RICE, direction: 'IN', qty: u(10), totalCost: m(40_000) }],
      },
      ACTOR,
    );
    createSale(
      context.db,
      {
        businessDate: '2026-08-02',
        customerId: zoe,
        items: [{ productId: RICE, qty: u(1) }],
        tenders: [],
      },
      ACTOR,
    );

    expect(countCustomers(context.db, { balanceState: 'owing' })).toBe(1);
    expect(listCustomers(context.db, { balanceState: 'owing', limit: 5 })[0]?.id).toBe(zoe);
  });

  it('finds who the shop owes from actual payable entries', () => {
    delivery('2026-08-02', MADINA, RICE, 10, 4_000, 0); // nothing paid
    delivery('2026-08-03', KASAPREKO, COKE, 10, 300, 3_000); // paid in full

    expect(countSuppliers(context.db, { balanceState: 'owing' })).toBe(1);
    expect(listSuppliers(context.db, { balanceState: 'owing' })[0]?.id).toBe(MADINA);
  });

  it('searches customers and suppliers on more than the name', () => {
    createCustomer(context.db, { name: 'Kofi Mensah', phone: '0244000111', email: 'kofi@example.com' }, ACTOR);

    expect(countCustomers(context.db, { search: '0244' })).toBe(1);
    expect(countCustomers(context.db, { search: 'example.com' })).toBe(1);
    expect(countSuppliers(context.db, { search: 'madina' })).toBe(1);
  });

  it('sorts by balance', () => {
    delivery('2026-08-02', MADINA, RICE, 10, 4_000, 0);
    delivery('2026-08-03', KASAPREKO, COKE, 10, 300, 0);

    const highestFirst = listSuppliers(context.db, { sort: 'balance', direction: 'desc' });
    expect(highestFirst[0]?.id).toBe(MADINA);
  });
});

describe('expense categories offered by the filter', () => {
  it('come from the shop, not from a hard-coded list', () => {
    const before = listExpenseCategories(context.db).length;
    createCashbookCategory(context.db, 'EXPENSE', 'Night watchman', ACTOR);
    expect(listExpenseCategories(context.db).length).toBe(before + 1);
  });
});
