import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { businessSettings, paymentAccounts, sales } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale } from '@/services/sale.service';
import { getAccountBalanceByCode, getTrialBalance } from '@/services/reporting/balances.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * Selling at prices that already include tax.
 *
 * Ghanaian shelf prices are usually the price the customer actually pays, tax
 * and all. The shop switches "prices include tax" on in settings and carries on
 * typing the same numbers it always did; the tax is worked out of the total
 * rather than added on top of it.
 *
 * The books still have to come out right. The customer hands over the shelf
 * price; part of that is revenue and part is money being held for the tax
 * authority, and the two must add back to exactly what was taken.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-16';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH_ACCOUNT = 0;

/** 12.5% — Ghana's VAT standard rate at the time of writing. */
const RATE_BP = 1_250;

function setTax(inclusive: boolean) {
  context.db
    .update(businessSettings)
    .set({ taxEnabled: true, taxRateBp: RATE_BP, taxInclusive: inclusive, taxLabel: 'VAT' })
    .where(eq(businessSettings.id, 1))
    .run();
}

function makeProduct(name: string, cost: number, price: number): number {
  return createProduct(
    context.db,
    { name, costPrice: m(cost), sellingPrice: m(price), unit: 'pcs' },
    ACTOR,
  );
}

function addStock(productId: number, qtyUnits: number, totalCostMinor: number) {
  createStockAdjustment(
    context.db,
    {
      businessDate: TODAY,
      reason: 'OPENING_STOCK',
      items: [{ productId, direction: 'IN', qty: u(qtyUnits), totalCost: m(totalCostMinor) }],
    },
    ACTOR,
  );
}

/** A product priced at GHS 112.50 on the shelf, with stock to sell. */
function stockedProduct(): number {
  const id = makeProduct('Rice 5kg', 6_000, 11_250);
  addStock(id, 20, 120_000);
  return id;
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');

  CASH_ACCOUNT = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;
});

afterEach(() => context.cleanup());

describe('a sale at tax-inclusive prices', () => {
  it('can be recorded at all', () => {
    setTax(true);
    const product = stockedProduct();

    // GHS 112.50 on the shelf, of which GHS 12.50 is VAT.
    const created = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: product, qty: u(1), unitPrice: m(11_250) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(11_250) }],
      },
      ACTOR,
    );

    const row = context.db.select().from(sales).where(eq(sales.id, created.saleId)).get()!;
    // The customer pays the shelf price. Tax came out of it, not on top of it.
    expect(row.totalMinor).toBe(11_250);
    expect(row.taxMinor).toBe(1_250);
  });

  it('keeps the stored figures adding up: subtotal − discount + tax = total', () => {
    setTax(true);
    const product = stockedProduct();

    const created = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: product, qty: u(2), unitPrice: m(11_250) }],
        invoiceDiscount: m(2_250),
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(20_250) }],
      },
      ACTOR,
    );

    const row = context.db.select().from(sales).where(eq(sales.id, created.saleId)).get()!;
    expect(row.subtotalMinor - row.discountMinor + row.taxMinor).toBe(row.totalMinor);
    // GHS 225.00 less a GHS 22.50 discount = GHS 202.50 taken.
    expect(row.totalMinor).toBe(20_250);
  });

  it('splits what was taken into revenue and tax owed, and nothing else', () => {
    setTax(true);
    const product = stockedProduct();

    createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: product, qty: u(1), unitPrice: m(11_250) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(11_250) }],
      },
      ACTOR,
    );

    // GHS 112.50 taken = GHS 100.00 earned + GHS 12.50 held for the taxman.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.TAX_PAYABLE)).toBe(1_250);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.SALES_REVENUE)).toBe(10_000);
  });

  it('leaves the books in balance, discounts and awkward numbers included', () => {
    setTax(true);
    const product = stockedProduct();

    // 3 x 112.50 = 337.50, less 10.00 off the line, less 13.37 off the sale.
    createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: product, qty: u(3), unitPrice: m(11_250), discount: m(1_000) }],
        invoiceDiscount: m(1_337),
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(31_413) }],
      },
      ACTOR,
    );

    expect(getTrialBalance(context.db).balanced).toBe(true);
  });

  it('charges tax on the discounted price, not the shelf price', () => {
    setTax(true);
    const product = stockedProduct();

    const created = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: product, qty: u(1), unitPrice: m(11_250) }],
        // GHS 22.50 off, so GHS 90.00 taken, containing GHS 10.00 of VAT.
        invoiceDiscount: m(2_250),
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(9_000) }],
      },
      ACTOR,
    );

    const row = context.db.select().from(sales).where(eq(sales.id, created.saleId)).get()!;
    expect(row.totalMinor).toBe(9_000);
    expect(row.taxMinor).toBe(1_000);
  });
});

describe('a sale at tax-exclusive prices, unchanged', () => {
  it('still adds tax on top and still balances', () => {
    setTax(false);
    const product = makeProduct('Rice 5kg', 6_000, 10_000);
    addStock(product, 10, 60_000);

    const created = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: product, qty: u(1), unitPrice: m(10_000) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(11_250) }],
      },
      ACTOR,
    );

    const row = context.db.select().from(sales).where(eq(sales.id, created.saleId)).get()!;
    expect(row.subtotalMinor).toBe(10_000);
    expect(row.taxMinor).toBe(1_250);
    expect(row.totalMinor).toBe(11_250);

    expect(getTrialBalance(context.db).balanced).toBe(true);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.SALES_REVENUE)).toBe(10_000);
  });
});
