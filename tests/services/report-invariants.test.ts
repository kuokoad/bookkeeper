import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, accountIdFor, type TestDatabase } from '../helpers/test-db';
import { businessSettings, paymentAccounts, products, saleItems } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createPurchase } from '@/services/purchase.service';
import { createSale, voidSale } from '@/services/sale.service';
import { createCustomer } from '@/services/customer.service';
import { createSupplier } from '@/services/supplier.service';
import { recordCustomerPayment } from '@/services/customer-payment.service';
import { recordSupplierPayment } from '@/services/supplier-payment.service';
import { createCustomerReturn } from '@/services/returns.service';
import {
  recordExpense,
  recordIncome,
  recordOwnerCapital,
  recordOwnerDrawings,
} from '@/services/cashbook.service';
import { getInventoryValue, verifyProductStock } from '@/services/inventory.service';
import {
  getAccountBalanceByCode,
  getPaymentAccountBalances,
  getTrialBalance,
} from '@/services/reporting/balances.service';
import { getBalanceSheet, getCashFlow, getProfitAndLoss } from '@/services/reporting/financial.service';
import { getSalesByDay } from '@/services/reporting/operations.service';
import { checkBooksIntegrity } from '@/services/reporting/ledger.service';
import { minor, sum as sumMinor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * The reports must agree with each other, and with the ledger they all read.
 *
 * Each screen answers a different question, but they are drawn from one set of
 * journal lines, so a disagreement between any two of them means at least one
 * is lying — and the owner has no way to tell which. These are the identities
 * that must hold no matter what the shop got up to.
 *
 * Deliberately exercised through a messy day rather than a clean one: a
 * customer who overpays, goods that come back, a supplier settled in part, an
 * owner taking money out, and a sale rung up wrong and voided. Clean cases
 * pass almost by accident.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const DAY = '2026-08-10';
const LATER = '2026-08-17';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;
let MOMO = 0;
let CUSTOMER = 0;
let SUPPLIER = 0;

/** Everything that must be true, whatever the shop did. */
function expectReportsAgree(label: string): void {
  const trial = getTrialBalance(context.db);
  expect(trial.balanced, `${label}: trial balance`).toBe(true);

  const sheet = getBalanceSheet(context.db, LATER);
  expect(sheet.balances, `${label}: balance sheet balances`).toBe(true);
  expect(sheet.difference, `${label}: balance sheet difference`).toBe(0);

  // The goods on the shelf and the money in the Inventory account are two
  // views of one fact.
  expect(getInventoryValue(context.db), `${label}: stock vs Inventory account`).toBe(
    getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY),
  );

  // Subledgers against their control accounts.
  const integrity = checkBooksIntegrity(context.db);
  expect(integrity.receivablesMatch, `${label}: A/R subledger vs control`).toBe(true);
  expect(integrity.payablesMatch, `${label}: A/P subledger vs control`).toBe(true);
  expect(integrity.untracedEntries, `${label}: untraced entries`).toBe(0);

  // Every product's cached pair must survive a replay of its own movements.
  for (const row of context.db.select({ id: products.id }).from(products).all()) {
    expect(verifyProductStock(context.db, row.id).ok, `${label}: stock drift p${row.id}`).toBe(true);
  }

  /**
   * The cash flow's closing figure is the money actually in the accounts.
   *
   * Compared over ALL time, not up to `LATER`: the payment-account balances are
   * unbounded, and a void dates its reversal on the day the correction is made,
   * which can fall after any window the test picks. Bounding one side and not
   * the other compares two different questions.
   */
  const period = { from: '0000-01-01', to: '9999-12-31' };
  const flow = getCashFlow(context.db, period);
  const heldPerAccount = sumMinor(getPaymentAccountBalances(context.db).map((a) => a.balance));
  expect(flow.closingBalance, `${label}: cash flow vs payment accounts`).toBe(heldPerAccount);

  // Sales on the operations report tie to revenue on the Profit & Loss.
  const byDay = getSalesByDay(context.db, period).reduce((running, day) => running + day.total, 0);
  expect(byDay, `${label}: sales by day vs P&L net sales`).toBe(
    getProfitAndLoss(context.db, period).netSales,
  );
}

const firstItemOf = (saleId: number): number =>
  context.db.select().from(saleItems).where(eq(saleItems.saleId, saleId)).all()[0]!.id;

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');

  const accounts = context.db.select().from(paymentAccounts).all();
  CASH = accounts.find((a) => a.kind === 'CASH')!.id;
  MOMO = accounts.find((a) => a.kind === 'MOBILE_MONEY')!.id;
  CUSTOMER = createCustomer(context.db, { name: 'Mensah Provisions' }, ACTOR);
  SUPPLIER = createSupplier(context.db, { name: 'Kofi Wholesale' }, ACTOR);
});

afterEach(() => context.cleanup());

describe('a messy but ordinary week', () => {
  it('leaves every report agreeing with every other', () => {
    const rice = createProduct(
      context.db,
      { name: 'Rice 5kg', costPrice: m(6_000), sellingPrice: m(10_000), unit: 'bag' },
      ACTOR,
    );
    const oil = createProduct(
      context.db,
      { name: 'Oil 1L', costPrice: m(2_000), sellingPrice: m(3_500), unit: 'bottle' },
      ACTOR,
    );

    createStockAdjustment(
      context.db,
      {
        businessDate: DAY,
        reason: 'OPENING_STOCK',
        items: [
          { productId: rice, direction: 'IN', qty: u(20), totalCost: m(120_000) },
          { productId: oil, direction: 'IN', qty: u(30), totalCost: m(60_000) },
        ],
      },
      ACTOR,
    );
    expectReportsAgree('after opening stock');

    // The owner puts money in.
    recordOwnerCapital(context.db, { businessDate: DAY, paymentAccountId: CASH, amount: m(50_000) }, ACTOR);

    // A delivery, part paid.
    createPurchase(
      context.db,
      {
        businessDate: DAY,
        supplierId: SUPPLIER,
        items: [{ productId: rice, qty: u(10), unitCost: m(6_500) }],
        tenders: [{ paymentAccountId: CASH, amount: m(30_000) }],
      },
      ACTOR,
    );
    expectReportsAgree('after a part-paid delivery');

    // A cash sale and a credit sale.
    createSale(
      context.db,
      {
        businessDate: DAY,
        items: [{ productId: oil, qty: u(4) }],
        tenders: [{ paymentAccountId: MOMO, amount: m(14_000) }],
      },
      ACTOR,
    );

    const credit = createSale(
      context.db,
      {
        businessDate: DAY,
        customerId: CUSTOMER,
        items: [{ productId: rice, qty: u(5) }],
        tenders: [],
      },
      ACTOR,
    );
    expectReportsAgree('after two sales');

    // The customer pays MORE than they owe, so they end up in credit. The shop
    // has to have allowed advance payments; without it the service refuses,
    // which is the guard working rather than a problem to route around.
    context.db
      .update(businessSettings)
      .set({ allowOverpayment: true })
      .where(eq(businessSettings.id, 1))
      .run();

    recordCustomerPayment(
      context.db,
      {
        businessDate: LATER,
        customerId: CUSTOMER,
        paymentAccountId: CASH,
        amount: m(60_000),
      },
      ACTOR,
    );
    expectReportsAgree('after an overpayment');

    // Some of it comes back.
    createCustomerReturn(
      context.db,
      credit.saleId,
      { businessDate: LATER, items: [{ itemId: firstItemOf(credit.saleId), qty: u(2) }], refunds: [] },
      ACTOR,
    );
    expectReportsAgree('after a return');

    // The supplier is settled in part.
    recordSupplierPayment(
      context.db,
      { supplierId: SUPPLIER, businessDate: LATER, paymentAccountId: CASH, amount: m(20_000) },
      ACTOR,
    );

    // Running costs and a bit of other income.
    recordExpense(
      context.db,
      {
        businessDate: LATER,
        categoryAccountId: accountIdFor(context.db, '6010'),
        description: 'Shop rent',
        amount: m(15_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );
    recordIncome(
      context.db,
      {
        businessDate: LATER,
        // 4290 Miscellaneous Income — a postable leaf, not the heading above it.
        categoryAccountId: accountIdFor(context.db, '4290'),
        description: 'Sold empty sacks',
        amount: m(3_000),
        paymentAccountId: CASH,
      },
      ACTOR,
    );
    expectReportsAgree('after costs and other income');

    // The owner takes some out.
    recordOwnerDrawings(
      context.db,
      { businessDate: LATER, paymentAccountId: CASH, amount: m(10_000) },
      ACTOR,
    );

    // And a sale rung up wrong is voided.
    const mistake = createSale(
      context.db,
      {
        businessDate: LATER,
        items: [{ productId: oil, qty: u(3) }],
        tenders: [{ paymentAccountId: CASH, amount: m(10_500) }],
      },
      ACTOR,
    );
    voidSale(context.db, mistake.saleId, 'Rang up against the wrong customer', ACTOR);

    expectReportsAgree('after the whole week');
  });

  it('holds when stock is allowed to go negative', () => {
    context.db
      .update(businessSettings)
      .set({ allowNegativeStock: true })
      .where(eq(businessSettings.id, 1))
      .run();

    const rice = createProduct(
      context.db,
      { name: 'Rice 5kg', costPrice: m(6_000), sellingPrice: m(10_000), unit: 'bag' },
      ACTOR,
    );

    createStockAdjustment(
      context.db,
      {
        businessDate: DAY,
        reason: 'OPENING_STOCK',
        items: [{ productId: rice, direction: 'IN', qty: u(2), totalCost: m(12_000) }],
      },
      ACTOR,
    );

    // Sell more than is on the shelf — the shop knows more is coming.
    createSale(
      context.db,
      {
        businessDate: DAY,
        items: [{ productId: rice, qty: u(5) }],
        tenders: [{ paymentAccountId: CASH, amount: m(50_000) }],
      },
      ACTOR,
    );
    expectReportsAgree('while oversold');

    // The delivery arrives and puts it right.
    createPurchase(
      context.db,
      {
        businessDate: LATER,
        supplierId: SUPPLIER,
        items: [{ productId: rice, qty: u(10), unitCost: m(6_500) }],
        tenders: [{ paymentAccountId: CASH, amount: m(65_000) }],
      },
      ACTOR,
    );
    expectReportsAgree('after the delivery caught up');
  });
});
