import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { businessSettings, productBatches, products } from '@/db/schema';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { verifyBatchCoverage, verifyProductBatches } from '@/services/inventory.service';
import { openOpeningBatches, countUncoveredProducts } from '@/db/seed/opening-batches';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * Phase 1: every unit of stock belongs to a batch, and that is provable.
 *
 * Nothing reads batches yet — no picking, no expiry, no warnings. What has to
 * hold from this commit onward is narrower and more important: the shelf and
 * the batches agree, and the batch quantities are backed by something rather
 * than asserted.
 *
 * The coverage check is the one that matters. If stock exists that no batch
 * owns, first-expiry-first-out will later be choosing from an incomplete set —
 * a sale refused while the shelf is full, or a warning missing for goods about
 * to turn. Neither announces itself, so it is checked here and in `preflight`.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-25';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

function makeProduct(name: string): number {
  return createProduct(
    context.db,
    { name, costPrice: m(500), sellingPrice: m(800), unit: 'pcs' },
    ACTOR,
  );
}

/** Stock brought in the ordinary way, through the gateway, which allocates. */
function addStock(productId: number, qtyUnits: number, cost: number) {
  createStockAdjustment(
    context.db,
    {
      businessDate: TODAY,
      reason: 'OPENING_STOCK',
      items: [{ productId, direction: 'IN', qty: u(qtyUnits), totalCost: m(cost) }],
    },
    ACTOR,
  );
}

/**
 * Stock sitting on the shelf that no batch owns.
 *
 * What a database migrated from before batches existed looks like, and — now
 * that the gateway allocates every movement — the only way left to produce it.
 * Written straight to the product cache, exactly as migration 0019 finds it.
 */
function addStockBeforeBatches(productId: number, qtyUnits: number) {
  context.db
    .update(products)
    .set({ qtyOnHandMilli: qtyUnits * 1_000 })
    .where(eq(products.id, productId))
    .run();
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
});

afterEach(() => context.cleanup());

describe('a freshly migrated database', () => {
  it('has the batch tables and the two settings', () => {
    const settings = context.db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get()!;

    expect(settings.expiryWarningDays).toBe(30);
    expect(settings.expiryBlocksSales).toBe(true);
    expect(context.db.select().from(productBatches).all()).toEqual([]);
  });

  it('reports clean coverage when there is no stock at all', () => {
    expect(verifyBatchCoverage(context.db).every((row) => row.ok)).toBe(true);
  });

  it('round-trips both settings', () => {
    context.db
      .update(businessSettings)
      .set({ expiryWarningDays: 7, expiryBlocksSales: false })
      .where(eq(businessSettings.id, 1))
      .run();

    const settings = context.db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get()!;
    expect(settings.expiryWarningDays).toBe(7);
    expect(settings.expiryBlocksSales).toBe(false);
  });
});

describe('opening batches', () => {
  /**
   * Migration 0019 does this for stock that already existed. The same job is
   * needed for stock created afterwards by a path that does not yet allocate
   * batches — the demo seed today, and anything else until Phase 2.
   */
  it('gives every stocked product exactly one', () => {
    const milo = makeProduct('Milo 400g');
    const rice = makeProduct('Rice 5kg');
    addStockBeforeBatches(milo, 10);
    addStockBeforeBatches(rice, 4);

    expect(countUncoveredProducts(context.db)).toBe(2);
    expect(openOpeningBatches(context.db, TODAY)).toBe(2);

    const batches = context.db.select().from(productBatches).all();
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.qtyMilli).sort((a, b) => a - b)).toEqual([4_000, 10_000]);
    // Undated: nothing here carries a date anybody entered.
    expect(batches.every((b) => b.expiryDate === null)).toBe(true);
    expect(batches.every((b) => b.sourceType === 'OPENING')).toBe(true);
  });

  it('records what each batch began with, rather than leaving it to be derived', () => {
    const milo = makeProduct('Milo 400g');
    addStockBeforeBatches(milo, 10);
    openOpeningBatches(context.db, TODAY);

    const batch = context.db.select().from(productBatches).all()[0]!;
    expect(batch.openingQtyMilli).toBe(10_000);
    expect(batch.qtyMilli).toBe(batch.openingQtyMilli);
  });

  it('skips a product that has no stock', () => {
    makeProduct('Never stocked');
    expect(openOpeningBatches(context.db, TODAY)).toBe(0);
    expect(context.db.select().from(productBatches).all()).toEqual([]);
  });

  it('carries a negative position into a negative opening batch', () => {
    // A shop with negative stock allowed can be below zero at migration. The
    // coverage invariant has to hold for it too, so the batch goes negative
    // rather than the product being skipped.
    const milo = makeProduct('Milo 400g');
    context.db
      .update(products)
      .set({ qtyOnHandMilli: -3_000 })
      .where(eq(products.id, milo))
      .run();

    expect(openOpeningBatches(context.db, TODAY)).toBe(1);
    expect(context.db.select().from(productBatches).all()[0]!.qtyMilli).toBe(-3_000);
    expect(verifyBatchCoverage(context.db).every((row) => row.ok)).toBe(true);
  });

  it('is idempotent — running it twice does not double the shelf', () => {
    const milo = makeProduct('Milo 400g');
    addStockBeforeBatches(milo, 10);

    expect(openOpeningBatches(context.db, TODAY)).toBe(1);
    expect(openOpeningBatches(context.db, TODAY)).toBe(0);

    expect(context.db.select().from(productBatches).all()).toHaveLength(1);
    expect(verifyBatchCoverage(context.db).every((row) => row.ok)).toBe(true);
  });
});

describe('coverage: does every unit belong to a batch?', () => {
  it('is clean once opening batches exist', () => {
    const milo = makeProduct('Milo 400g');
    addStock(milo, 10, 5_000);
    openOpeningBatches(context.db, TODAY);

    const coverage = verifyBatchCoverage(context.db);
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.ok).toBe(true);
    expect(coverage[0]!.productQty).toBe(10_000);
    expect(coverage[0]!.batchedQty).toBe(10_000);
    expect(coverage[0]!.batchCount).toBe(1);
  });

  it('reports stock that no batch owns', () => {
    // The state this check exists for: a shelf holding goods that picking would
    // never see.
    const milo = makeProduct('Milo 400g');
    addStockBeforeBatches(milo, 10);

    const coverage = verifyBatchCoverage(context.db);
    expect(coverage[0]!.ok).toBe(false);
    expect(coverage[0]!.drift).toBe(10_000);
    expect(coverage[0]!.batchCount).toBe(0);
  });

  it('reports a batch quantity tampered with by hand', () => {
    const milo = makeProduct('Milo 400g');
    addStock(milo, 10, 5_000);
    openOpeningBatches(context.db, TODAY);

    context.connection.prepare('UPDATE product_batches SET qty_milli = 4000').run();

    const coverage = verifyBatchCoverage(context.db);
    expect(coverage[0]!.ok).toBe(false);
    expect(coverage[0]!.drift).toBe(6_000);
  });

  it('ignores products that are not stock-tracked', () => {
    const service = createProduct(
      context.db,
      { name: 'Delivery', costPrice: m(0), sellingPrice: m(1_000), unit: 'job', trackInventory: false },
      ACTOR,
    );
    expect(verifyBatchCoverage(context.db).some((row) => row.productId === service)).toBe(false);
  });
});

describe('per batch: is the cached quantity backed by anything?', () => {
  /**
   * `verifyProductBatches` proves `qtyMilli === openingQtyMilli + in - out`.
   *
   * An earlier draft derived the opening figure by winding the cache back
   * through its own allocations, which could only ever agree with itself. These
   * check the real thing: corrupt one side and the drift shows.
   */
  it('is clean for an untouched opening batch', () => {
    const milo = makeProduct('Milo 400g');
    addStock(milo, 10, 5_000);
    openOpeningBatches(context.db, TODAY);

    const checks = verifyProductBatches(context.db, milo);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.ok).toBe(true);
    expect(checks[0]!.allocatedQty).toBe(10_000);
  });

  it('catches a cached quantity that no longer matches its opening figure', () => {
    const milo = makeProduct('Milo 400g');
    addStock(milo, 10, 5_000);
    openOpeningBatches(context.db, TODAY);

    context.connection.prepare('UPDATE product_batches SET qty_milli = 7000').run();

    const check = verifyProductBatches(context.db, milo)[0]!;
    expect(check.ok).toBe(false);
    expect(check.drift).toBe(-3_000);
    expect(check.cachedQty).toBe(7_000);
    expect(check.allocatedQty).toBe(10_000);
  });

  it('catches an opening figure edited to cover a wrong quantity', () => {
    // The failure the earlier tautological version could not see: change what
    // the batch claims it started with, and the check must notice.
    const milo = makeProduct('Milo 400g');
    addStockBeforeBatches(milo, 10);
    openOpeningBatches(context.db, TODAY);

    context.connection.prepare('UPDATE product_batches SET opening_qty_milli = 2000').run();

    const check = verifyProductBatches(context.db, milo)[0]!;
    expect(check.ok).toBe(false);
    expect(check.drift).toBe(8_000);
  });
});
