import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import {
  businessSettings,
  paymentAccounts,
  products,
  saleItems,
  salePayments,
  sales,
  stockLedger,
} from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createProduct, getProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale, getSale, getSalesSummary, listSales, voidSale } from '@/services/sale.service';
import {
  createCustomer,
  getCustomerBalance,
  getTotalReceivables,
  setCustomerActive,
} from '@/services/customer.service';
import {
  getOpenSales,
  recordCustomerPayment,
  voidCustomerPayment,
} from '@/services/customer-payment.service';
import { verifyProductStock, getInventoryValue } from '@/services/inventory.service';
import { getAccountBalanceByCode, getTrialBalance } from '@/services/reporting/balances.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, parseQty, type Qty } from '@/domain/quantity';
import { ConflictError, InsufficientStockError, ValidationError } from '@/domain/errors';

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-16';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH_ACCOUNT = 0;
let MOMO_ACCOUNT = 0;

function makeProduct(name: string, cost = 500, price = 800): number {
  return createProduct(
    context.db,
    { name, costPrice: m(cost), sellingPrice: m(price), unit: 'pcs' },
    ACTOR,
  );
}

function addStock(productId: number, qtyUnits: number, totalCostMinor: number) {
  return createStockAdjustment(
    context.db,
    {
      businessDate: TODAY,
      reason: 'OPENING_STOCK',
      items: [{ productId, direction: 'IN', qty: u(qtyUnits), totalCost: m(totalCostMinor) }],
    },
    ACTOR,
  );
}

/** Assert the invariants that must hold after EVERY financial operation. */
function assertBooksHealthy(label: string) {
  expect(getTrialBalance(context.db).balanced, `${label}: trial balance`).toBe(true);

  expect(getInventoryValue(context.db), `${label}: inventory vs GL`).toBe(
    getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY),
  );

  // The A/R subledger must equal its control account.
  expect(getTotalReceivables(context.db), `${label}: A/R subledger vs control`).toBe(
    getAccountBalanceByCode(context.db, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE),
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
  CASH_ACCOUNT = accounts.find((a) => a.kind === 'CASH')!.id;
  MOMO_ACCOUNT = accounts.find((a) => a.kind === 'MOBILE_MONEY')!.id;
});

afterEach(() => {
  context.cleanup();
});

describe('cash sale', () => {
  it('reduces stock, records revenue and COGS, and increases cash', () => {
    const id = makeProduct('Milo 400g', 500, 800);
    addStock(id, 10, 5_000); // cost 5.00 each

    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(3) }], // 3 x 8.00 = 24.00
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(2_400) }],
      },
      ACTOR,
    );

    expect(sale.total).toBe(2_400);
    expect(sale.cogs).toBe(1_500); // 3 x 5.00
    expect(sale.change).toBe(0);
    expect(sale.outstanding).toBe(0);

    // Stock down by 3.
    expect(getProduct(context.db, id).qtyOnHand).toBe(7_000);

    // The accounts.
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(2_400); // cash
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.SALES_REVENUE)).toBe(2_400);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.COST_OF_GOODS_SOLD)).toBe(1_500);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY)).toBe(3_500);

    assertBooksHealthy('cash sale');
  });

  it('gives change without recording it as revenue', () => {
    const id = makeProduct('Bread', 800, 1_200);
    addStock(id, 10, 8_000);

    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(1) }], // 12.00
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(2_000) }], // paid 20.00
      },
      ACTOR,
    );

    expect(sale.total).toBe(1_200);
    expect(sale.change).toBe(800);
    // Only the sale total reached the cash account, not the 20.00 tendered.
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(1_200);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.SALES_REVENUE)).toBe(1_200);
    assertBooksHealthy('change given');
  });

  it('writes a stock ledger row tagged as a sale', () => {
    const id = makeProduct('Milo 400g');
    addStock(id, 10, 5_000);
    createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(2) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(1_600) }],
      },
      ACTOR,
    );

    const rows = context.db.select().from(stockLedger).where(eq(stockLedger.productId, id)).all();
    expect(rows.map((r) => r.movementType)).toEqual(['OPENING_STOCK', 'SALE']);
    expect(rows[1]?.qtyOutMilli).toBe(2_000);
    expect(rows[1]?.totalCostMinor).toBe(1_000);
    expect(rows[1]?.sourceRef).toMatch(/^RCP-/);
  });
});

describe('MoMo and split payments', () => {
  it('records a MoMo sale against the MoMo account', () => {
    const id = makeProduct('Milo 400g', 500, 800);
    addStock(id, 10, 5_000);

    createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(2) }],
        tenders: [{ paymentAccountId: MOMO_ACCOUNT, amount: m(1_600), reference: 'MM123456' }],
      },
      ACTOR,
    );

    expect(getAccountBalanceByCode(context.db, '1011')).toBe(1_600); // MoMo
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(0); // cash untouched
    assertBooksHealthy('momo sale');
  });

  it('splits one sale across cash and MoMo', () => {
    const id = makeProduct('Milo 400g', 500, 800);
    addStock(id, 10, 5_000);

    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(5) }], // 40.00
        tenders: [
          { paymentAccountId: CASH_ACCOUNT, amount: m(1_500) },
          { paymentAccountId: MOMO_ACCOUNT, amount: m(2_500) },
        ],
      },
      ACTOR,
    );

    expect(sale.outstanding).toBe(0);
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(1_500);
    expect(getAccountBalanceByCode(context.db, '1011')).toBe(2_500);

    const tenders = context.db
      .select()
      .from(salePayments)
      .where(eq(salePayments.saleId, sale.saleId))
      .all();
    expect(tenders).toHaveLength(2);
    assertBooksHealthy('split payment');
  });
});

describe('discounts', () => {
  it('records a discount as contra-revenue, keeping gross sales visible', () => {
    const id = makeProduct('Milo 400g', 500, 1_000);
    addStock(id, 10, 5_000);

    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(5) }], // 50.00
        invoiceDiscount: m(500), // 5.00 off
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(4_500) }],
        // ACTOR is an owner, who may depart from the shop's prices.
        allowPriceOverride: true,
      },
      ACTOR,
    );

    expect(sale.total).toBe(4_500);
    // Gross revenue is the full 50.00; the discount sits in its own account.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.SALES_REVENUE)).toBe(5_000);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.SALES_DISCOUNTS)).toBe(500);
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(4_500);
    assertBooksHealthy('discount');
  });
});

describe('credit sales', () => {
  it('handles the brief’s worked example: sell 500, pay 200, owe 300', () => {
    const customerId = createCustomer(context.db, { name: 'Ama Serwaa' }, ACTOR);
    const id = makeProduct('Rice', 1_400, 1_900);
    addStock(id, 100, 140_000);

    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        customerId,
        items: [{ productId: id, qty: u(1), unitPrice: m(50_000) }], // GHS 500
        tenders: [{ paymentAccountId: MOMO_ACCOUNT, amount: m(20_000) }], // GHS 200
        // ACTOR is an owner, who may depart from the shop's prices.
        allowPriceOverride: true,
      },
      ACTOR,
    );

    expect(sale.total).toBe(50_000);
    expect(sale.outstanding).toBe(30_000);

    // Receivable = 300, and it is tagged to this customer.
    expect(getCustomerBalance(context.db, customerId)).toBe(30_000);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE)).toBe(30_000);
    expect(getAccountBalanceByCode(context.db, '1011')).toBe(20_000);
    assertBooksHealthy('credit sale');

    // Customer later pays the 300.
    recordCustomerPayment(
      context.db,
      {
        customerId,
        businessDate: TODAY,
        paymentAccountId: CASH_ACCOUNT,
        amount: m(30_000),
      },
      ACTOR,
    );

    expect(getCustomerBalance(context.db, customerId)).toBe(0);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE)).toBe(0);
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(30_000);
    assertBooksHealthy('after settlement');
  });

  it('refuses an unpaid sale with no customer to bill', () => {
    const id = makeProduct('Milo 400g');
    addStock(id, 10, 5_000);

    expect(() =>
      createSale(
        context.db,
        { businessDate: TODAY, items: [{ productId: id, qty: u(1) }], tenders: [] },
        ACTOR,
      ),
    ).toThrow(/choose a customer/i);
  });

  it('enforces the credit limit', () => {
    const customerId = createCustomer(
      context.db,
      { name: 'Kofi', creditLimit: m(10_000) },
      ACTOR,
    );
    const id = makeProduct('Rice', 1_400, 1_900);
    addStock(id, 100, 140_000);

    expect(() =>
      createSale(
        context.db,
        {
          businessDate: TODAY,
          customerId,
          items: [{ productId: id, qty: u(1), unitPrice: m(15_000) }],
          tenders: [],
          // ACTOR is an owner, who may depart from the shop's prices.
          allowPriceOverride: true,
        },
        ACTOR,
      ),
    ).toThrow(/credit limit/i);

    // Nothing was written — stock is untouched.
    expect(getProduct(context.db, id).qtyOnHand).toBe(100_000);
    assertBooksHealthy('credit limit refused');
  });

  it('treats a zero credit limit as no credit at all', () => {
    const customerId = createCustomer(context.db, { name: 'Yaw', creditLimit: m(0) }, ACTOR);
    const id = makeProduct('Milo 400g');
    addStock(id, 10, 5_000);

    expect(() =>
      createSale(
        context.db,
        { businessDate: TODAY, customerId, items: [{ productId: id, qty: u(1) }], tenders: [] },
        ACTOR,
      ),
    ).toThrow(/credit limit/i);
  });

  it('allows unlimited credit when no limit is set', () => {
    const customerId = createCustomer(context.db, { name: 'Trusted', creditLimit: null }, ACTOR);
    const id = makeProduct('Rice', 1_400, 1_900);
    addStock(id, 1_000, 1_400_000);

    createSale(
      context.db,
      {
        businessDate: TODAY,
        customerId,
        items: [{ productId: id, qty: u(500) }],
        tenders: [],
      },
      ACTOR,
    );
    expect(getCustomerBalance(context.db, customerId)).toBeGreaterThan(0);
    assertBooksHealthy('unlimited credit');
  });

  it('refuses a payment larger than what is owed', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const id = makeProduct('Milo 400g', 500, 800);
    addStock(id, 10, 5_000);

    createSale(
      context.db,
      { businessDate: TODAY, customerId, items: [{ productId: id, qty: u(1) }], tenders: [] },
      ACTOR,
    );

    expect(() =>
      recordCustomerPayment(
        context.db,
        { customerId, businessDate: TODAY, paymentAccountId: CASH_ACCOUNT, amount: m(999_999) },
        ACTOR,
      ),
    ).toThrow(/cannot receive more/i);
  });

  it('allocates a partial payment to the oldest sale first', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const id = makeProduct('Milo 400g', 500, 1_000);
    addStock(id, 100, 50_000);

    createSale(
      context.db,
      { businessDate: '2026-08-01', customerId, items: [{ productId: id, qty: u(2) }], tenders: [] },
      ACTOR,
    ); // 20.00
    createSale(
      context.db,
      { businessDate: '2026-08-10', customerId, items: [{ productId: id, qty: u(3) }], tenders: [] },
      ACTOR,
    ); // 30.00

    expect(getCustomerBalance(context.db, customerId)).toBe(5_000);

    recordCustomerPayment(
      context.db,
      { customerId, businessDate: TODAY, paymentAccountId: CASH_ACCOUNT, amount: m(2_500) },
      ACTOR,
    );

    const open = getOpenSales(context.db, customerId);
    // The older sale is fully settled; the newer one is partly paid.
    expect(open).toHaveLength(1);
    expect(open[0]?.outstandingMinor).toBe(2_500);
    expect(getCustomerBalance(context.db, customerId)).toBe(2_500);
    assertBooksHealthy('partial allocation');
  });

  it('refuses to archive a customer who still owes money', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const id = makeProduct('Milo 400g', 500, 800);
    addStock(id, 10, 5_000);

    createSale(
      context.db,
      { businessDate: TODAY, customerId, items: [{ productId: id, qty: u(1) }], tenders: [] },
      ACTOR,
    );

    expect(() => setCustomerActive(context.db, customerId, false, ACTOR)).toThrow(ConflictError);
  });
});

describe('stock rules', () => {
  it('refuses to sell more than is on the shelf', () => {
    const id = makeProduct('Milo 400g');
    addStock(id, 2, 1_000);

    expect(() =>
      createSale(
        context.db,
        {
          businessDate: TODAY,
          items: [{ productId: id, qty: u(3) }],
          tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(2_400) }],
        },
        ACTOR,
      ),
    ).toThrow(InsufficientStockError);

    // Nothing partial survived.
    expect(context.db.select().from(sales).all()).toHaveLength(0);
    expect(getProduct(context.db, id).qtyOnHand).toBe(2_000);
    assertBooksHealthy('insufficient stock');
  });

  it('allows overselling once the shop enables negative stock', () => {
    const id = makeProduct('Milo 400g', 500, 800);
    addStock(id, 2, 1_000);
    context.db
      .update(businessSettings)
      .set({ allowNegativeStock: true })
      .where(eq(businessSettings.id, 1))
      .run();

    createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(3) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(2_400) }],
      },
      ACTOR,
    );

    expect(getProduct(context.db, id).qtyOnHand).toBe(-1_000);
    assertBooksHealthy('negative stock');
  });

  it('rejects a sale with no items', () => {
    expect(() =>
      createSale(context.db, { businessDate: TODAY, items: [], tenders: [] }, ACTOR),
    ).toThrow(ValidationError);
  });
});

describe('profit uses the snapshotted cost, not today’s price', () => {
  it('does not change historic profit when the product cost later changes', () => {
    const id = makeProduct('Milo 400g', 500, 1_000);
    addStock(id, 10, 5_000); // 5.00 each

    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(2) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(2_000) }],
      },
      ACTOR,
    );

    expect(sale.cogs).toBe(1_000);

    // Buy more at a much higher price, moving the average up sharply.
    addStock(id, 10, 20_000);
    // And change the reference cost price too.
    context.db.update(products).set({ costPriceMinor: 9_999 }).where(eq(products.id, id)).run();

    // The recorded sale is untouched.
    const stored = getSale(context.db, sale.saleId);
    expect(stored.cogsMinor).toBe(1_000);
    expect(stored.items[0]?.totalCostMinor).toBe(1_000);

    const summary = getSalesSummary(context.db, TODAY, TODAY);
    expect(summary.grossProfit).toBe(1_000); // 20.00 revenue - 10.00 cost
  });

  it('uses the weighted average at the moment of sale', () => {
    const id = makeProduct('Milo 400g', 500, 1_000);
    addStock(id, 10, 5_000); // 5.00
    addStock(id, 10, 7_000); // -> average 6.00

    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(5) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(5_000) }],
      },
      ACTOR,
    );

    expect(sale.cogs).toBe(3_000); // 5 x 6.00
    assertBooksHealthy('weighted average cogs');
  });
});

describe('voiding a sale', () => {
  it('puts stock and money back without deleting anything', () => {
    const id = makeProduct('Milo 400g', 500, 800);
    addStock(id, 10, 5_000);

    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(3) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(2_400) }],
      },
      ACTOR,
    );

    expect(getProduct(context.db, id).qtyOnHand).toBe(7_000);
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(2_400);

    voidSale(context.db, sale.saleId, 'Customer changed their mind', ACTOR);

    // Everything is back.
    const product = getProduct(context.db, id);
    expect(product.qtyOnHand).toBe(10_000);
    expect(product.stockValue).toBe(5_000);
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(0);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.SALES_REVENUE)).toBe(0);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.COST_OF_GOODS_SOLD)).toBe(0);
    assertBooksHealthy('after void');

    // The original is kept and marked.
    const original = context.db.select().from(sales).where(eq(sales.id, sale.saleId)).get();
    expect(original?.status).toBe('VOIDED');
    expect(original?.voidReason).toBe('Customer changed their mind');
    expect(original?.voidedBySaleId).toBeGreaterThan(0);

    // The original's items still exist untouched.
    expect(context.db.select().from(saleItems).where(eq(saleItems.saleId, sale.saleId)).all()).toHaveLength(1);
  });

  it('restores stock at the original cost even after the average moved', () => {
    const id = makeProduct('Milo 400g', 500, 1_000);
    addStock(id, 10, 5_000); // 5.00 each

    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(2) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(2_000) }],
      },
      ACTOR,
    );
    expect(sale.cogs).toBe(1_000);

    addStock(id, 8, 16_000); // average rises sharply
    const valueBefore = getProduct(context.db, id).stockValue;

    voidSale(context.db, sale.saleId, 'Wrong item scanned', ACTOR);

    // Exactly the original 10.00 came back, not today's higher average.
    expect(getProduct(context.db, id).stockValue).toBe(valueBefore + 1_000);
    assertBooksHealthy('void after average moved');
  });

  it('reverses the receivable on a credit sale', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const id = makeProduct('Milo 400g', 500, 800);
    addStock(id, 10, 5_000);

    const sale = createSale(
      context.db,
      { businessDate: TODAY, customerId, items: [{ productId: id, qty: u(2) }], tenders: [] },
      ACTOR,
    );
    expect(getCustomerBalance(context.db, customerId)).toBe(1_600);

    voidSale(context.db, sale.saleId, 'Entered twice', ACTOR);

    expect(getCustomerBalance(context.db, customerId)).toBe(0);
    assertBooksHealthy('void credit sale');
  });

  it('refuses to void twice, and refuses if a payment was received', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const id = makeProduct('Milo 400g', 500, 800);
    addStock(id, 10, 5_000);

    const paid = createSale(
      context.db,
      { businessDate: TODAY, customerId, items: [{ productId: id, qty: u(2) }], tenders: [] },
      ACTOR,
    );
    recordCustomerPayment(
      context.db,
      { customerId, businessDate: TODAY, paymentAccountId: CASH_ACCOUNT, amount: m(1_600) },
      ACTOR,
    );

    expect(() => voidSale(context.db, paid.saleId, 'Mistake', ACTOR)).toThrow(
      /void those payments first/i,
    );

    const other = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(1) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(800) }],
      },
      ACTOR,
    );
    voidSale(context.db, other.saleId, 'Mistake', ACTOR);
    expect(() => voidSale(context.db, other.saleId, 'Again', ACTOR)).toThrow(ConflictError);
  });

  it('requires a reason', () => {
    const id = makeProduct('Milo 400g');
    addStock(id, 10, 5_000);
    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(1) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(800) }],
      },
      ACTOR,
    );
    expect(() => voidSale(context.db, sale.saleId, 'x', ACTOR)).toThrow(ValidationError);
  });
});

describe('voiding a customer payment', () => {
  it('restores the debt and takes the money back out', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const id = makeProduct('Milo 400g', 500, 800);
    addStock(id, 10, 5_000);

    createSale(
      context.db,
      { businessDate: TODAY, customerId, items: [{ productId: id, qty: u(2) }], tenders: [] },
      ACTOR,
    );
    const payment = recordCustomerPayment(
      context.db,
      { customerId, businessDate: TODAY, paymentAccountId: CASH_ACCOUNT, amount: m(1_000) },
      ACTOR,
    );

    expect(getCustomerBalance(context.db, customerId)).toBe(600);

    voidCustomerPayment(context.db, payment.paymentId, 'Bounced', ACTOR);

    expect(getCustomerBalance(context.db, customerId)).toBe(1_600);
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(0);
    assertBooksHealthy('void payment');
  });
});

describe('reads', () => {
  it('reports outstanding and profit on the sales list', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const id = makeProduct('Milo 400g', 500, 1_000);
    addStock(id, 10, 5_000);

    createSale(
      context.db,
      {
        businessDate: TODAY,
        customerId,
        items: [{ productId: id, qty: u(3) }], // 30.00, cost 15.00
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(1_000) }],
      },
      ACTOR,
    );

    const rows = listSales(context.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totalMinor).toBe(3_000);
    expect(rows[0]?.outstandingMinor).toBe(2_000);
    expect(rows[0]?.profitMinor).toBe(1_500);

    expect(listSales(context.db, { unpaidOnly: true })).toHaveLength(1);
  });

  it('snapshots the product name onto the receipt line', () => {
    const id = makeProduct('Milo 400g', 500, 800);
    addStock(id, 10, 5_000);
    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(1) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(800) }],
      },
      ACTOR,
    );

    context.db.update(products).set({ name: 'Milo Tin (new packaging)' }).where(eq(products.id, id)).run();

    // A reprinted receipt still shows what was actually sold.
    expect(getSale(context.db, sale.saleId).items[0]?.productName).toBe('Milo 400g');
  });

  it('summarises a period', () => {
    const id = makeProduct('Milo 400g', 500, 1_000);
    addStock(id, 100, 50_000);

    createSale(
      context.db,
      {
        businessDate: '2026-08-01',
        items: [{ productId: id, qty: u(2) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(2_000) }],
      },
      ACTOR,
    );
    createSale(
      context.db,
      {
        businessDate: '2026-08-16',
        items: [{ productId: id, qty: u(3) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(3_000) }],
      },
      ACTOR,
    );

    const august = getSalesSummary(context.db, '2026-08-01', '2026-08-31');
    expect(august.count).toBe(2);
    expect(august.total).toBe(5_000);
    expect(august.cogs).toBe(2_500);
    expect(august.grossProfit).toBe(2_500);

    // A narrower window excludes the earlier sale.
    expect(getSalesSummary(context.db, '2026-08-16', '2026-08-16').total).toBe(3_000);
  });
});

describe('fractional quantities end to end', () => {
  it('sells 2.5 kg of rice correctly', () => {
    const id = makeProduct('Rice', 1_400, 1_900);
    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'OPENING_STOCK',
        items: [{ productId: id, direction: 'IN', qty: parseQty('25.5'), totalCost: m(35_700) }],
      },
      ACTOR,
    );

    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: parseQty('2.5') }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(4_750) }],
      },
      ACTOR,
    );

    expect(sale.total).toBe(4_750); // 2.5 x 19.00
    expect(sale.cogs).toBe(3_500); // 2.5 x 14.00
    expect(getProduct(context.db, id).qtyOnHand).toBe(23_000); // 23 kg left
    assertBooksHealthy('fractional sale');
  });
});
