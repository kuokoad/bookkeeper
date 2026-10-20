import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts, products, purchaseItems, saleItems, stockLedger } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createProduct, getProduct, updateProduct, type ProductInput } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale, getSale, voidSale } from '@/services/sale.service';
import { createPurchase } from '@/services/purchase.service';
import { createSupplier } from '@/services/supplier.service';
import { convertQuotation, createQuotation } from '@/services/quotation.service';
import { createCustomerReturn } from '@/services/returns.service';
import { createUnit, deleteUnit, listUnits, updateUnit } from '@/services/units.service';
import { getInventoryValue, verifyProductStock } from '@/services/inventory.service';
import { getAccountBalanceByCode, getTrialBalance } from '@/services/reporting/balances.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import { ConflictError, ForbiddenError, ValidationError } from '@/domain/errors';

/**
 * Units of measure, as a shop owner checks them: buy by the carton, sell by
 * the carton or the tin, and the shelf, the money and the books all agree in
 * tins.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-16';
let CASH = 0;

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

/** Evaporated milk: counted in tins, also sold by the carton of 24 at 110.00. */
const MILK: ProductInput = {
  name: 'Evaporated Milk',
  unit: 'tin',
  altUnit: 'Carton',
  altFactor: u(24),
  costPrice: m(400),
  sellingPrice: m(500),
  altSellingPrice: m(11_000),
};

function makeMilk(overrides: Partial<ProductInput> = {}): number {
  createUnitOnce('tin', 0);
  createUnitOnce('Carton', 0);
  return createProduct(context.db, { ...MILK, ...overrides }, ACTOR);
}

function createUnitOnce(symbol: string, decimalPlaces: number) {
  if (!listUnits(context.db).some((unit) => unit.symbol === symbol)) {
    createUnit(context.db, { symbol, name: symbol, decimalPlaces }, ACTOR);
  }
}

/** 100 tins at 4.00 each. */
function stockUp(productId: number) {
  createStockAdjustment(
    context.db,
    {
      businessDate: TODAY,
      reason: 'OPENING_STOCK',
      items: [{ productId, direction: 'IN', qty: u(100), totalCost: m(40_000) }],
    },
    ACTOR,
  );
}

function qtyOnHand(productId: number): number {
  return context.db.select().from(products).where(eq(products.id, productId)).get()!.qtyOnHandMilli;
}

function assertBooksHealthy(label: string) {
  expect(getTrialBalance(context.db).balanced, `${label}: trial balance`).toBe(true);
  expect(getInventoryValue(context.db), `${label}: inventory vs GL`).toBe(
    getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY),
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
  CASH = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;
});

afterEach(() => {
  context.cleanup();
});

describe('selling by the carton', () => {
  it('takes 48 tins off the shelf for 2 cartons, at the carton price', () => {
    const id = makeMilk();
    stockUp(id);

    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(2), alt: true }],
        tenders: [{ paymentAccountId: CASH, amount: m(22_000) }],
      },
      ACTOR,
    );

    expect(sale.total).toBe(22_000); // 2 x 110.00, not 2 x 5.00
    expect(sale.cogs).toBe(19_200); // 48 tins at 4.00
    expect(qtyOnHand(id)).toBe(52_000);

    const out = context.db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.sourceId, sale.saleId))
      .all()
      .filter((row) => row.sourceType === 'SALE');
    expect(out[0]!.qtyOutMilli).toBe(48_000);

    // The receipt shows what the customer asked for.
    const line = getSale(context.db, sale.saleId).items[0]!;
    expect(line.entryUnit).toBe('Carton');
    expect(line.entryQtyMilli).toBe(2_000);
    expect(line.qtyMilli).toBe(48_000);
    expect(line.unit).toBe('tin');

    assertBooksHealthy('carton sale');
  });

  it('defaults a carton to 24 tins at the tin price when no carton price is set', () => {
    const id = makeMilk({ altSellingPrice: null });
    stockUp(id);

    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(1), alt: true }],
        tenders: [{ paymentAccountId: CASH, amount: m(12_000) }],
      },
      ACTOR,
    );
    expect(sale.total).toBe(12_000);
  });

  it('refuses a cashier pricing a carton at the tin price', () => {
    const id = makeMilk();
    stockUp(id);

    expect(() =>
      createSale(
        context.db,
        {
          businessDate: TODAY,
          items: [{ productId: id, qty: u(1), alt: true, unitPrice: m(500) }],
          tenders: [{ paymentAccountId: CASH, amount: m(500) }],
        },
        ACTOR,
      ),
    ).toThrow(ForbiddenError);
  });

  it('refuses half a tin, because tins are counted whole', () => {
    const id = makeMilk();
    stockUp(id);

    expect(() =>
      createSale(
        context.db,
        {
          businessDate: TODAY,
          items: [{ productId: id, qty: u(1.5) }],
          tenders: [{ paymentAccountId: CASH, amount: m(750) }],
        },
        ACTOR,
      ),
    ).toThrow(/whole numbers/);
    expect(qtyOnHand(id)).toBe(100_000);
  });

  it('puts the cartons back on the shelf when the sale is voided', () => {
    const id = makeMilk();
    stockUp(id);
    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(2), alt: true }],
        tenders: [{ paymentAccountId: CASH, amount: m(22_000) }],
      },
      ACTOR,
    );

    voidSale(context.db, sale.saleId, 'Rang up twice', ACTOR);

    expect(qtyOnHand(id)).toBe(100_000);
    const mirror = context.db
      .select()
      .from(saleItems)
      .all()
      .find((item) => item.saleId !== sale.saleId)!;
    expect(mirror.entryQtyMilli).toBe(-2_000);
    expect(mirror.qtyMilli).toBe(-48_000);
    assertBooksHealthy('carton void');
  });
});

describe('buying by the carton', () => {
  it('adds 72 tins and 600.00 of stock for 3 cartons at 200.00', () => {
    const id = makeMilk();
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);

    createPurchase(
      context.db,
      {
        supplierId,
        businessDate: TODAY,
        items: [{ productId: id, qty: u(3), alt: true, unitCost: m(20_000) }],
        tenders: [{ paymentAccountId: CASH, amount: m(60_000) }],
      },
      ACTOR,
    );

    const product = getProduct(context.db, id);
    expect(product.qtyOnHand).toBe(72_000);
    expect(product.stockValue).toBe(60_000);

    const line = context.db.select().from(purchaseItems).get()!;
    expect(line.qtyMilli).toBe(72_000);
    expect(line.entryQtyMilli).toBe(3_000);
    expect(line.unitCostMinor).toBe(20_000);
    assertBooksHealthy('carton purchase');
  });
});

describe('quoting and adjusting by the carton', () => {
  it('turns a quote for 2 cartons into a sale of 2 cartons', () => {
    const id = makeMilk();
    stockUp(id);

    const quote = createQuotation(
      context.db,
      {
        businessDate: TODAY,
        validUntil: '2026-09-15',
        customerName: 'Ama',
        lines: [{ productId: id, qty: u(2), alt: true }],
      },
      ACTOR,
    );
    expect(quote.total).toBe(22_000);

    const converted = convertQuotation(
      context.db,
      quote.quotationId,
      { businessDate: TODAY, tenders: [{ paymentAccountId: CASH, amount: m(22_000) }] },
      ACTOR,
    );

    const line = getSale(context.db, converted.saleId).items[0]!;
    expect(line.entryUnit).toBe('Carton');
    expect(line.entryQtyMilli).toBe(2_000);
    expect(qtyOnHand(id)).toBe(52_000);
  });

  it('writes off a damaged carton as 24 tins', () => {
    const id = makeMilk();
    stockUp(id);

    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'DAMAGED',
        items: [{ productId: id, direction: 'OUT', qty: u(1), alt: true }],
      },
      ACTOR,
    );

    expect(qtyOnHand(id)).toBe(76_000);
    assertBooksHealthy('carton write-off');
  });
});

describe('returning part of a carton sale', () => {
  it('takes back 5 tins and refunds 5/48 of the line', () => {
    const id = makeMilk();
    stockUp(id);
    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: id, qty: u(2), alt: true }],
        tenders: [{ paymentAccountId: CASH, amount: m(22_000) }],
      },
      ACTOR,
    );
    const item = getSale(context.db, sale.saleId).items[0]!;

    const result = createCustomerReturn(
      context.db,
      sale.saleId,
      {
        businessDate: TODAY,
        items: [{ itemId: item.id, qty: u(5) }],
        refunds: [{ paymentAccountId: CASH, amount: m(2_292) }],
      },
      ACTOR,
    );

    // 22,000 x 5 / 48 = 2,291.67, rounded to the pesewa.
    expect(result.refunded).toBe(2_292);
    expect(qtyOnHand(id)).toBe(57_000);
    assertBooksHealthy('partial return');
  });
});

describe('the units of a product that has traded', () => {
  it('cannot change once stock has moved', () => {
    const id = makeMilk();
    stockUp(id);

    expect(() => updateProduct(context.db, id, { ...MILK, altFactor: u(12) }, ACTOR)).toThrow(
      ValidationError,
    );
    expect(() => updateProduct(context.db, id, { ...MILK, altUnit: null }, ACTOR)).toThrow(
      /stock movements/,
    );
    // Prices are not units, and still change freely.
    updateProduct(context.db, id, { ...MILK, altSellingPrice: m(10_500) }, ACTOR);
    expect(getProduct(context.db, id).altSellingPrice).toBe(10_500);
  });

  it('can change while nothing has moved', () => {
    const id = makeMilk();
    updateProduct(context.db, id, { ...MILK, altFactor: u(12) }, ACTOR);
    expect(getProduct(context.db, id).altFactor).toBe(12_000);
  });
});

describe('the Units list', () => {
  it('carries a rename to every product using the unit', () => {
    const id = makeMilk();
    updateUnit(context.db, 'Carton', { symbol: 'Ctn', name: 'Carton', decimalPlaces: 0 }, ACTOR);
    expect(getProduct(context.db, id).altUnit).toBe('Ctn');
  });

  it('will not delete a unit a product uses', () => {
    makeMilk();
    expect(() => deleteUnit(context.db, 'Carton', ACTOR)).toThrow(ConflictError);
    createUnit(context.db, { symbol: 'Dozen', name: 'Dozen', decimalPlaces: 0 }, ACTOR);
    deleteUnit(context.db, 'Dozen', ACTOR);
    expect(listUnits(context.db).some((unit) => unit.symbol === 'Dozen')).toBe(false);
  });

  it('treats pcs and PCS as the same unit', () => {
    expect(() =>
      createUnit(context.db, { symbol: 'PCS', name: 'Pieces', decimalPlaces: 0 }, ACTOR),
    ).toThrow(ConflictError);
  });
});
