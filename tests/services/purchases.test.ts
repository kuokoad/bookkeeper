import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import {
  paymentAccounts,
  products,
  purchaseItems,
  purchases,
  productBatches,
  saleItems,
  sales,
  stockLedger,
} from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createProduct, getProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale } from '@/services/sale.service';
import { createCustomer, getCustomerBalance, getTotalReceivables } from '@/services/customer.service';
import {
  createSupplier,
  getSupplierBalance,
  getTotalPayables,
  setSupplierActive,
} from '@/services/supplier.service';
import {
  createPurchase,
  getOpenPurchases,
  getPurchase,
  getPurchaseOutstanding,
  listPurchases,
  voidPurchase,
} from '@/services/purchase.service';
import {
  recordSupplierPayment,
  voidSupplierPayment,
} from '@/services/supplier-payment.service';
import {
  createCustomerReturn,
  createSupplierReturn,
  getReturnablePurchaseItems,
  getReturnableSaleItems,
} from '@/services/returns.service';
import {
  verifyBatchCoverage,
  verifyProductBatches,
  verifyProductStock,
  getInventoryValue,
} from '@/services/inventory.service';
import { getAccountBalanceByCode, getTrialBalance } from '@/services/reporting/balances.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import { ConflictError, InsufficientStockError, ValidationError } from '@/domain/errors';

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-17';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;
let MOMO = 0;
let BANK = 0;

function makeProduct(name: string, cost = 500, price = 800): number {
  return createProduct(
    context.db,
    { name, costPrice: m(cost), sellingPrice: m(price), unit: 'pcs' },
    ACTOR,
  );
}

/**
 * The invariants that must hold after EVERY financial operation, now including
 * the payables subledger.
 */
function assertBooksHealthy(label: string) {
  expect(getTrialBalance(context.db).balanced, `${label}: trial balance`).toBe(true);

  expect(getInventoryValue(context.db), `${label}: inventory vs GL`).toBe(
    getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY),
  );

  expect(getTotalReceivables(context.db), `${label}: A/R subledger vs control`).toBe(
    getAccountBalanceByCode(context.db, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE),
  );

  expect(getTotalPayables(context.db), `${label}: A/P subledger vs control`).toBe(
    getAccountBalanceByCode(context.db, ACCOUNT_CODES.ACCOUNTS_PAYABLE),
  );

  for (const row of context.db.select({ id: products.id }).from(products).all()) {
    expect(verifyProductStock(context.db, row.id).ok, `${label}: stock drift p${row.id}`).toBe(true);
  }
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');

  const accounts = context.db.select().from(paymentAccounts).all();
  CASH = accounts.find((a) => a.kind === 'CASH')!.id;
  MOMO = accounts.find((a) => a.kind === 'MOBILE_MONEY')!.id;
  BANK = accounts.find((a) => a.kind === 'BANK')!.id;
});

afterEach(() => {
  context.cleanup();
});

describe('purchases', () => {
  it('handles the brief’s worked example: buy 1000, pay 400, owe 600', () => {
    const supplierId = createSupplier(context.db, { name: 'Kasapreko Depot' }, ACTOR);
    const id = makeProduct('Milo 400g');

    const purchase = createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        invoiceNo: 'INV-9912',
        items: [{ productId: id, qty: u(100), unitCost: m(1_000) }], // 100 x 10.00 = 1000.00
        tenders: [{ paymentAccountId: BANK, amount: m(40_000) }], // paid 400.00
      },
      ACTOR,
    );

    expect(purchase.total).toBe(100_000);
    expect(purchase.paid).toBe(40_000);
    expect(purchase.outstanding).toBe(60_000);

    // Stock arrived at the price actually paid.
    const product = getProduct(context.db, id);
    expect(product.qtyOnHand).toBe(100_000);
    expect(product.stockValue).toBe(100_000);
    expect(product.averageCost).toBe(1_000);

    // The accounting.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY)).toBe(100_000);
    expect(getAccountBalanceByCode(context.db, '1021')).toBe(-40_000); // bank went down
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.ACCOUNTS_PAYABLE)).toBe(60_000);
    expect(getSupplierBalance(context.db, supplierId)).toBe(60_000);
    assertBooksHealthy('credit purchase');

    // Later, the 600 is paid.
    recordSupplierPayment(
      context.db,
      { supplierId, businessDate: TODAY, paymentAccountId: CASH, amount: m(60_000) },
      ACTOR,
    );

    expect(getSupplierBalance(context.db, supplierId)).toBe(0);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.ACCOUNTS_PAYABLE)).toBe(0);
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(-60_000);
    expect(getPurchaseOutstanding(context.db, purchase.purchaseId)).toBe(0);
    assertBooksHealthy('after supplier payment');
  });

  it('re-averages stock cost across deliveries at different prices', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = makeProduct('Milo 400g');

    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10), unitCost: m(500) }],
        tenders: [{ paymentAccountId: CASH, amount: m(5_000) }],
      },
      ACTOR,
    );
    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10), unitCost: m(700) }],
        tenders: [{ paymentAccountId: CASH, amount: m(7_000) }],
      },
      ACTOR,
    );

    const product = getProduct(context.db, id);
    expect(product.qtyOnHand).toBe(20_000);
    expect(product.stockValue).toBe(12_000);
    expect(product.averageCost).toBe(600);
    assertBooksHealthy('re-average');
  });

  it('spreads an invoice discount so inventory equals what was actually paid', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const a = makeProduct('Bread');
    const b = makeProduct('Biscuits');

    const purchase = createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [
          { productId: a, qty: u(10), unitCost: m(750) }, // 75.00
          { productId: b, qty: u(10), unitCost: m(250) }, // 25.00
        ],
        invoiceDiscount: m(1_000), // 10.00 off
        tenders: [{ paymentAccountId: CASH, amount: m(9_000) }],
      },
      ACTOR,
    );

    expect(purchase.total).toBe(9_000);
    // Inventory equals what was paid, not the pre-discount list price.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY)).toBe(9_000);
    expect(getProduct(context.db, a).stockValue).toBe(6_750); // 75 less 7.50 share
    expect(getProduct(context.db, b).stockValue).toBe(2_250); // 25 less 2.50 share
    assertBooksHealthy('purchase discount');
  });

  /**
   * Regression guard: rounding each line's share of the discount independently
   * loses a pesewa, which used to leak out as a phantom Miscellaneous expense.
   * The whole discount must land on inventory, every time.
   */
  it('an awkward discount still puts every pesewa into inventory', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const a = makeProduct('A');
    const b = makeProduct('B');
    const c = makeProduct('C');

    for (const discount of [1, 7, 33, 99, 101, 1_234]) {
      const purchase = createPurchase(
        context.db,
        {
          supplierId,
          businessDate: TODAY,
          items: [
            { productId: a, qty: u(3), unitCost: m(1_111) },
            { productId: b, qty: u(3), unitCost: m(2_222) },
            { productId: c, qty: u(3), unitCost: m(3_333) },
          ],
          invoiceDiscount: m(discount),
          tenders: [],
        },
        ACTOR,
      );

      // The whole purchase value sits in inventory; nothing spills elsewhere.
      const miscellaneous = getAccountBalanceByCode(context.db, '6900');
      expect(miscellaneous, `discount ${discount} leaked to Miscellaneous`).toBe(0);
      expect(purchase.total).toBe(19_998 - discount);
      assertBooksHealthy(`purchase discount ${discount}`);
    }
  });

  it('writes a stock ledger row tagged as a purchase', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = makeProduct('Milo 400g');
    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10), unitCost: m(500) }],
        tenders: [{ paymentAccountId: CASH, amount: m(5_000) }],
      },
      ACTOR,
    );

    const rows = context.db.select().from(stockLedger).where(eq(stockLedger.productId, id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.movementType).toBe('PURCHASE');
    expect(rows[0]?.qtyInMilli).toBe(10_000);
    expect(rows[0]?.sourceRef).toMatch(/^PUR-/);
  });

  it('refuses to pay more than the purchase total, or more than is owed', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = makeProduct('Milo 400g');

    expect(() =>
      createPurchase(
        context.db,
        {
          supplierId,
          businessDate: TODAY,
          items: [{ productId: id, qty: u(1), unitCost: m(500) }],
          tenders: [{ paymentAccountId: CASH, amount: m(9_999) }],
        },
        ACTOR,
      ),
    ).toThrow(/cannot pay more/i);

    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(1), unitCost: m(500) }],
        tenders: [],
      },
      ACTOR,
    );

    expect(() =>
      recordSupplierPayment(
        context.db,
        { supplierId, businessDate: TODAY, paymentAccountId: CASH, amount: m(99_999) },
        ACTOR,
      ),
    ).toThrow(/cannot pay more/i);
  });

  it('rejects a purchase with no items', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    expect(() =>
      createPurchase(context.db, { supplierId, businessDate: TODAY, items: [], tenders: [] }, ACTOR),
    ).toThrow(ValidationError);
  });

  it('leaves nothing behind when a line fails', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const good = makeProduct('Bread');

    expect(() =>
      createPurchase(
        context.db,
        {
          supplierId,
          businessDate: TODAY,
          items: [
            { productId: good, qty: u(10), unitCost: m(500) },
            { productId: 999_999, qty: u(1), unitCost: m(100) }, // does not exist
          ],
          tenders: [],
        },
        ACTOR,
      ),
    ).toThrow();

    expect(context.db.select().from(purchases).all()).toHaveLength(0);
    expect(getProduct(context.db, good).qtyOnHand).toBe(0);
    assertBooksHealthy('purchase rollback');
  });

  it('allocates a supplier payment to the oldest purchase first', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = makeProduct('Milo 400g');

    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: '2026-08-01',
        items: [{ productId: id, qty: u(10), unitCost: m(500) }],
        tenders: [],
      },
      ACTOR,
    ); // owes 50.00
    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: '2026-08-10',
        items: [{ productId: id, qty: u(10), unitCost: m(700) }],
        tenders: [],
      },
      ACTOR,
    ); // owes 70.00

    expect(getSupplierBalance(context.db, supplierId)).toBe(12_000);

    recordSupplierPayment(
      context.db,
      { supplierId, businessDate: TODAY, paymentAccountId: CASH, amount: m(6_000) },
      ACTOR,
    );

    const open = getOpenPurchases(context.db, supplierId);
    expect(open).toHaveLength(1);
    expect(open[0]?.outstandingMinor).toBe(6_000);
    assertBooksHealthy('supplier allocation');
  });

  it('refuses to archive a supplier who is still owed money', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = makeProduct('Milo 400g');
    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(1), unitCost: m(500) }],
        tenders: [],
      },
      ACTOR,
    );

    expect(() => setSupplierActive(context.db, supplierId, false, ACTOR)).toThrow(ConflictError);
  });
});

describe('voiding a purchase', () => {
  it('takes the stock back out and reverses the payable', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = makeProduct('Milo 400g');

    const purchase = createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10), unitCost: m(500) }],
        tenders: [{ paymentAccountId: CASH, amount: m(2_000) }],
      },
      ACTOR,
    );

    expect(getProduct(context.db, id).qtyOnHand).toBe(10_000);
    expect(getSupplierBalance(context.db, supplierId)).toBe(3_000);

    voidPurchase(context.db, purchase.purchaseId, 'Delivered to the wrong shop', ACTOR);

    expect(getProduct(context.db, id).qtyOnHand).toBe(0);
    expect(getProduct(context.db, id).stockValue).toBe(0);
    expect(getSupplierBalance(context.db, supplierId)).toBe(0);
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(0);
    assertBooksHealthy('void purchase');

    const original = context.db
      .select()
      .from(purchases)
      .where(eq(purchases.id, purchase.purchaseId))
      .get();
    expect(original?.status).toBe('VOIDED');
    expect(original?.voidReason).toBe('Delivered to the wrong shop');
  });

  it('refuses to void a purchase that has been paid down', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = makeProduct('Milo 400g');
    const purchase = createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10), unitCost: m(500) }],
        tenders: [],
      },
      ACTOR,
    );
    recordSupplierPayment(
      context.db,
      { supplierId, businessDate: TODAY, paymentAccountId: CASH, amount: m(5_000) },
      ACTOR,
    );

    expect(() => voidPurchase(context.db, purchase.purchaseId, 'Mistake', ACTOR)).toThrow(
      /void those payments first/i,
    );
  });

  it('void of a supplier payment restores the debt', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = makeProduct('Milo 400g');
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
    const payment = recordSupplierPayment(
      context.db,
      { supplierId, businessDate: TODAY, paymentAccountId: CASH, amount: m(3_000) },
      ACTOR,
    );
    expect(getSupplierBalance(context.db, supplierId)).toBe(2_000);

    voidSupplierPayment(context.db, payment.paymentId, 'Cheque bounced', ACTOR);

    expect(getSupplierBalance(context.db, supplierId)).toBe(5_000);
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(0);
    assertBooksHealthy('void supplier payment');
  });
});

describe('customer returns', () => {
  function setUpSale() {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const id = makeProduct('Milo 400g', 500, 1_000);
    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'OPENING_STOCK',
        items: [{ productId: id, direction: 'IN', qty: u(20), totalCost: m(10_000) }],
      },
      ACTOR,
    );
    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        customerId,
        items: [{ productId: id, qty: u(5) }], // 50.00, cost 25.00
        tenders: [{ paymentAccountId: CASH, amount: m(5_000) }],
      },
      ACTOR,
    );
    return { customerId, productId: id, sale };
  }

  it('returns part of a sale, restoring stock at the original cost', () => {
    const { productId, sale } = setUpSale();

    expect(getProduct(context.db, productId).qtyOnHand).toBe(15_000);
    const items = getReturnableSaleItems(context.db, sale.saleId);
    expect(items).toHaveLength(1);
    expect(items[0]?.returnableMilli).toBe(5_000);

    const result = createCustomerReturn(
      context.db,
      sale.saleId,
      {
        businessDate: TODAY,
        items: [{ itemId: items[0]!.id, qty: u(2) }],
        refunds: [{ paymentAccountId: CASH, amount: m(2_000) }],
        reason: 'Damaged tin',
      },
      ACTOR,
    );

    expect(result.refunded).toBe(2_000);

    // Two units back on the shelf at exactly the 5.00 they left at.
    const product = getProduct(context.db, productId);
    expect(product.qtyOnHand).toBe(17_000);
    expect(product.stockValue).toBe(8_500); // 15 x 5.00 + 2 x 5.00

    // Revenue reduced through the contra account, not by editing the sale.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.SALES_REVENUE)).toBe(5_000);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.SALES_RETURNS)).toBe(2_000);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.COST_OF_GOODS_SOLD)).toBe(1_500);
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(3_000); // 50 in, 20 back out
    assertBooksHealthy('customer return');
  });

  it('will not let the same goods be returned twice', () => {
    const { sale } = setUpSale();
    const items = getReturnableSaleItems(context.db, sale.saleId);

    createCustomerReturn(
      context.db,
      sale.saleId,
      {
        businessDate: TODAY,
        items: [{ itemId: items[0]!.id, qty: u(3) }],
        refunds: [{ paymentAccountId: CASH, amount: m(3_000) }],
      },
      ACTOR,
    );

    // Only 2 remain returnable.
    expect(getReturnableSaleItems(context.db, sale.saleId)[0]?.returnableMilli).toBe(2_000);

    expect(() =>
      createCustomerReturn(
        context.db,
        sale.saleId,
        { businessDate: TODAY, items: [{ itemId: items[0]!.id, qty: u(3) }] },
        ACTOR,
      ),
    ).toThrow(/can still be returned/i);
  });

  it('credits the customer’s account when no cash is refunded', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const id = makeProduct('Milo 400g', 500, 1_000);
    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'OPENING_STOCK',
        items: [{ productId: id, direction: 'IN', qty: u(20), totalCost: m(10_000) }],
      },
      ACTOR,
    );
    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        customerId,
        items: [{ productId: id, qty: u(5) }],
        tenders: [], // all on credit — owes 50.00
      },
      ACTOR,
    );
    expect(getCustomerBalance(context.db, customerId)).toBe(5_000);

    const items = getReturnableSaleItems(context.db, sale.saleId);
    const result = createCustomerReturn(
      context.db,
      sale.saleId,
      { businessDate: TODAY, items: [{ itemId: items[0]!.id, qty: u(2) }] },
      ACTOR,
    );

    expect(result.refunded).toBe(0);
    expect(result.creditApplied).toBe(2_000);
    // Their debt fell by the value of the goods returned.
    expect(getCustomerBalance(context.db, customerId)).toBe(3_000);
    assertBooksHealthy('return credited');
  });

  it('refuses to refund more than the goods are worth', () => {
    const { sale } = setUpSale();
    const items = getReturnableSaleItems(context.db, sale.saleId);

    expect(() =>
      createCustomerReturn(
        context.db,
        sale.saleId,
        {
          businessDate: TODAY,
          items: [{ itemId: items[0]!.id, qty: u(1) }],
          refunds: [{ paymentAccountId: CASH, amount: m(99_999) }],
        },
        ACTOR,
      ),
    ).toThrow(/more than the value/i);
  });

  it('keeps the original sale untouched', () => {
    const { sale } = setUpSale();
    const items = getReturnableSaleItems(context.db, sale.saleId);

    createCustomerReturn(
      context.db,
      sale.saleId,
      {
        businessDate: TODAY,
        items: [{ itemId: items[0]!.id, qty: u(2) }],
        refunds: [{ paymentAccountId: CASH, amount: m(2_000) }],
      },
      ACTOR,
    );

    const original = context.db.select().from(saleItems).where(eq(saleItems.id, items[0]!.id)).get();
    // Quantity and value as originally sold; only the returned counter moved.
    expect(original?.qtyMilli).toBe(5_000);
    expect(original?.lineTotalMinor).toBe(5_000);
    expect(original?.returnedQtyMilli).toBe(2_000);

    // The return is a separate, linked document.
    const returnDoc = context.db
      .select()
      .from(sales)
      .all()
      .find((row) => row.kind === 'RETURN');
    expect(returnDoc?.returnsSaleId).toBe(sale.saleId);
  });
});

describe('supplier returns', () => {
  it('sends goods back at the price the supplier charged, not the blended average', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = makeProduct('Milo 400g');

    // Two deliveries at different prices -> average 6.00.
    const cheap = createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10), unitCost: m(500) }],
        tenders: [],
      },
      ACTOR,
    );
    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10), unitCost: m(700) }],
        tenders: [],
      },
      ACTOR,
    );
    expect(getProduct(context.db, id).averageCost).toBe(600);

    // Return 5 of the CHEAP delivery.
    const items = getReturnablePurchaseItems(context.db, cheap.purchaseId);
    createSupplierReturn(
      context.db,
      cheap.purchaseId,
      { businessDate: TODAY, items: [{ itemId: items[0]!.id, qty: u(5) }] },
      ACTOR,
    );

    const product = getProduct(context.db, id);
    expect(product.qtyOnHand).toBe(15_000);
    // 120.00 less the 25.00 those five actually cost.
    expect(product.stockValue).toBe(9_500);
    // Sending cheap stock back correctly leaves the average higher.
    expect(product.averageCost).toBe(633);

    // The debt to the supplier fell by what was returned.
    expect(getSupplierBalance(context.db, supplierId)).toBe(9_500);
    assertBooksHealthy('supplier return');
  });

  it('refunds to a payment account when the supplier gives money back', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = makeProduct('Milo 400g');

    const purchase = createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10), unitCost: m(500) }],
        tenders: [{ paymentAccountId: MOMO, amount: m(5_000) }],
      },
      ACTOR,
    );
    expect(getAccountBalanceByCode(context.db, '1011')).toBe(-5_000);

    const items = getReturnablePurchaseItems(context.db, purchase.purchaseId);
    const result = createSupplierReturn(
      context.db,
      purchase.purchaseId,
      {
        businessDate: TODAY,
        items: [{ itemId: items[0]!.id, qty: u(4) }],
        refunds: [{ paymentAccountId: MOMO, amount: m(2_000) }],
      },
      ACTOR,
    );

    expect(result.refunded).toBe(2_000);
    expect(getAccountBalanceByCode(context.db, '1011')).toBe(-3_000);
    expect(getProduct(context.db, id).qtyOnHand).toBe(6_000);
    assertBooksHealthy('supplier refund');
  });

  it('will not return more than was delivered', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = makeProduct('Milo 400g');
    const purchase = createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10), unitCost: m(500) }],
        tenders: [],
      },
      ACTOR,
    );
    const items = getReturnablePurchaseItems(context.db, purchase.purchaseId);

    expect(() =>
      createSupplierReturn(
        context.db,
        purchase.purchaseId,
        { businessDate: TODAY, items: [{ itemId: items[0]!.id, qty: u(11) }] },
        ACTOR,
      ),
    ).toThrow(/can still be returned/i);
  });

  it('refuses to return stock that has already been sold on', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = makeProduct('Milo 400g', 500, 1_000);
    const purchase = createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10), unitCost: m(500) }],
        tenders: [],
      },
      ACTOR,
    );

    // Sell nearly all of it.
    createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(9) }],
        tenders: [{ paymentAccountId: CASH, amount: m(9_000) }],
      },
      ACTOR,
    );

    const items = getReturnablePurchaseItems(context.db, purchase.purchaseId);
    expect(() =>
      createSupplierReturn(
        context.db,
        purchase.purchaseId,
        { businessDate: TODAY, items: [{ itemId: items[0]!.id, qty: u(5) }] },
        ACTOR,
      ),
    ).toThrow(InsufficientStockError);
  });
});

describe('reads', () => {
  it('reports outstanding on the purchase list', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = makeProduct('Milo 400g');
    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10), unitCost: m(500) }],
        tenders: [{ paymentAccountId: CASH, amount: m(2_000) }],
      },
      ACTOR,
    );

    const rows = listPurchases(context.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totalMinor).toBe(5_000);
    expect(rows[0]?.outstandingMinor).toBe(3_000);
    expect(listPurchases(context.db, { unpaidOnly: true })).toHaveLength(1);
  });

  it('snapshots the product name onto the purchase line', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = makeProduct('Milo 400g');
    const purchase = createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(1), unitCost: m(500) }],
        tenders: [{ paymentAccountId: CASH, amount: m(500) }],
      },
      ACTOR,
    );

    context.db.update(products).set({ name: 'Renamed' }).where(eq(products.id, id)).run();
    expect(getPurchase(context.db, purchase.purchaseId).items[0]?.productName).toBe('Milo 400g');
  });

  it('links a return document to its original purchase', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const id = makeProduct('Milo 400g');
    const purchase = createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(10), unitCost: m(500) }],
        tenders: [],
      },
      ACTOR,
    );
    const items = getReturnablePurchaseItems(context.db, purchase.purchaseId);
    createSupplierReturn(
      context.db,
      purchase.purchaseId,
      { businessDate: TODAY, items: [{ itemId: items[0]!.id, qty: u(2) }] },
      ACTOR,
    );

    const returnDoc = context.db
      .select()
      .from(purchases)
      .all()
      .find((row) => row.kind === 'RETURN');
    expect(returnDoc?.returnsPurchaseId).toBe(purchase.purchaseId);

    // The original purchase line records how much went back.
    const line = context.db
      .select()
      .from(purchaseItems)
      .where(eq(purchaseItems.id, items[0]!.id))
      .get();
    expect(line?.returnedQtyMilli).toBe(2_000);
    expect(line?.qtyMilli).toBe(10_000);
  });
});

describe('a delivery that carries a date', () => {
  /**
   * The first thing about expiry the shop can actually see.
   *
   * A line with a date opens its own batch. A line without one changes nothing
   * at all — which matters more than it sounds, because most lines in most
   * shops will never carry a date and none of those people should notice this
   * feature exists.
   */

  const batchesOf = (productId: number) =>
    context.db
      .select()
      .from(productBatches)
      .where(eq(productBatches.productId, productId))
      .all()
      .sort((a, b) => a.id - b.id);

  function expectBatchesIntact(label: string): void {
    for (const row of verifyBatchCoverage(context.db)) {
      expect(row.ok, `${label}: product ${row.productId}`).toBe(true);
    }
    for (const product of context.db.select({ id: products.id }).from(products).all()) {
      for (const check of verifyProductBatches(context.db, product.id)) {
        expect(check.ok, `${label}: batch ${check.batchId}`).toBe(true);
      }
    }
  }

  it('opens a batch carrying that date', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const milk = makeProduct('Evaporated Milk');

    createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId,
        items: [{ productId: milk, qty: u(24), unitCost: m(300), expiryDate: '2027-03-31' }],
        tenders: [{ paymentAccountId: CASH, amount: m(7_200) }],
      },
      ACTOR,
    );

    const [batch] = batchesOf(milk);
    expect(batch!.expiryDate).toBe('2027-03-31');
    expect(batch!.qtyMilli).toBe(24_000);
    expect(batch!.supplierId).toBe(supplierId);
    expect(batch!.sourceType).toBe('PURCHASE');
    expect(batch!.batchRef).toMatch(/^BAT-\d{5}$/);
    expectBatchesIntact('dated delivery');
  });

  it('lands in the undated batch when no date is given', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const rice = makeProduct('Rice 5kg');

    createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId,
        items: [{ productId: rice, qty: u(10), unitCost: m(1_000) }],
        tenders: [{ paymentAccountId: CASH, amount: m(10_000) }],
      },
      ACTOR,
    );

    const [batch] = batchesOf(rice);
    expect(batch!.expiryDate).toBeNull();
    expect(batch!.qtyMilli).toBe(10_000);
    expectBatchesIntact('undated delivery');
  });

  it('keeps two dates of the same product apart', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const milk = makeProduct('Evaporated Milk');

    createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId,
        items: [
          { productId: milk, qty: u(12), unitCost: m(300), expiryDate: '2026-11-30' },
          { productId: milk, qty: u(12), unitCost: m(300), expiryDate: '2027-03-31' },
        ],
        tenders: [{ paymentAccountId: CASH, amount: m(7_200) }],
      },
      ACTOR,
    );

    expect(batchesOf(milk).map((b) => [b.expiryDate, b.qtyMilli])).toEqual([
      ['2026-11-30', 12_000],
      ['2027-03-31', 12_000],
    ]);
    expectBatchesIntact('two dates on one invoice');
  });

  it('sells the tighter date first, and leaves the other alone', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const milk = makeProduct('Evaporated Milk');

    createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId,
        items: [
          { productId: milk, qty: u(6), unitCost: m(300), expiryDate: '2027-03-31' },
          { productId: milk, qty: u(6), unitCost: m(300), expiryDate: '2026-11-30' },
        ],
        tenders: [{ paymentAccountId: CASH, amount: m(3_600) }],
      },
      ACTOR,
    );

    createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: milk, qty: u(4) }],
        tenders: [{ paymentAccountId: CASH, amount: m(3_200) }],
      },
      ACTOR,
    );

    expect(batchesOf(milk).map((b) => [b.expiryDate, b.qtyMilli])).toEqual([
      ['2027-03-31', 6_000],
      ['2026-11-30', 2_000],
    ]);
    expectBatchesIntact('fefo from a real sale');
  });

  it('refuses a date that is not a date', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const milk = makeProduct('Evaporated Milk');

    // Batch dates are compared as text, so '31/03/2027' would sort as though it
    // were centuries away and quietly change which crate leaves the shelf.
    expect(() =>
      createPurchase(
        context.db,
        {
          businessDate: TODAY,
          supplierId,
          items: [{ productId: milk, qty: u(6), unitCost: m(300), expiryDate: '31/03/2027' }],
          tenders: [{ paymentAccountId: CASH, amount: m(1_800) }],
        },
        ACTOR,
      ),
    ).toThrow(ValidationError);

    expect(batchesOf(milk)).toEqual([]);
    expect(getProduct(context.db, milk).qtyOnHand).toBe(0);
  });
});

describe('sending goods back to the supplier they came from', () => {
  const batchesOf = (productId: number) =>
    context.db
      .select()
      .from(productBatches)
      .where(eq(productBatches.productId, productId))
      .all()
      .sort((a, b) => a.id - b.id);

  it('empties the batch the voided delivery opened, not the oldest one', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const milk = makeProduct('Evaporated Milk');

    // An older crate that expires SOONER, so FEFO would take this one first.
    createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId,
        items: [{ productId: milk, qty: u(6), unitCost: m(300), expiryDate: '2026-10-31' }],
        tenders: [{ paymentAccountId: CASH, amount: m(1_800) }],
      },
      ACTOR,
    );

    const later = createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId,
        items: [{ productId: milk, qty: u(6), unitCost: m(300), expiryDate: '2027-03-31' }],
        tenders: [{ paymentAccountId: CASH, amount: m(1_800) }],
      },
      ACTOR,
    );

    voidPurchase(context.db, later.purchaseId, 'Delivered to the wrong shop', ACTOR);

    expect(batchesOf(milk).map((b) => [b.expiryDate, b.qtyMilli, b.isClosed])).toEqual([
      ['2026-10-31', 6_000, false],
      ['2027-03-31', 0, true],
    ]);
    assertBooksHealthy('void of a dated delivery');
  });

  it('draws a return from that supplier batch even when an older one exists', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const milk = makeProduct('Evaporated Milk');

    createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId,
        items: [{ productId: milk, qty: u(6), unitCost: m(300), expiryDate: '2026-10-31' }],
        tenders: [{ paymentAccountId: CASH, amount: m(1_800) }],
      },
      ACTOR,
    );

    const second = createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId,
        items: [{ productId: milk, qty: u(6), unitCost: m(400), expiryDate: '2027-03-31' }],
        tenders: [{ paymentAccountId: CASH, amount: m(2_400) }],
      },
      ACTOR,
    );

    const items = getReturnablePurchaseItems(context.db, second.purchaseId);
    createSupplierReturn(
      context.db,
      second.purchaseId,
      { businessDate: TODAY, items: [{ itemId: items[0]!.id, qty: u(4) }] },
      ACTOR,
    );

    // Four came out of THEIR crate. The older, tighter-dated one is untouched.
    expect(batchesOf(milk).map((b) => [b.expiryDate, b.qtyMilli])).toEqual([
      ['2026-10-31', 6_000],
      ['2027-03-31', 2_000],
    ]);
    assertBooksHealthy('supplier return from a dated batch');
  });

  it('falls back to picking when their crate has already been sold', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const milk = makeProduct('Evaporated Milk');

    // Their delivery expires SOONEST, so the sale takes all of it.
    const theirs = createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId,
        items: [{ productId: milk, qty: u(6), unitCost: m(300), expiryDate: '2026-10-31' }],
        tenders: [{ paymentAccountId: CASH, amount: m(1_800) }],
      },
      ACTOR,
    );

    createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId,
        items: [{ productId: milk, qty: u(6), unitCost: m(300), expiryDate: '2027-03-31' }],
        tenders: [{ paymentAccountId: CASH, amount: m(1_800) }],
      },
      ACTOR,
    );

    createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: milk, qty: u(6) }],
        tenders: [{ paymentAccountId: CASH, amount: m(4_800) }],
      },
      ACTOR,
    );

    // Nothing of theirs is left. The goods still have to leave, so the rest
    // comes from what IS on the shelf rather than driving their batch negative.
    const items = getReturnablePurchaseItems(context.db, theirs.purchaseId);
    createSupplierReturn(
      context.db,
      theirs.purchaseId,
      { businessDate: TODAY, items: [{ itemId: items[0]!.id, qty: u(3) }] },
      ACTOR,
    );

    expect(batchesOf(milk).map((b) => [b.expiryDate, b.qtyMilli])).toEqual([
      ['2026-10-31', 0],
      ['2027-03-31', 3_000],
    ]);
    assertBooksHealthy('return after their stock was sold');
  });

  it('still voids a delivery made before batches existed', () => {
    /**
     * Every purchase in every existing shop is one of these. Migration 0019
     * backfilled an opening batch and left history alone, so there is no split
     * to put back — and the void must work exactly as it did before.
     */
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const rice = makeProduct('Rice 5kg');

    const purchase = createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId,
        items: [{ productId: rice, qty: u(10), unitCost: m(1_000) }],
        tenders: [{ paymentAccountId: CASH, amount: m(10_000) }],
      },
      ACTOR,
    );

    // Erase the split, as a pre-migration delivery has none.
    context.connection.prepare('DELETE FROM stock_ledger_batches').run();

    voidPurchase(context.db, purchase.purchaseId, 'Never arrived', ACTOR);

    expect(getProduct(context.db, rice).qtyOnHand).toBe(0);
    assertBooksHealthy('void of a pre-batch delivery');
  });
});
