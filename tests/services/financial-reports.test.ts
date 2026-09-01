import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts } from '@/db/schema';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale, voidSale } from '@/services/sale.service';
import { createCustomer } from '@/services/customer.service';
import { createSupplier } from '@/services/supplier.service';
import { createPurchase } from '@/services/purchase.service';
import { recordCustomerPayment } from '@/services/customer-payment.service';
import { recordSupplierPayment } from '@/services/supplier-payment.service';
import {
  recordExpense,
  recordIncome,
  recordOwnerCapital,
  recordOwnerDrawings,
} from '@/services/cashbook.service';
import { listExpenseCategories, listIncomeCategories } from '@/services/payment-account.service';
import { createCustomerReturn, getReturnableSaleItems } from '@/services/returns.service';
import {
  getBalanceSheet,
  getCashFlow,
  getProfitAndLoss,
} from '@/services/reporting/financial.service';
import {
  getSalesByCategory,
  getSalesByCustomer,
  getSalesByDay,
  getSalesByPaymentMethod,
  getSalesByProduct,
  getPurchasesBySupplier,
  getStockValuation,
  getStockMovementSummary,
} from '@/services/reporting/operations.service';
import { minor, sum, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
import { monthOf } from '../helpers/clock';
import { toBusinessDate } from '@/lib/format';

const TODAY = '2026-08-17';
const PERIOD = { from: '2026-08-01', to: '2026-08-31' };

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;
let MOMO = 0;

function expenseCategory(name: string): number {
  return listExpenseCategories(context.db).find((c) => c.name === name)!.id;
}
function incomeCategory(name: string): number {
  return listIncomeCategories(context.db).find((c) => c.name === name)!.id;
}

function makeStockedProduct(name: string, costEach: number, priceEach: number, qtyUnits = 100) {
  const id = createProduct(
    context.db,
    { name, costPrice: m(costEach), sellingPrice: m(priceEach), unit: 'pcs' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: '2026-08-01',
      reason: 'OPENING_STOCK',
      items: [{ productId: id, direction: 'IN', qty: u(qtyUnits), totalCost: m(costEach * qtyUnits) }],
    },
    ACTOR,
  );
  return id;
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  const rows = context.db.select().from(paymentAccounts).all();
  CASH = rows.find((a) => a.kind === 'CASH')!.id;
  MOMO = rows.find((a) => a.kind === 'MOBILE_MONEY')!.id;
});

afterEach(() => {
  context.cleanup();
});

describe('profit and loss', () => {
  it('computes gross and net profit from real transactions', () => {
    const id = makeStockedProduct('Milo', 500, 1_000, 100);

    // Sell 10 for 100.00, costing 50.00.
    createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10) }],
        tenders: [{ paymentAccountId: CASH, amount: m(10_000) }],
      },
      ACTOR,
    );

    recordExpense(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: expenseCategory('Rent'),
        description: 'Rent',
        amount: m(2_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );

    recordIncome(
      context.db,
      {
        businessDate: TODAY,
        categoryAccountId: incomeCategory('Commission'),
        description: 'Commission',
        amount: m(1_500),
        paymentAccountId: MOMO,
      },
      ACTOR,
    );

    const pl = getProfitAndLoss(context.db, PERIOD);

    expect(pl.salesRevenue).toBe(10_000);
    expect(pl.netSales).toBe(10_000);
    expect(pl.costOfGoodsSold).toBe(5_000);
    expect(pl.grossProfit).toBe(5_000);
    expect(pl.totalOtherIncome).toBe(1_500);
    expect(pl.totalExpenses).toBe(2_000);
    // 50.00 gross + 15.00 other income - 20.00 expenses = 45.00
    expect(pl.netProfit).toBe(4_500);
    expect(pl.grossMarginBp).toBe(5_000); // 50%
  });

  it('shows discounts and returns as reductions of revenue, not as expenses', () => {
    const id = makeStockedProduct('Milo', 500, 1_000, 100);

    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10) }],
        invoiceDiscount: m(1_000),
        tenders: [{ paymentAccountId: CASH, amount: m(9_000) }],
        // ACTOR is an owner, who may depart from the shop's prices.
        allowPriceOverride: true,
      },
      ACTOR,
    );

    const items = getReturnableSaleItems(context.db, sale.saleId);
    // 2 of 10 units. The customer paid 90.00 for the ten, so those two are
    // worth 18.00 — NOT the 20.00 the pre-discount line total implies.
    const result = createCustomerReturn(
      context.db,
      sale.saleId,
      {
        businessDate: TODAY,
        items: [{ itemId: items[0]!.id, qty: u(2) }],
        refunds: [{ paymentAccountId: CASH, amount: m(1_800) }],
      },
      ACTOR,
    );

    expect(result.refunded).toBe(1_800);
    expect(result.creditApplied).toBe(0);

    const pl = getProfitAndLoss(context.db, PERIOD);

    expect(pl.salesRevenue).toBe(10_000); // gross, before discount
    expect(pl.salesDiscounts).toBe(1_000);
    expect(pl.salesReturns).toBe(1_800);
    expect(pl.netSales).toBe(7_200);
    // Neither shows up as a running cost.
    expect(pl.expenses.some((line) => /discount|return/i.test(line.name))).toBe(false);
  });

  /**
   * Regression guard: a partial return must refund what the customer ACTUALLY
   * paid, which means honouring the line's share of any invoice-wide discount.
   * Refunding from the pre-discount line total over-refunds every time.
   */
  it('a partial return on a discounted sale refunds only what was paid', () => {
    const id = makeStockedProduct('Milo', 500, 1_000, 100);

    // 10 @ 10.00 = 100.00, less 10.00 discount = 90.00 paid.
    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10) }],
        invoiceDiscount: m(1_000),
        tenders: [{ paymentAccountId: CASH, amount: m(9_000) }],
        // ACTOR is an owner, who may depart from the shop's prices.
        allowPriceOverride: true,
      },
      ACTOR,
    );
    expect(sale.total).toBe(9_000);

    const items = getReturnableSaleItems(context.db, sale.saleId);

    // Refunding the full pre-discount value must now be refused.
    expect(() =>
      createCustomerReturn(
        context.db,
        sale.saleId,
        {
          businessDate: TODAY,
          items: [{ itemId: items[0]!.id, qty: u(2) }],
          refunds: [{ paymentAccountId: CASH, amount: m(2_000) }],
        },
        ACTOR,
      ),
    ).toThrow(/more than the value/i);

    // Returning everything gives back exactly what was paid — no more.
    const all = createCustomerReturn(
      context.db,
      sale.saleId,
      {
        businessDate: TODAY,
        items: [{ itemId: items[0]!.id, qty: u(10) }],
        refunds: [{ paymentAccountId: CASH, amount: m(9_000) }],
      },
      ACTOR,
    );
    expect(all.refunded).toBe(9_000);

    // Cash is back where it started, and no revenue remains.
    const pl = getProfitAndLoss(context.db, PERIOD);
    expect(pl.netSales).toBe(0);
    expect(pl.grossProfit).toBe(0);
    expect(getBalanceSheet(context.db, '2026-08-31').totalCash).toBe(0);
    expect(getBalanceSheet(context.db, '2026-08-31').balances).toBe(true);
  });

  it('ignores a voided sale', () => {
    const id = makeStockedProduct('Milo', 500, 1_000, 100);
    /*
      Dated today rather than TODAY, and read over the month that contains it.
      `voidSale` dates the reversing entry from the clock on purpose, so a sale
      pinned to a literal month stops meeting its own reversal the moment the
      month turns — which is how this passed all August and broke on 1
      September. The assertion is unchanged: the pair nets to nothing inside a
      period holding both.
    */
    const today = toBusinessDate();
    const period = monthOf(today);
    const sale = createSale(
      context.db,
      {
        businessDate: today,
        items: [{ productId: id, qty: u(10) }],
        tenders: [{ paymentAccountId: CASH, amount: m(10_000) }],
      },
      ACTOR,
    );

    expect(getProfitAndLoss(context.db, period).netSales).toBe(10_000);
    voidSale(context.db, sale.saleId, 'Entered twice', ACTOR);
    // The reversing entry cancels it out exactly.
    expect(getProfitAndLoss(context.db, period).netSales).toBe(0);
    expect(getProfitAndLoss(context.db, period).grossProfit).toBe(0);
  });

  it('excludes owner drawings from expenses', () => {
    recordOwnerCapital(
      context.db,
      { businessDate: TODAY, paymentAccountId: CASH, amount: m(100_000) },
      ACTOR,
    );
    recordOwnerDrawings(
      context.db,
      { businessDate: TODAY, paymentAccountId: CASH, amount: m(20_000) },
      ACTOR,
    );

    const pl = getProfitAndLoss(context.db, PERIOD);
    // Money the owner takes is not a business cost and must not reduce profit.
    expect(pl.totalExpenses).toBe(0);
    expect(pl.netProfit).toBe(0);
    // Nor is money the owner puts in income.
    expect(pl.totalRevenue).toBe(0);
  });

  it('respects the period boundaries', () => {
    const id = makeStockedProduct('Milo', 500, 1_000, 100);
    createSale(
      context.db,
      {
        businessDate: '2026-07-15',
        items: [{ productId: id, qty: u(5) }],
        tenders: [{ paymentAccountId: CASH, amount: m(5_000) }],
      },
      ACTOR,
    );
    createSale(
      context.db,
      {
        businessDate: '2026-08-15',
        items: [{ productId: id, qty: u(3) }],
        tenders: [{ paymentAccountId: CASH, amount: m(3_000) }],
      },
      ACTOR,
    );

    expect(getProfitAndLoss(context.db, PERIOD).netSales).toBe(3_000);
    expect(getProfitAndLoss(context.db, { from: '2026-07-01', to: '2026-07-31' }).netSales).toBe(
      5_000,
    );
  });

  it('returns null margins rather than a misleading zero when there is no revenue', () => {
    const pl = getProfitAndLoss(context.db, PERIOD);
    expect(pl.grossMarginBp).toBeNull();
    expect(pl.netMarginBp).toBeNull();
  });
});

describe('balance sheet', () => {
  it('balances after a full round of trading', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = createProduct(
      context.db,
      { name: 'Milo', costPrice: m(500), sellingPrice: m(1_000) },
      ACTOR,
    );

    recordOwnerCapital(
      context.db,
      { businessDate: '2026-08-01', paymentAccountId: CASH, amount: m(100_000) },
      ACTOR,
    );
    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: '2026-08-02',
        items: [{ productId: id, qty: u(100), unitCost: m(500) }],
        tenders: [{ paymentAccountId: CASH, amount: m(20_000) }],
      },
      ACTOR,
    );
    createSale(
      context.db,
      {
        businessDate: '2026-08-05',
        customerId,
        items: [{ productId: id, qty: u(30) }],
        tenders: [{ paymentAccountId: CASH, amount: m(10_000) }],
      },
      ACTOR,
    );
    recordCustomerPayment(
      context.db,
      { customerId, businessDate: '2026-08-06', paymentAccountId: MOMO, amount: m(5_000) },
      ACTOR,
    );
    recordSupplierPayment(
      context.db,
      { supplierId, businessDate: '2026-08-07', paymentAccountId: CASH, amount: m(15_000) },
      ACTOR,
    );
    recordExpense(
      context.db,
      {
        businessDate: '2026-08-08',
        categoryAccountId: expenseCategory('Rent'),
        description: 'Rent',
        amount: m(8_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );
    recordOwnerDrawings(
      context.db,
      { businessDate: '2026-08-09', paymentAccountId: CASH, amount: m(3_000) },
      ACTOR,
    );

    const sheet = getBalanceSheet(context.db, '2026-08-31');

    expect(sheet.balances, `difference ${sheet.difference}`).toBe(true);
    expect(sheet.difference).toBe(0);
    expect(sheet.totalAssets).toBe(sheet.totalLiabilitiesAndEquity);

    // Sanity on the components.
    expect(sheet.ownersCapital).toBe(100_000);
    expect(sheet.drawings).toBe(3_000);
    expect(sheet.inventory).toBeGreaterThan(0);
    expect(sheet.receivables).toBe(15_000); // 30.00 sale less 10 tender less 5 payment
    expect(sheet.payables).toBe(15_000); // 500 purchase less 200 less 150
  });

  it('stays balanced at every step of a longer sequence', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = createProduct(
      context.db,
      { name: 'Milo', costPrice: m(500), sellingPrice: m(1_000) },
      ACTOR,
    );

    const steps: (() => void)[] = [
      () =>
        recordOwnerCapital(
          context.db,
          { businessDate: '2026-08-01', paymentAccountId: CASH, amount: m(50_000) },
          ACTOR,
        ),
      () =>
        createPurchase(
          context.db,
          {
            supplierId,
            businessDate: '2026-08-02',
            items: [{ productId: id, qty: u(50), unitCost: m(500) }],
            tenders: [],
          },
          ACTOR,
        ),
      () =>
        createSale(
          context.db,
          {
            businessDate: '2026-08-03',
            customerId,
            items: [{ productId: id, qty: u(20) }],
            tenders: [],
          },
          ACTOR,
        ),
      () =>
        recordExpense(
          context.db,
          {
            businessDate: '2026-08-04',
            categoryAccountId: expenseCategory('Transport'),
            description: 'Taxi',
            amount: m(1_500),
            paymentAccountId: CASH,
          },
          ACTOR,
        ),
      () =>
        recordIncome(
          context.db,
          {
            businessDate: '2026-08-05',
            categoryAccountId: incomeCategory('Commission'),
            description: 'Commission',
            amount: m(2_000),
            paymentAccountId: MOMO,
          },
          ACTOR,
        ),
      () =>
        recordCustomerPayment(
          context.db,
          { customerId, businessDate: '2026-08-06', paymentAccountId: CASH, amount: m(12_000) },
          ACTOR,
        ),
      () =>
        recordSupplierPayment(
          context.db,
          { supplierId, businessDate: '2026-08-07', paymentAccountId: CASH, amount: m(10_000) },
          ACTOR,
        ),
      () =>
        createStockAdjustment(
          context.db,
          {
            businessDate: '2026-08-08',
            reason: 'DAMAGED',
            items: [{ productId: id, direction: 'OUT', qty: u(2) }],
          },
          ACTOR,
        ),
      () =>
        recordOwnerDrawings(
          context.db,
          { businessDate: '2026-08-09', paymentAccountId: CASH, amount: m(4_000) },
          ACTOR,
        ),
    ];

    steps.forEach((step, index) => {
      step();
      const sheet = getBalanceSheet(context.db, '2026-08-31');
      expect(sheet.balances, `after step ${index + 1}: difference ${sheet.difference}`).toBe(true);
    });
  });

  it('reflects the position as at a date, not today', () => {
    const id = makeStockedProduct('Milo', 500, 1_000, 100);
    createSale(
      context.db,
      {
        businessDate: '2026-08-20',
        items: [{ productId: id, qty: u(10) }],
        tenders: [{ paymentAccountId: CASH, amount: m(10_000) }],
      },
      ACTOR,
    );

    // Before the sale: no cash from it yet.
    const before = getBalanceSheet(context.db, '2026-08-19');
    const after = getBalanceSheet(context.db, '2026-08-31');

    expect(before.totalCash).toBe(0);
    expect(after.totalCash).toBe(10_000);
    expect(before.balances).toBe(true);
    expect(after.balances).toBe(true);
  });
});

describe('cash flow', () => {
  it('separates where money came from and went', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const id = makeStockedProduct('Milo', 500, 1_000, 100);

    recordOwnerCapital(
      context.db,
      { businessDate: '2026-08-01', paymentAccountId: CASH, amount: m(50_000) },
      ACTOR,
    );
    createSale(
      context.db,
      {
        businessDate: '2026-08-05',
        items: [{ productId: id, qty: u(10) }],
        tenders: [{ paymentAccountId: CASH, amount: m(10_000) }],
      },
      ACTOR,
    );
    createSale(
      context.db,
      {
        businessDate: '2026-08-06',
        customerId,
        items: [{ productId: id, qty: u(5) }],
        tenders: [],
      },
      ACTOR,
    );
    recordCustomerPayment(
      context.db,
      { customerId, businessDate: '2026-08-07', paymentAccountId: CASH, amount: m(2_000) },
      ACTOR,
    );
    recordExpense(
      context.db,
      {
        businessDate: '2026-08-08',
        categoryAccountId: expenseCategory('Rent'),
        description: 'Rent',
        amount: m(8_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );

    const flow = getCashFlow(context.db, PERIOD);

    const byType = new Map(flow.lines.map((line) => [line.sourceType, line]));
    expect(byType.get('CAPITAL')?.inMinor).toBe(50_000);
    expect(byType.get('SALE')?.inMinor).toBe(10_000);
    expect(byType.get('CUSTOMER_PAYMENT')?.inMinor).toBe(2_000);
    expect(byType.get('EXPENSE')?.outMinor).toBe(8_000);

    // The credit sale contributed NO cash — only the later payment did.
    expect(byType.get('SALE')?.inMinor).toBe(10_000);

    expect(flow.totalIn).toBe(62_000);
    expect(flow.totalOut).toBe(8_000);
    expect(flow.netMovement).toBe(54_000);
    expect(flow.closingBalance).toBe(54_000);
    expect(flow.reconciles).toBe(true);
  });

  it('carries an opening balance from before the period', () => {
    recordOwnerCapital(
      context.db,
      { businessDate: '2026-07-01', paymentAccountId: CASH, amount: m(30_000) },
      ACTOR,
    );
    recordExpense(
      context.db,
      {
        businessDate: '2026-08-05',
        categoryAccountId: expenseCategory('Rent'),
        description: 'Rent',
        amount: m(5_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );

    const flow = getCashFlow(context.db, PERIOD);
    expect(flow.openingBalance).toBe(30_000);
    expect(flow.totalOut).toBe(5_000);
    expect(flow.closingBalance).toBe(25_000);
  });

  it('agrees with the balance sheet cash figure', () => {
    const id = makeStockedProduct('Milo', 500, 1_000, 100);
    recordOwnerCapital(
      context.db,
      { businessDate: '2026-08-01', paymentAccountId: CASH, amount: m(50_000) },
      ACTOR,
    );
    createSale(
      context.db,
      {
        businessDate: '2026-08-05',
        items: [{ productId: id, qty: u(10) }],
        tenders: [{ paymentAccountId: MOMO, amount: m(10_000) }],
      },
      ACTOR,
    );

    const flow = getCashFlow(context.db, PERIOD);
    const sheet = getBalanceSheet(context.db, '2026-08-31');
    // Cash flow's closing position must equal the balance sheet's cash total.
    expect(flow.closingBalance).toBe(sheet.totalCash);
  });

  it('can be filtered to one account', () => {
    recordOwnerCapital(
      context.db,
      { businessDate: '2026-08-01', paymentAccountId: CASH, amount: m(50_000) },
      ACTOR,
    );
    recordOwnerCapital(
      context.db,
      { businessDate: '2026-08-01', paymentAccountId: MOMO, amount: m(20_000) },
      ACTOR,
    );

    expect(getCashFlow(context.db, PERIOD, CASH).totalIn).toBe(50_000);
    expect(getCashFlow(context.db, PERIOD, MOMO).totalIn).toBe(20_000);
    expect(getCashFlow(context.db, PERIOD).totalIn).toBe(70_000);
  });
});

describe('operational reports', () => {
  function tradingSetUp() {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const milo = makeStockedProduct('Milo', 500, 1_000, 100);
    const bread = makeStockedProduct('Bread', 800, 1_200, 50);

    createSale(
      context.db,
      {
        businessDate: '2026-08-05',
        items: [
          { productId: milo, qty: u(10) },
          { productId: bread, qty: u(5) },
        ],
        tenders: [{ paymentAccountId: CASH, amount: m(16_000) }],
      },
      ACTOR,
    );
    createSale(
      context.db,
      {
        businessDate: '2026-08-06',
        customerId,
        items: [{ productId: milo, qty: u(4) }],
        tenders: [{ paymentAccountId: MOMO, amount: m(2_000) }],
      },
      ACTOR,
    );

    return { customerId, milo, bread };
  }

  it('breaks sales down by day, product, category, customer and method', () => {
    tradingSetUp();

    const byDay = getSalesByDay(context.db, PERIOD);
    expect(byDay).toHaveLength(2);
    expect(byDay[0]?.total).toBe(16_000);
    expect(byDay[1]?.total).toBe(4_000);

    const byProduct = getSalesByProduct(context.db, PERIOD);
    const milo = byProduct.find((row) => row.productName === 'Milo');
    expect(milo?.qtySold).toBe(14_000); // 14 units
    expect(milo?.revenue).toBe(14_000); // 14 x 10.00
    expect(milo?.cost).toBe(7_000);
    expect(milo?.profit).toBe(7_000);
    expect(milo?.marginBp).toBe(5_000);

    const byCustomer = getSalesByCustomer(context.db, PERIOD);
    expect(byCustomer.find((row) => row.customerName === 'Walk-in customers')?.total).toBe(16_000);
    expect(byCustomer.find((row) => row.customerName === 'Ama')?.total).toBe(4_000);

    const byMethod = getSalesByPaymentMethod(context.db, PERIOD);
    expect(byMethod.find((row) => row.kind === 'CASH')?.received).toBe(16_000);
    // Only what was actually tendered on the credit sale.
    expect(byMethod.find((row) => row.kind === 'MOBILE_MONEY')?.received).toBe(2_000);

    // Uncategorised products still appear, under a clear label.
    const byCategory = getSalesByCategory(context.db, PERIOD);
    expect(byCategory[0]?.categoryName).toBe('Uncategorised');
  });

  it('sales report totals tie to the profit and loss', () => {
    tradingSetUp();

    const byDay = getSalesByDay(context.db, PERIOD);
    const pl = getProfitAndLoss(context.db, PERIOD);

    expect(sum(byDay.map((row) => row.total))).toBe(pl.netSales);
    expect(sum(byDay.map((row) => row.cogs))).toBe(pl.costOfGoodsSold);
    expect(sum(byDay.map((row) => row.profit))).toBe(pl.grossProfit);
  });

  it('values stock at cost and shows what it would fetch', () => {
    makeStockedProduct('Milo', 500, 1_000, 20);

    const valuation = getStockValuation(context.db);
    const milo = valuation.rows.find((row) => row.productName === 'Milo');

    expect(milo?.qtyOnHand).toBe(20_000);
    expect(milo?.stockValue).toBe(10_000); // 20 x 5.00 at cost
    expect(milo?.retailValue).toBe(20_000); // 20 x 10.00 at selling price
    expect(milo?.potentialProfit).toBe(10_000);
    expect(valuation.totalCostValue).toBe(10_000);
  });

  it('summarises stock movement for a period', () => {
    const id = makeStockedProduct('Milo', 500, 1_000, 100);
    createSale(
      context.db,
      {
        businessDate: '2026-08-05',
        items: [{ productId: id, qty: u(10) }],
        tenders: [{ paymentAccountId: CASH, amount: m(10_000) }],
      },
      ACTOR,
    );

    const movement = getStockMovementSummary(context.db, PERIOD);
    const milo = movement.find((row) => row.productName === 'Milo');

    expect(milo?.qtyIn).toBe(100_000); // opening stock
    expect(milo?.qtyOut).toBe(10_000); // the sale
    expect(milo?.netQty).toBe(90_000);
    expect(milo?.closingQty).toBe(90_000);
  });

  it('breaks purchases down by supplier', () => {
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
        businessDate: '2026-08-03',
        items: [{ productId: id, qty: u(20), unitCost: m(500) }],
        tenders: [],
      },
      ACTOR,
    );

    const bySupplier = getPurchasesBySupplier(context.db, PERIOD);
    expect(bySupplier).toHaveLength(1);
    expect(bySupplier[0]?.supplierName).toBe('Depot');
    expect(bySupplier[0]?.total).toBe(10_000);
  });
});
