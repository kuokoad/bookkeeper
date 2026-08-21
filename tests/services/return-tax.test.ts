import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { saleItems } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale } from '@/services/sale.service';
import { createCustomer, getCustomerBalance } from '@/services/customer.service';
import { createCustomerReturn } from '@/services/returns.service';
import { getAccountBalanceByCode, getTrialBalance } from '@/services/reporting/balances.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import { setSingleTax } from '../helpers/tax';

/**
 * Giving the tax back when the goods come back.
 *
 * A shop collects tax on behalf of the tax authority. When the goods return,
 * the sale did not happen, so neither did the tax on it — the shop no longer
 * owes it and the customer should not still be charged it.
 *
 * Left unreversed this is wrong twice over: the shop keeps a liability to the
 * taxman for a sale it did not make, and a credit customer is still shown as
 * owing the tax on goods sitting back on the shelf.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const DAY = '2026-08-10';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CUSTOMER = 0;

/** 12.5%, added on top of the shelf price. */
function taxedShop() {
  setSingleTax(context.db, { rateBp: 1_250 });
}

function stockedProduct(): number {
  const id = createProduct(
    context.db,
    { name: 'Rice 5kg', costPrice: m(6_000), sellingPrice: m(10_000), unit: 'bag' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: DAY,
      reason: 'OPENING_STOCK',
      items: [{ productId: id, direction: 'IN', qty: u(20), totalCost: m(120_000) }],
    },
    ACTOR,
  );
  return id;
}

const firstItemOf = (saleId: number): number =>
  context.db.select().from(saleItems).where(eq(saleItems.saleId, saleId)).all()[0]!.id;

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  CUSTOMER = createCustomer(context.db, { name: 'Mensah Provisions' }, ACTOR);
});

afterEach(() => context.cleanup());

describe('returning goods that carried tax', () => {
  it('gives the tax back to the taxman as well as the goods to the shelf', () => {
    taxedShop();
    const product = stockedProduct();

    // Two bags at GHS 100.00 plus GHS 25.00 VAT = GHS 225.00 on credit.
    const sale = createSale(
      context.db,
      {
        businessDate: DAY,
        customerId: CUSTOMER,
        items: [{ productId: product, qty: u(2) }],
        tenders: [],
      },
      ACTOR,
    );

    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.TAX_PAYABLE)).toBe(2_500);

    // Both bags come back.
    createCustomerReturn(
      context.db,
      sale.saleId,
      { businessDate: DAY, items: [{ itemId: firstItemOf(sale.saleId), qty: u(2) }], refunds: [] },
      ACTOR,
    );

    // The sale did not happen, so neither did the tax on it.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.TAX_PAYABLE)).toBe(0);
  });

  it('stops the customer owing tax on goods they gave back', () => {
    taxedShop();
    const product = stockedProduct();

    const sale = createSale(
      context.db,
      {
        businessDate: DAY,
        customerId: CUSTOMER,
        items: [{ productId: product, qty: u(2) }],
        tenders: [],
      },
      ACTOR,
    );

    expect(getCustomerBalance(context.db, CUSTOMER)).toBe(22_500);

    createCustomerReturn(
      context.db,
      sale.saleId,
      { businessDate: DAY, items: [{ itemId: firstItemOf(sale.saleId), qty: u(2) }], refunds: [] },
      ACTOR,
    );

    // Everything went back, so nothing is owed — not the goods, not the tax.
    expect(getCustomerBalance(context.db, CUSTOMER)).toBe(0);
  });

  it('gives back a proportional share on a partial return', () => {
    taxedShop();
    const product = stockedProduct();

    const sale = createSale(
      context.db,
      {
        businessDate: DAY,
        customerId: CUSTOMER,
        items: [{ productId: product, qty: u(4) }],
        tenders: [],
      },
      ACTOR,
    );

    // One of four back: a quarter of GHS 50.00 of VAT is GHS 12.50.
    createCustomerReturn(
      context.db,
      sale.saleId,
      { businessDate: DAY, items: [{ itemId: firstItemOf(sale.saleId), qty: u(1) }], refunds: [] },
      ACTOR,
    );

    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.TAX_PAYABLE)).toBe(3_750);
    // GHS 400 + GHS 50 VAT = GHS 450, less GHS 100 + GHS 12.50 returned.
    expect(getCustomerBalance(context.db, CUSTOMER)).toBe(33_750);
  });

  it('leaves the books balanced', () => {
    taxedShop();
    const product = stockedProduct();

    const sale = createSale(
      context.db,
      {
        businessDate: DAY,
        customerId: CUSTOMER,
        items: [{ productId: product, qty: u(3) }],
        tenders: [],
      },
      ACTOR,
    );

    createCustomerReturn(
      context.db,
      sale.saleId,
      { businessDate: DAY, items: [{ itemId: firstItemOf(sale.saleId), qty: u(2) }], refunds: [] },
      ACTOR,
    );

    expect(getTrialBalance(context.db).balanced).toBe(true);
  });
});

describe('returning goods from a shop with no tax', () => {
  it('behaves exactly as before', () => {
    const product = stockedProduct();

    const sale = createSale(
      context.db,
      {
        businessDate: DAY,
        customerId: CUSTOMER,
        items: [{ productId: product, qty: u(2) }],
        tenders: [],
      },
      ACTOR,
    );

    createCustomerReturn(
      context.db,
      sale.saleId,
      { businessDate: DAY, items: [{ itemId: firstItemOf(sale.saleId), qty: u(2) }], refunds: [] },
      ACTOR,
    );

    expect(getCustomerBalance(context.db, CUSTOMER)).toBe(0);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.TAX_PAYABLE)).toBe(0);
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });
});

describe('sending goods back to a supplier', () => {
  /**
   * The mirror of the customer side. Tax paid to a supplier is reclaimable, so
   * it was debited to the tax account when the goods arrived. Send the goods
   * back and there is nothing to reclaim — leaving it behind overstates what
   * the tax authority owes the shop, on an invoice the shop did not keep.
   */
  it('gives back the tax that was reclaimed on them', async () => {
    const { createSupplier } = await import('@/services/supplier.service');
    const { createPurchase } = await import('@/services/purchase.service');
    const { createSupplierReturn } = await import('@/services/returns.service');
    const { purchaseItems } = await import('@/db/schema');
    const { paymentAccounts } = await import('@/db/schema');

    taxedShop();
    const supplier = createSupplier(context.db, { name: 'Kofi Wholesale' }, ACTOR);
    const cash = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;
    const product = stockedProduct();

    // Ten bags at GHS 50.00 = GHS 500.00 plus GHS 62.50 VAT.
    const purchase = createPurchase(
      context.db,
      {
        businessDate: DAY,
        supplierId: supplier,
        items: [{ productId: product, qty: u(10), unitCost: m(5_000) }],
        tenders: [{ paymentAccountId: cash, amount: m(56_250) }],
      },
      ACTOR,
    );

    const taxAfterPurchase = getAccountBalanceByCode(context.db, ACCOUNT_CODES.TAX_PAYABLE);

    const item = context.db
      .select()
      .from(purchaseItems)
      .where(eq(purchaseItems.purchaseId, purchase.purchaseId))
      .all()[0]!;

    // All ten go back.
    createSupplierReturn(
      context.db,
      purchase.purchaseId,
      { businessDate: DAY, items: [{ itemId: item.id, qty: u(10) }], refunds: [] },
      ACTOR,
    );

    // The reclaim goes back with the goods, leaving the tax account where it
    // stood before the delivery.
    expect(
      getAccountBalanceByCode(context.db, ACCOUNT_CODES.TAX_PAYABLE) - taxAfterPurchase,
    ).toBe(6_250);
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });
});
