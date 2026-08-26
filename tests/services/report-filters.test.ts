import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts } from '@/db/schema';
import { createCategory, createProduct } from '@/services/catalog.service';
import { createCustomer } from '@/services/customer.service';
import { createSupplier } from '@/services/supplier.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createPurchase } from '@/services/purchase.service';
import { createSale } from '@/services/sale.service';
import {
  getPurchasesByDay,
  getPurchasesByProduct,
  getPurchasesBySupplier,
  getSalesByCategory,
  getSalesByCustomer,
  getSalesByDay,
  getSalesByPaymentMethod,
  getSalesByProduct,
  getStockValuation,
} from '@/services/reporting/operations.service';
import { getProfitAndLoss, getCashFlow } from '@/services/reporting/financial.service';
import { minor, sum, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * Filters on the reports.
 *
 * The reports are the figures a shop takes to its accountant, so the bar is
 * higher than "the filter narrows something": a filtered report must still tie
 * back to the ledger, and a report over a period with no trading must say
 * nothing rather than say something wrong.
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
let KOFI = 0;
let AMA = 0;
let KASAPREKO = 0;
let MADINA = 0;

const AUGUST = { from: '2026-08-01', to: '2026-08-31' };

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');

  const accounts = context.db.select().from(paymentAccounts).all();
  CASH = accounts.find((account) => account.kind === 'CASH')!.id;
  MOMO = accounts.find((account) => account.kind === 'MOBILE_MONEY')!.id;

  DRINKS = createCategory(context.db, { name: 'Drinks' }, ACTOR);
  FOOD = createCategory(context.db, { name: 'Food' }, ACTOR);

  COKE = createProduct(
    context.db,
    { name: 'Coca-Cola 500ml', categoryId: DRINKS, costPrice: m(300), sellingPrice: m(500), unit: 'pcs' },
    ACTOR,
  );
  RICE = createProduct(
    context.db,
    { name: 'Rice 5kg', categoryId: FOOD, costPrice: m(4_000), sellingPrice: m(6_000), unit: 'bag' },
    ACTOR,
  );

  KOFI = createCustomer(context.db, { name: 'Kofi Mensah' }, ACTOR);
  AMA = createCustomer(context.db, { name: 'Ama Serwaa' }, ACTOR);
  KASAPREKO = createSupplier(context.db, { name: 'Kasapreko Distributors' }, ACTOR);
  MADINA = createSupplier(context.db, { name: 'Madina Market Wholesale' }, ACTOR);

  createStockAdjustment(
    context.db,
    {
      businessDate: '2026-07-31',
      reason: 'OPENING_STOCK',
      items: [
        { productId: COKE, direction: 'IN', qty: u(500), totalCost: m(150_000) },
        { productId: RICE, direction: 'IN', qty: u(100), totalCost: m(400_000) },
      ],
    },
    ACTOR,
  );
});

afterEach(() => {
  context.cleanup();
});

function sale(
  date: string,
  productId: number,
  quantity: number,
  unitPrice: number,
  options: { customerId?: number; account?: number } = {},
): void {
  const total = quantity * unitPrice;
  createSale(
    context.db,
    {
      businessDate: date,
      ...(options.customerId !== undefined ? { customerId: options.customerId } : {}),
      items: [{ productId, qty: u(quantity) }],
      tenders: [{ paymentAccountId: options.account ?? CASH, amount: m(total) }],
    },
    ACTOR,
  );
}

describe('the sales report', () => {
  it('narrows every table by date', () => {
    sale('2026-07-15', COKE, 10, 500);
    sale('2026-08-05', COKE, 10, 500);
    sale('2026-09-05', COKE, 10, 500);

    const byDay = getSalesByDay(context.db, AUGUST);
    expect(byDay).toHaveLength(1);
    expect(byDay[0]?.businessDate).toBe('2026-08-05');
    expect(sum(byDay.map((row) => row.total))).toBe(5_000);
  });

  it('narrows by customer', () => {
    sale('2026-08-05', COKE, 10, 500, { customerId: KOFI });
    sale('2026-08-06', COKE, 4, 500, { customerId: AMA });

    const filters = { ...AUGUST, customerId: KOFI };
    expect(sum(getSalesByDay(context.db, filters).map((row) => row.total))).toBe(5_000);
    expect(getSalesByCustomer(context.db, filters)).toHaveLength(1);
  });

  it('narrows by payment method, and the tender table agrees', () => {
    sale('2026-08-05', COKE, 10, 500, { account: CASH });
    sale('2026-08-06', COKE, 4, 500, { account: MOMO });

    const cashOnly = { ...AUGUST, paymentAccountId: CASH };
    expect(sum(getSalesByDay(context.db, cashOnly).map((row) => row.total))).toBe(5_000);

    const byMethod = getSalesByPaymentMethod(context.db, cashOnly);
    expect(byMethod).toHaveLength(1);
    expect(byMethod[0]?.received).toBe(5_000);
  });

  /**
   * A product filter narrows the by-product and by-category tables to the
   * matching LINES, which is what "sales of Coca-Cola" means there.
   */
  it('narrows the by-product table to the matching lines only', () => {
    createSale(
      context.db,
      {
        businessDate: '2026-08-05',
        items: [
          { productId: COKE, qty: u(10) },
          { productId: RICE, qty: u(1) },
        ],
        tenders: [{ paymentAccountId: CASH, amount: m(11_000) }],
      },
      ACTOR,
    );

    const byProduct = getSalesByProduct(context.db, { ...AUGUST, productId: COKE });
    expect(byProduct).toHaveLength(1);
    expect(byProduct[0]?.productId).toBe(COKE);
    expect(byProduct[0]?.revenue).toBe(5_000);

    const byCategory = getSalesByCategory(context.db, { ...AUGUST, categoryId: DRINKS });
    expect(byCategory).toHaveLength(1);
    expect(byCategory[0]?.revenue).toBe(5_000);
  });

  /**
   * On the sale-level tables the same filter means "sales that CONTAINED it",
   * and the figures stay whole-sale figures — a receipt's tax and tender cannot
   * be split across its lines. The report page says so above the tables; this
   * pins the behaviour so it cannot drift away from what the page claims.
   */
  it('keeps whole-sale figures on the sale-level tables', () => {
    createSale(
      context.db,
      {
        businessDate: '2026-08-05',
        items: [
          { productId: COKE, qty: u(10) },
          { productId: RICE, qty: u(1) },
        ],
        tenders: [{ paymentAccountId: CASH, amount: m(11_000) }],
      },
      ACTOR,
    );

    const byDay = getSalesByDay(context.db, { ...AUGUST, productId: COKE });
    expect(byDay).toHaveLength(1);
    expect(byDay[0]?.total).toBe(11_000);
  });

  it('returns nothing at all for a period with no trading', () => {
    sale('2026-08-05', COKE, 10, 500);

    const january = { from: '2026-01-01', to: '2026-01-31' };
    expect(getSalesByDay(context.db, january)).toEqual([]);
    expect(getSalesByProduct(context.db, january)).toEqual([]);
    expect(getSalesByCategory(context.db, january)).toEqual([]);
    expect(getSalesByCustomer(context.db, january)).toEqual([]);
    expect(getSalesByPaymentMethod(context.db, january)).toEqual([]);
  });

  it('returns nothing for a filter that matches no sales', () => {
    sale('2026-08-05', COKE, 10, 500);
    expect(getSalesByDay(context.db, { ...AUGUST, customerId: 9_999 })).toEqual([]);
    expect(getSalesByProduct(context.db, { ...AUGUST, productId: 9_999 })).toEqual([]);
  });

  /**
   * An unfiltered sales report must still agree with the Profit & Loss for the
   * same period. Adding filters cannot be allowed to change what the
   * unfiltered report says.
   */
  it('still ties to the Profit & Loss when no filter is applied', () => {
    sale('2026-08-05', COKE, 10, 500);
    sale('2026-08-06', RICE, 2, 6_000);

    const byDay = getSalesByDay(context.db, AUGUST);
    const pl = getProfitAndLoss(context.db, AUGUST);

    expect(sum(byDay.map((row) => row.net))).toBe(pl.netSales);
    expect(sum(byDay.map((row) => row.cogs))).toBe(pl.costOfGoodsSold);
  });
});

describe('the purchase report', () => {
  function delivery(
    date: string,
    supplierId: number,
    productId: number,
    quantity: number,
    unitCost: number,
    account = CASH,
  ): void {
    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: date,
        items: [{ productId, qty: u(quantity), unitCost: m(unitCost) }],
        tenders: [{ paymentAccountId: account, amount: m(quantity * unitCost) }],
      },
      ACTOR,
    );
  }

  it('narrows by supplier, product, category and payment method', () => {
    delivery('2026-08-02', KASAPREKO, COKE, 100, 300);
    delivery('2026-08-03', MADINA, RICE, 10, 4_000, MOMO);

    expect(getPurchasesBySupplier(context.db, { ...AUGUST, supplierId: KASAPREKO })).toHaveLength(1);
    expect(getPurchasesByProduct(context.db, { ...AUGUST, productId: RICE })).toHaveLength(1);
    expect(sum(getPurchasesByDay(context.db, { ...AUGUST, categoryId: FOOD }).map((r) => r.total)))
      .toBe(40_000);
    expect(sum(getPurchasesByDay(context.db, { ...AUGUST, paymentAccountId: MOMO }).map((r) => r.total)))
      .toBe(40_000);
  });

  it('says nothing for a period with no deliveries', () => {
    delivery('2026-08-02', KASAPREKO, COKE, 100, 300);
    const january = { from: '2026-01-01', to: '2026-01-31' };
    expect(getPurchasesByDay(context.db, january)).toEqual([]);
    expect(getPurchasesBySupplier(context.db, january)).toEqual([]);
    expect(getPurchasesByProduct(context.db, january)).toEqual([]);
  });
});

describe('the inventory report', () => {
  it('narrows the valuation by category, and its totals follow', () => {
    const all = getStockValuation(context.db);
    const drinksOnly = getStockValuation(context.db, { categoryId: DRINKS });

    expect(all.rows).toHaveLength(2);
    expect(drinksOnly.rows).toHaveLength(1);
    expect(drinksOnly.totalCostValue).toBe(150_000);
    expect(drinksOnly.totalCostValue).toBe(
      sum(drinksOnly.rows.map((row) => row.stockValue)),
    );
  });

  it('narrows by stock status', () => {
    // Sell every bag of rice, leaving it out of stock.
    createSale(
      context.db,
      {
        businessDate: '2026-08-05',
        items: [{ productId: RICE, qty: u(100) }],
        tenders: [{ paymentAccountId: CASH, amount: m(600_000) }],
      },
      ACTOR,
    );

    const out = getStockValuation(context.db, { stockStatus: 'out' });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.productName).toBe('Rice 5kg');
    expect(out.outOfStockCount).toBe(1);
  });

  it('narrows by the supplier who delivered the product', () => {
    createPurchase(
      context.db,
      {
        supplierId: KASAPREKO,
        businessDate: '2026-08-02',
        items: [{ productId: COKE, qty: u(10), unitCost: m(300) }],
        tenders: [{ paymentAccountId: CASH, amount: m(3_000) }],
      },
      ACTOR,
    );

    expect(getStockValuation(context.db, { supplierId: KASAPREKO }).rows).toHaveLength(1);
    expect(getStockValuation(context.db, { supplierId: MADINA }).rows).toEqual([]);
  });

  it('reports zero rather than NaN when a filter matches nothing', () => {
    const nothing = getStockValuation(context.db, { categoryId: 9_999 });
    expect(nothing.rows).toEqual([]);
    expect(nothing.totalCostValue).toBe(0);
    expect(nothing.totalRetailValue).toBe(0);
    expect(nothing.lowStockCount).toBe(0);
    expect(nothing.outOfStockCount).toBe(0);
  });
});

describe('the cash flow report', () => {
  it('opens each account from what it held before the window', () => {
    sale('2026-07-20', COKE, 10, 500); // cash, before August
    sale('2026-08-05', COKE, 4, 500); // cash, inside August

    const flow = getCashFlow(context.db, AUGUST);
    expect(flow.openingBalance).toBe(5_000);
    expect(flow.totalIn).toBe(2_000);
    expect(flow.closingBalance).toBe(7_000);
    expect(flow.reconciles).toBe(true);
  });

  it('narrows to one account, and still reconciles', () => {
    sale('2026-07-20', COKE, 10, 500, { account: CASH });
    sale('2026-08-05', COKE, 4, 500, { account: MOMO });

    const momoOnly = getCashFlow(context.db, AUGUST, MOMO);
    expect(momoOnly.openingBalance).toBe(0);
    expect(momoOnly.totalIn).toBe(2_000);
    expect(momoOnly.closingBalance).toBe(2_000);
    expect(momoOnly.reconciles).toBe(true);

    const cashOnly = getCashFlow(context.db, AUGUST, CASH);
    expect(cashOnly.openingBalance).toBe(5_000);
    expect(cashOnly.totalIn).toBe(0);
    expect(cashOnly.closingBalance).toBe(5_000);
  });

  it('reconciles over a period in which nothing moved', () => {
    sale('2026-07-20', COKE, 10, 500);
    const flow = getCashFlow(context.db, AUGUST);
    expect(flow.lines).toEqual([]);
    expect(flow.openingBalance).toBe(flow.closingBalance);
    expect(flow.reconciles).toBe(true);
  });
});
