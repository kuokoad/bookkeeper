import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import {
  businessSettings,
  categories,
  journalEntries,
  journalLines,
  products,
  stockAdjustments,
  stockLedger,
} from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createProduct, getProduct, listProducts, createCategory } from '@/services/catalog.service';
import {
  createStockAdjustment,
  voidStockAdjustment,
} from '@/services/stock-adjustment.service';
import { verifyProductStock, getInventoryValue } from '@/services/inventory.service';
import { getAccountBalanceByCode, getTrialBalance } from '@/services/reporting/balances.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import { InsufficientStockError, ValidationError } from '@/domain/errors';

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-16';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

function makeProduct(name: string, costPrice = 500, sellingPrice = 800): number {
  return createProduct(
    context.db,
    { name, costPrice: m(costPrice), sellingPrice: m(sellingPrice), unit: 'pcs' },
    ACTOR,
  );
}

/** Add opening stock via a real adjustment — the only legitimate route. */
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

beforeEach(() => {
  context = createTestDatabase();
  // A user row is needed for the created_by foreign keys.
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
});

afterEach(() => {
  context.cleanup();
});

describe('products', () => {
  it('always starts a new product with zero stock', () => {
    const id = makeProduct('Coca-Cola 350ml');
    const product = getProduct(context.db, id);
    expect(product.qtyOnHand).toBe(0);
    expect(product.stockValue).toBe(0);
  });

  it('rejects a duplicate SKU and barcode', () => {
    createProduct(
      context.db,
      { name: 'Milo 400g', sku: 'MILO400', barcode: '6001234567890', costPrice: m(0), sellingPrice: m(0) },
      ACTOR,
    );

    expect(() =>
      createProduct(
        context.db,
        { name: 'Other', sku: 'milo400', costPrice: m(0), sellingPrice: m(0) },
        ACTOR,
      ),
    ).toThrow(/already used/i);

    expect(() =>
      createProduct(
        context.db,
        { name: 'Other', barcode: '6001234567890', costPrice: m(0), sellingPrice: m(0) },
        ACTOR,
      ),
    ).toThrow(/already used/i);
  });

  it('allows many products with no SKU', () => {
    makeProduct('Bread');
    makeProduct('Bottled Water');
    expect(listProducts(context.db)).toHaveLength(2);
  });

  it('rejects negative prices', () => {
    expect(() =>
      createProduct(context.db, { name: 'Bad', costPrice: m(-1), sellingPrice: m(0) }, ACTOR),
    ).toThrow(ValidationError);
  });

  it('links to a category and reports the name', () => {
    const categoryId = createCategory(context.db, { name: 'Drinks' }, ACTOR);
    const id = createProduct(
      context.db,
      { name: 'Fanta', categoryId, costPrice: m(300), sellingPrice: m(500) },
      ACTOR,
    );
    expect(getProduct(context.db, id).categoryName).toBe('Drinks');
  });

  it('refuses a duplicate category name regardless of case', () => {
    createCategory(context.db, { name: 'Drinks' }, ACTOR);
    expect(() => createCategory(context.db, { name: 'drinks' }, ACTOR)).toThrow(/already exists/i);
  });
});

describe('stock adjustments — the accounting effect', () => {
  it('opening stock increases inventory and posts a balanced entry', () => {
    const id = makeProduct('Milo 400g');
    const result = addStock(id, 10, 5_000); // 10 @ GHS 5.00 = GHS 50.00

    const product = getProduct(context.db, id);
    expect(product.qtyOnHand).toBe(10_000);
    expect(product.stockValue).toBe(5_000);
    expect(product.averageCost).toBe(500);

    // The general ledger agrees with the stock.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY)).toBe(5_000);
    // Opening stock is capital introduced, not an expense.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.OPENING_BALANCE_EQUITY)).toBe(5_000);

    const trial = getTrialBalance(context.db);
    expect(trial.balanced).toBe(true);
    expect(result.journalEntryId).toBeGreaterThan(0);
  });

  it('writes one ledger row carrying the running balance', () => {
    const id = makeProduct('Milo 400g');
    addStock(id, 10, 5_000);

    const rows = context.db.select().from(stockLedger).where(eq(stockLedger.productId, id)).all();
    expect(rows).toHaveLength(1);
    // Opening stock is tagged distinctly, never as a generic adjustment, so
    // reports can separate it from ordinary trading.
    expect(rows[0]?.movementType).toBe('OPENING_STOCK');
    expect(rows[0]?.qtyInMilli).toBe(10_000);
    expect(rows[0]?.qtyOutMilli).toBe(0);
    expect(rows[0]?.totalCostMinor).toBe(5_000);
    expect(rows[0]?.balanceQtyMilli).toBe(10_000);
    expect(rows[0]?.balanceValueMinor).toBe(5_000);
    expect(rows[0]?.sourceRef).toMatch(/^ADJ-/);
  });

  it('re-averages when stock is added at a different price', () => {
    const id = makeProduct('Milo 400g');
    addStock(id, 10, 5_000); // 5.00 each
    addStock(id, 10, 7_000); // 7.00 each -> average 6.00

    const product = getProduct(context.db, id);
    expect(product.qtyOnHand).toBe(20_000);
    expect(product.stockValue).toBe(12_000);
    expect(product.averageCost).toBe(600);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY)).toBe(12_000);
  });

  it('writing off damaged stock moves value to shrinkage at the average cost', () => {
    const id = makeProduct('Milo 400g');
    addStock(id, 10, 5_000);
    addStock(id, 10, 7_000); // average 6.00

    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'DAMAGED',
        note: 'Crate fell',
        items: [{ productId: id, direction: 'OUT', qty: u(3) }],
      },
      ACTOR,
    );

    const product = getProduct(context.db, id);
    expect(product.qtyOnHand).toBe(17_000);
    // 3 x 6.00 = 18.00 removed from 120.00
    expect(product.stockValue).toBe(10_200);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY)).toBe(10_200);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY_SHRINKAGE)).toBe(1_800);
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });

  it('tags a later found/adjustment movement separately from opening stock', () => {
    const id = makeProduct('Milo 400g');
    addStock(id, 10, 5_000); // OPENING_STOCK

    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'FOUND',
        items: [{ productId: id, direction: 'IN', qty: u(2), totalCost: m(1_000) }],
      },
      ACTOR,
    );

    const rows = context.db.select().from(stockLedger).where(eq(stockLedger.productId, id)).all();
    expect(rows.map((row) => row.movementType)).toEqual(['OPENING_STOCK', 'ADJUSTMENT_IN']);
  });

  it('posts internal use to an expense account, not shrinkage', () => {
    const id = makeProduct('Bottled Water');
    addStock(id, 10, 2_000);

    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'INTERNAL_USE',
        items: [{ productId: id, direction: 'OUT', qty: u(2) }],
      },
      ACTOR,
    );

    expect(getAccountBalanceByCode(context.db, '6900')).toBe(400);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY_SHRINKAGE)).toBe(0);
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });

  it('handles several products in one document with one journal entry', () => {
    const a = makeProduct('Bread');
    const b = makeProduct('Biscuits');

    const result = createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'OPENING_STOCK',
        items: [
          { productId: a, direction: 'IN', qty: u(20), totalCost: m(4_000) },
          { productId: b, direction: 'IN', qty: u(50), totalCost: m(7_500) },
        ],
      },
      ACTOR,
    );

    expect(getProduct(context.db, a).stockValue).toBe(4_000);
    expect(getProduct(context.db, b).stockValue).toBe(7_500);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY)).toBe(11_500);

    // One document, one balanced entry.
    const lines = context.db
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, result.journalEntryId))
      .all();
    expect(lines).toHaveLength(2);
    expect(lines.reduce((t, l) => t + l.debitMinor, 0)).toBe(
      lines.reduce((t, l) => t + l.creditMinor, 0),
    );
  });
});

describe('stock availability rules', () => {
  it('refuses to remove more stock than is on hand', () => {
    const id = makeProduct('Milo 400g');
    addStock(id, 5, 2_500);

    expect(() =>
      createStockAdjustment(
        context.db,
        {
          businessDate: TODAY,
          reason: 'DAMAGED',
          items: [{ productId: id, direction: 'OUT', qty: u(6) }],
        },
        ACTOR,
      ),
    ).toThrow(InsufficientStockError);
  });

  it('allows it once the shop enables negative stock', () => {
    const id = makeProduct('Milo 400g', 500);
    addStock(id, 5, 2_500);

    context.db
      .update(businessSettings)
      .set({ allowNegativeStock: true })
      .where(eq(businessSettings.id, 1))
      .run();

    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'LOST',
        items: [{ productId: id, direction: 'OUT', qty: u(6) }],
      },
      ACTOR,
    );

    expect(getProduct(context.db, id).qtyOnHand).toBe(-1_000);
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });

  it('rejects a document with no items', () => {
    expect(() =>
      createStockAdjustment(
        context.db,
        { businessDate: TODAY, reason: 'DAMAGED', items: [] },
        ACTOR,
      ),
    ).toThrow(ValidationError);
  });

  it('rejects adding stock without a cost', () => {
    const id = makeProduct('Milo 400g');
    expect(() =>
      createStockAdjustment(
        context.db,
        {
          businessDate: TODAY,
          reason: 'FOUND',
          items: [{ productId: id, direction: 'IN', qty: u(1) }],
        },
        ACTOR,
      ),
    ).toThrow(ValidationError);
  });
});

describe('atomicity', () => {
  it('leaves nothing behind when one line of a multi-line document fails', () => {
    const good = makeProduct('Bread');
    const short = makeProduct('Biscuits');
    addStock(good, 10, 2_000);
    addStock(short, 1, 500);

    const inventoryBefore = getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY);
    const ledgerRowsBefore = context.db.select().from(stockLedger).all().length;
    const adjustmentsBefore = context.db.select().from(stockAdjustments).all().length;

    expect(() =>
      createStockAdjustment(
        context.db,
        {
          businessDate: TODAY,
          reason: 'DAMAGED',
          items: [
            { productId: good, direction: 'OUT', qty: u(2) }, // fine
            { productId: short, direction: 'OUT', qty: u(99) }, // fails
          ],
        },
        ACTOR,
      ),
    ).toThrow(InsufficientStockError);

    // The first line's stock movement must NOT have survived.
    expect(getProduct(context.db, good).qtyOnHand).toBe(10_000);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY)).toBe(inventoryBefore);
    expect(context.db.select().from(stockLedger).all().length).toBe(ledgerRowsBefore);
    expect(context.db.select().from(stockAdjustments).all().length).toBe(adjustmentsBefore);
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });
});

describe('voiding an adjustment', () => {
  it('reverses the stock and the accounting without deleting anything', () => {
    const id = makeProduct('Milo 400g');
    addStock(id, 10, 5_000);

    const damage = createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'DAMAGED',
        items: [{ productId: id, direction: 'OUT', qty: u(4) }],
      },
      ACTOR,
    );

    expect(getProduct(context.db, id).qtyOnHand).toBe(6_000);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY_SHRINKAGE)).toBe(2_000);

    voidStockAdjustment(context.db, damage.adjustmentId, 'Recorded by mistake', ACTOR);

    // Stock and accounts are back where they were.
    const product = getProduct(context.db, id);
    expect(product.qtyOnHand).toBe(10_000);
    expect(product.stockValue).toBe(5_000);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY_SHRINKAGE)).toBe(0);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY)).toBe(5_000);
    expect(getTrialBalance(context.db).balanced).toBe(true);

    // The original document still exists, marked voided and linked.
    const original = context.db
      .select()
      .from(stockAdjustments)
      .where(eq(stockAdjustments.id, damage.adjustmentId))
      .get();
    expect(original?.status).toBe('VOIDED');
    expect(original?.voidedByAdjustmentId).toBeGreaterThan(0);
    expect(original?.voidReason).toBe('Recorded by mistake');

    // Both the original and reversing entries survive — history is intact.
    const entries = context.db.select().from(journalEntries).all();
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries.some((entry) => entry.reversesEntryId !== null)).toBe(true);
  });

  it('refuses to void the same adjustment twice', () => {
    const id = makeProduct('Milo 400g');
    addStock(id, 10, 5_000);
    const damage = createStockAdjustment(
      context.db,
      { businessDate: TODAY, reason: 'DAMAGED', items: [{ productId: id, direction: 'OUT', qty: u(1) }] },
      ACTOR,
    );

    voidStockAdjustment(context.db, damage.adjustmentId, 'Mistake', ACTOR);
    expect(() =>
      voidStockAdjustment(context.db, damage.adjustmentId, 'Again', ACTOR),
    ).toThrow(/already been voided/i);
  });

  it('requires a reason', () => {
    const id = makeProduct('Milo 400g');
    addStock(id, 10, 5_000);
    const damage = createStockAdjustment(
      context.db,
      { businessDate: TODAY, reason: 'DAMAGED', items: [{ productId: id, direction: 'OUT', qty: u(1) }] },
      ACTOR,
    );
    expect(() => voidStockAdjustment(context.db, damage.adjustmentId, 'x', ACTOR)).toThrow(
      ValidationError,
    );
  });
});

describe('THE inventory invariant', () => {
  it('keeps the Inventory GL account equal to the stock ledger at every step', () => {
    const a = makeProduct('Bread');
    const b = makeProduct('Milo 400g');

    const steps: (() => void)[] = [
      () => addStock(a, 20, 4_000),
      () => addStock(b, 10, 5_000),
      () => addStock(b, 10, 7_000),
      () =>
        createStockAdjustment(
          context.db,
          { businessDate: TODAY, reason: 'DAMAGED', items: [{ productId: b, direction: 'OUT', qty: u(3) }] },
          ACTOR,
        ),
      () =>
        createStockAdjustment(
          context.db,
          { businessDate: TODAY, reason: 'EXPIRED', items: [{ productId: a, direction: 'OUT', qty: u(5) }] },
          ACTOR,
        ),
      () =>
        createStockAdjustment(
          context.db,
          {
            businessDate: TODAY,
            reason: 'FOUND',
            items: [{ productId: a, direction: 'IN', qty: u(2), totalCost: m(400) }],
          },
          ACTOR,
        ),
    ];

    steps.forEach((step, index) => {
      step();
      const label = `after step ${index + 1}`;

      // 1. Cached stock value == ledger replay, for every product.
      for (const productId of [a, b]) {
        const verification = verifyProductStock(context.db, productId);
        expect(verification.ok, `${label}: product ${productId} drift`).toBe(true);
      }

      // 2. Sum of all product stock values == the Inventory GL account.
      expect(getInventoryValue(context.db), `${label}: inventory vs GL`).toBe(
        getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY),
      );

      // 3. The books balance.
      expect(getTrialBalance(context.db).balanced, `${label}: trial balance`).toBe(true);
    });
  });

  it('detects drift if the cache is tampered with directly', () => {
    const id = makeProduct('Milo 400g');
    addStock(id, 10, 5_000);
    expect(verifyProductStock(context.db, id).ok).toBe(true);

    // Simulate corruption that bypassed the service layer.
    context.db.update(products).set({ qtyOnHandMilli: 99_000 }).where(eq(products.id, id)).run();

    const verification = verifyProductStock(context.db, id);
    expect(verification.ok).toBe(false);
    expect(verification.qtyDrift).toBe(89_000);
    expect(verification.ledgerQty).toBe(10_000);
  });
});

describe('categories', () => {
  it('archives rather than deletes, keeping product links intact', () => {
    const categoryId = createCategory(context.db, { name: 'Drinks' }, ACTOR);
    const productId = createProduct(
      context.db,
      { name: 'Fanta', categoryId, costPrice: m(300), sellingPrice: m(500) },
      ACTOR,
    );

    context.db.update(categories).set({ isActive: false }).where(eq(categories.id, categoryId)).run();

    // The product keeps its category even though the category is archived.
    expect(getProduct(context.db, productId).categoryName).toBe('Drinks');
  });
});
