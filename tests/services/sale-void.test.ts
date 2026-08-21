import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts, sales } from '@/db/schema';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale, voidSale } from '@/services/sale.service';
import { getTrialBalance } from '@/services/reporting/balances.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import { setSingleTax } from '../helpers/tax';

/**
 * Voiding a sale that was not plain and simple.
 *
 * A void writes a mirror-image document rather than editing or deleting the
 * original, so the pair nets to zero and both halves stay on the record. That
 * mirror carries negative figures, which has to be reconcilable with a table
 * that otherwise insists money is positive — and it has to survive discounts
 * and tax, which is exactly when a shop most wants to undo a mistake.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-16';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH_ACCOUNT = 0;

function stockedProduct(price: number): number {
  const id = createProduct(
    context.db,
    { name: 'Rice 5kg', costPrice: m(6_000), sellingPrice: m(price), unit: 'pcs' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: TODAY,
      reason: 'OPENING_STOCK',
      items: [{ productId: id, direction: 'IN', qty: u(20), totalCost: m(120_000) }],
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
  CASH_ACCOUNT = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;
});

afterEach(() => context.cleanup());

describe('voiding', () => {
  it('works on a sale that was given a discount', () => {
    const product = stockedProduct(10_000);
    const created = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: product, qty: u(2) }],
        invoiceDiscount: m(2_000),
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(18_000) }],
      },
      ACTOR,
    );

    expect(() => voidSale(context.db, created.saleId, 'Rang it up twice', ACTOR)).not.toThrow();
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });

  it('works on a sale that carried tax', () => {
      setSingleTax(context.db, { rateBp: 1_250, inclusive: false });

    const product = stockedProduct(10_000);
    const created = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: product, qty: u(1) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(11_250) }],
      },
      ACTOR,
    );

    expect(() => voidSale(context.db, created.saleId, 'Wrong customer', ACTOR)).not.toThrow();
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });

  it('works on a tax-inclusive sale with a discount', () => {
      setSingleTax(context.db, { rateBp: 1_250, inclusive: true });

    const product = stockedProduct(11_250);
    const created = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: product, qty: u(2) }],
        invoiceDiscount: m(2_250),
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(20_250) }],
      },
      ACTOR,
    );

    voidSale(context.db, created.saleId, 'Customer changed their mind', ACTOR);

    const rows = context.db.select().from(sales).all();
    const mirror = rows.find((r) => r.voidsSaleId === created.saleId)!;
    // The pair nets to nothing: that is what "void" has to mean.
    const original = rows.find((r) => r.id === created.saleId)!;
    expect(mirror.totalMinor + original.totalMinor).toBe(0);
    expect(mirror.taxMinor + original.taxMinor).toBe(0);
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });
});
