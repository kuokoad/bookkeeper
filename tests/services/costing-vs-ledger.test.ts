import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts, products } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment, voidStockAdjustment } from '@/services/stock-adjustment.service';
import { createPurchase, voidPurchase } from '@/services/purchase.service';
import { createSale } from '@/services/sale.service';
import { createSupplier } from '@/services/supplier.service';
import { getInventoryValue, verifyProductStock } from '@/services/inventory.service';
import { getAccountBalanceByCode, getTrialBalance } from '@/services/reporting/balances.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * The stock ledger and the general ledger must agree, always.
 *
 * Inventory is counted twice over: once in goods, by the weighted-average
 * engine, and once in money, in the Inventory account. They are meant to be two
 * views of one fact. When they disagree the shop has no way to tell which is
 * right — the shelf says one thing, the accounts say another, and the profit
 * figure quietly depends on which one you asked.
 *
 * The dangerous case is undoing something AFTER the average has moved on. Value
 * left inventory at one price and the correction puts it back at another, and
 * the gap has to land somewhere visible rather than nowhere at all.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const DAY = '2026-08-10';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH_ACCOUNT = 0;
let SUPPLIER = 0;

/** The two counts of inventory must be the same number. */
function expectStockAndLedgerAgree(label: string): void {
  expect(getInventoryValue(context.db), `${label}: stock value vs Inventory account`).toBe(
    getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY),
  );
  expect(getTrialBalance(context.db).balanced, `${label}: trial balance`).toBe(true);

  for (const row of context.db.select({ id: products.id }).from(products).all()) {
    expect(verifyProductStock(context.db, row.id).ok, `${label}: stock drift p${row.id}`).toBe(true);
  }
}

function makeProduct(): number {
  return createProduct(
    context.db,
    { name: 'Rice 5kg', costPrice: m(1_000), sellingPrice: m(3_000), unit: 'bag' },
    ACTOR,
  );
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  CASH_ACCOUNT = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;
  SUPPLIER = createSupplier(context.db, { name: 'Kofi Wholesale' }, ACTOR);
});

afterEach(() => context.cleanup());

describe('voiding a purchase after the average has moved', () => {
  it('leaves the stock ledger and the accounts agreeing', () => {
    const product = makeProduct();

    // Ten bags at GHS 10.00, then ten more at GHS 20.00 — the average is now
    // GHS 15.00, and neither delivery was bought at that price.
    const first = createPurchase(
      context.db,
      {
        businessDate: DAY,
        supplierId: SUPPLIER,
        items: [{ productId: product, qty: u(10), unitCost: m(1_000) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(10_000) }],
      },
      ACTOR,
    );

    createPurchase(
      context.db,
      {
        businessDate: DAY,
        supplierId: SUPPLIER,
        items: [{ productId: product, qty: u(10), unitCost: m(2_000) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(20_000) }],
      },
      ACTOR,
    );

    expectStockAndLedgerAgree('after both deliveries');

    // Void the FIRST delivery. Its goods went in at GHS 10.00 each; the running
    // average is GHS 15.00. Whichever price they leave at, the two counts of
    // inventory have to end up saying the same thing.
    voidPurchase(context.db, first.purchaseId, 'Supplier invoiced us twice', ACTOR);

    expectStockAndLedgerAgree('after voiding the first delivery');
  });

  it('still agrees when some of the stock has already been sold', () => {
    const product = makeProduct();

    const first = createPurchase(
      context.db,
      {
        businessDate: DAY,
        supplierId: SUPPLIER,
        items: [{ productId: product, qty: u(10), unitCost: m(1_000) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(10_000) }],
      },
      ACTOR,
    );

    createPurchase(
      context.db,
      {
        businessDate: DAY,
        supplierId: SUPPLIER,
        items: [{ productId: product, qty: u(10), unitCost: m(2_000) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(20_000) }],
      },
      ACTOR,
    );

    createSale(
      context.db,
      {
        businessDate: DAY,
        items: [{ productId: product, qty: u(5) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(15_000) }],
      },
      ACTOR,
    );

    expectStockAndLedgerAgree('after selling five');

    voidPurchase(context.db, first.purchaseId, 'Supplier invoiced us twice', ACTOR);

    expectStockAndLedgerAgree('after voiding a delivery that is partly sold');
  });
});

describe('voiding a stock adjustment after the average has moved', () => {
  it('leaves the stock ledger and the accounts agreeing', () => {
    const product = makeProduct();

    // Opening stock at GHS 10.00 a bag.
    const opening = createStockAdjustment(
      context.db,
      {
        businessDate: DAY,
        reason: 'OPENING_STOCK',
        items: [{ productId: product, direction: 'IN', qty: u(10), totalCost: m(10_000) }],
      },
      ACTOR,
    );

    // A delivery at GHS 20.00 shifts the average to GHS 15.00.
    createPurchase(
      context.db,
      {
        businessDate: DAY,
        supplierId: SUPPLIER,
        items: [{ productId: product, qty: u(10), unitCost: m(2_000) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(20_000) }],
      },
      ACTOR,
    );

    expectStockAndLedgerAgree('after the delivery');

    voidStockAdjustment(context.db, opening.adjustmentId, 'Counted the wrong shelf', ACTOR);

    expectStockAndLedgerAgree('after voiding the opening stock');
  });
});

describe('a void that empties the shelf', () => {
  /**
   * The hardest case, and the one that used to lose money quietly.
   *
   * Take the last of a product back out at what it originally cost, when the
   * average has since moved on, and the running value does not land on zero by
   * itself. An empty shelf cannot be worth anything, so the difference has to
   * leave inventory — and it has to leave the accounts at the same time, or the
   * stock ledger drops to nothing while the Inventory account carries on
   * holding money for goods that are gone.
   */
  it('keeps both counts of inventory at zero, and says where the difference went', () => {
    const product = makeProduct();

    // Ten at GHS 10.00, ten at GHS 20.00 — average GHS 15.00, value GHS 300.00.
    const first = createPurchase(
      context.db,
      {
        businessDate: DAY,
        supplierId: SUPPLIER,
        items: [{ productId: product, qty: u(10), unitCost: m(1_000) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(10_000) }],
      },
      ACTOR,
    );
    createPurchase(
      context.db,
      {
        businessDate: DAY,
        supplierId: SUPPLIER,
        items: [{ productId: product, qty: u(10), unitCost: m(2_000) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(20_000) }],
      },
      ACTOR,
    );

    // Sell ten at the average: GHS 150.00 of cost leaves, GHS 150.00 remains
    // against ten bags.
    createSale(
      context.db,
      {
        businessDate: DAY,
        items: [{ productId: product, qty: u(10) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(30_000) }],
      },
      ACTOR,
    );

    // Now void the first delivery: ten bags out at the GHS 100.00 they went in
    // at, leaving nothing on the shelf but GHS 50.00 of value behind it.
    voidPurchase(context.db, first.purchaseId, 'Supplier invoiced us twice', ACTOR);

    expect(getInventoryValue(context.db)).toBe(0);
    expectStockAndLedgerAgree('after voiding down to an empty shelf');
  });

  it('records the difference as a cost, not as thin air', () => {
    const product = makeProduct();

    const opening = createStockAdjustment(
      context.db,
      {
        businessDate: DAY,
        reason: 'OPENING_STOCK',
        items: [{ productId: product, direction: 'IN', qty: u(10), totalCost: m(10_000) }],
      },
      ACTOR,
    );
    createPurchase(
      context.db,
      {
        businessDate: DAY,
        supplierId: SUPPLIER,
        items: [{ productId: product, qty: u(10), unitCost: m(2_000) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(20_000) }],
      },
      ACTOR,
    );
    createSale(
      context.db,
      {
        businessDate: DAY,
        items: [{ productId: product, qty: u(10) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(30_000) }],
      },
      ACTOR,
    );

    const cogsBefore = getAccountBalanceByCode(context.db, ACCOUNT_CODES.COST_OF_GOODS_SOLD);

    voidStockAdjustment(context.db, opening.adjustmentId, 'Counted the wrong shelf', ACTOR);

    // The GHS 50.00 stranded by the averaging is a cost of doing business, and
    // it appears as one rather than vanishing.
    const cogsAfter = getAccountBalanceByCode(context.db, ACCOUNT_CODES.COST_OF_GOODS_SOLD);
    expect(cogsAfter - cogsBefore).toBe(5_000);

    expect(getInventoryValue(context.db)).toBe(0);
    expectStockAndLedgerAgree('after voiding opening stock down to empty');
  });
});
