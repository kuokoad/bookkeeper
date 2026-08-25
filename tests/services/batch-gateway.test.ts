import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import {
  businessSettings,
  paymentAccounts,
  productBatches,
  stockLedger,
  stockLedgerBatches,
} from '@/db/schema';
import { writeTransaction } from '@/db/transaction';
import { createProduct } from '@/services/catalog.service';
import { createPurchase, voidPurchase } from '@/services/purchase.service';
import { createSale } from '@/services/sale.service';
import { createSupplier } from '@/services/supplier.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import {
  recordStockMovement,
  verifyBatchCoverage,
  verifyProductBatches,
} from '@/services/inventory.service';
import type { Allocation } from '@/domain/inventory/batches';
import { ExpiredStockError } from '@/domain/errors';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * Phase 2: every movement writes down which batch it touched.
 *
 * Nothing on screen changes here. What changes is that the gateway — the one
 * function sales, purchases, returns, voids and adjustments all pass through —
 * now decides which physical units moved, and records it in the same
 * transaction as the ledger row itself.
 *
 * Two things have to hold from this commit onward, and neither announces itself
 * when it breaks:
 *
 *   1. No caller changed behaviour. A shop whose stock is all undated picks
 *      from one batch either way, so a purchase, a sale, a void and an
 *      adjustment must land exactly where they landed yesterday.
 *   2. Coverage holds. Sum of batch quantities === the shelf, after any
 *      sequence of movements. Break it and first-expiry-first-out is later
 *      choosing from an incomplete set: a sale refused while the shelf is full,
 *      or a warning missing for goods about to turn.
 *
 * The picking rules themselves are proved in
 * `tests/domain/batch-allocation.test.ts`. These prove the wiring: that the
 * rules are reached, inside a transaction, from every path the shop uses.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const DAY = '2026-08-10';
const LATER = '2026-08-12';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;
let SUPPLIER = 0;

function makeProduct(name = 'Rice 5kg'): number {
  return createProduct(
    context.db,
    { name, costPrice: m(1_000), sellingPrice: m(3_000), unit: 'bag' },
    ACTOR,
  );
}

function batchesOf(productId: number) {
  return context.db
    .select()
    .from(productBatches)
    .where(eq(productBatches.productId, productId))
    .orderBy(asc(productBatches.id))
    .all();
}

/** Coverage, per-batch backing, and the ledger split — all of it, everywhere. */
function expectBatchesIntact(label: string): void {
  for (const row of verifyBatchCoverage(context.db)) {
    expect(row.ok, `${label}: product ${row.productId} coverage`).toBe(true);
  }

  const touched = new Set(
    context.db
      .select({ id: productBatches.productId })
      .from(productBatches)
      .all()
      .map((row) => row.id),
  );
  for (const productId of touched) {
    for (const check of verifyProductBatches(context.db, productId)) {
      expect(check.ok, `${label}: batch ${check.batchId} backing`).toBe(true);
    }
  }

  /**
   * Every ledger row's split has to add back to the movement it belongs to.
   *
   * True in this file because every movement here ran through the gateway. It
   * is NOT true of a migrated shop: history that predates batches has no split
   * at all — 0019 backfills an opening batch instead of rewriting the past — so
   * this must never be promoted into `preflight`, where it would fail on every
   * real database on the first run.
   */
  const splits = new Map<number, number>();
  for (const row of context.db.select().from(stockLedgerBatches).all()) {
    splits.set(row.ledgerId, (splits.get(row.ledgerId) ?? 0) + row.qtyInMilli + row.qtyOutMilli);
  }
  for (const row of context.db.select().from(stockLedger).all()) {
    expect(splits.get(row.id) ?? 0, `${label}: ledger ${row.id} split`).toBe(
      row.qtyInMilli + row.qtyOutMilli,
    );
  }
}

/** Stock in through the gateway directly, which is the only way to give it a directive today. */
function moveIn(
  productId: number,
  qtyUnits: number,
  cost: number,
  batch?: { expiryDate?: string | null },
): Allocation[] {
  return writeTransaction(context.db, (tx) =>
    recordStockMovement(tx, {
      productId,
      direction: 'IN',
      qty: u(qtyUnits),
      totalCost: m(cost),
      movementType: 'ADJUSTMENT_IN',
      sourceType: 'TEST',
      businessDate: DAY,
      occurredAt: new Date(`${DAY}T09:00:00Z`),
      ...(batch ? { batch: { kind: 'NEW' as const, expiryDate: batch.expiryDate ?? null } } : {}),
    }),
  ).batchAllocations;
}

function moveOut(
  productId: number,
  qtyUnits: number,
  options: { businessDate?: string; allowExpired?: boolean; allowNegative?: boolean } = {},
): Allocation[] {
  const businessDate = options.businessDate ?? DAY;
  return writeTransaction(context.db, (tx) =>
    recordStockMovement(tx, {
      productId,
      direction: 'OUT',
      qty: u(qtyUnits),
      movementType: 'ADJUSTMENT_OUT',
      sourceType: 'TEST',
      businessDate,
      occurredAt: new Date(`${businessDate}T15:00:00Z`),
      allowNegative: options.allowNegative ?? false,
      batch: { kind: 'PICK', allowExpired: options.allowExpired ?? false },
    }),
  ).batchAllocations;
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  CASH = context.db
    .select()
    .from(paymentAccounts)
    .all()
    .find((account) => account.kind === 'CASH')!.id;
  SUPPLIER = createSupplier(context.db, { name: 'Kofi Wholesale' }, ACTOR);
});

afterEach(() => context.cleanup());

describe('the paths the shop already uses, which asked for nothing', () => {
  it('lands a delivery in the undated batch, and takes a sale back out of it', () => {
    const rice = makeProduct();

    createPurchase(
      context.db,
      {
        businessDate: DAY,
        supplierId: SUPPLIER,
        items: [{ productId: rice, qty: u(10), unitCost: m(1_000) }],
        tenders: [{ paymentAccountId: CASH, amount: m(10_000) }],
      },
      ACTOR,
    );

    const [batch] = batchesOf(rice);
    expect(batch!.expiryDate).toBeNull();
    expect(batch!.qtyMilli).toBe(10_000);
    expect(batch!.isClosed).toBe(false);

    createSale(
      context.db,
      {
        businessDate: DAY,
        items: [{ productId: rice, qty: u(4) }],
        tenders: [{ paymentAccountId: CASH, amount: m(12_000) }],
      },
      ACTOR,
    );

    expect(batchesOf(rice)).toHaveLength(1);
    expect(batchesOf(rice)[0]!.qtyMilli).toBe(6_000);
    expectBatchesIntact('purchase then sale');
  });

  it('opens exactly one undated batch however many deliveries arrive', () => {
    const rice = makeProduct();

    for (const price of [1_000, 2_000, 1_500]) {
      createPurchase(
        context.db,
        {
          businessDate: DAY,
          supplierId: SUPPLIER,
          items: [{ productId: rice, qty: u(5), unitCost: m(price) }],
          tenders: [{ paymentAccountId: CASH, amount: m(price * 5) }],
        },
        ACTOR,
      );
    }

    expect(batchesOf(rice)).toHaveLength(1);
    expect(batchesOf(rice)[0]!.qtyMilli).toBe(15_000);
    expectBatchesIntact('three deliveries');
  });

  it('holds coverage through a void of a delivery that is partly sold', () => {
    const rice = makeProduct();

    const first = createPurchase(
      context.db,
      {
        businessDate: DAY,
        supplierId: SUPPLIER,
        items: [{ productId: rice, qty: u(10), unitCost: m(1_000) }],
        tenders: [{ paymentAccountId: CASH, amount: m(10_000) }],
      },
      ACTOR,
    );

    createPurchase(
      context.db,
      {
        businessDate: DAY,
        supplierId: SUPPLIER,
        items: [{ productId: rice, qty: u(10), unitCost: m(2_000) }],
        tenders: [{ paymentAccountId: CASH, amount: m(20_000) }],
      },
      ACTOR,
    );

    createSale(
      context.db,
      {
        businessDate: DAY,
        items: [{ productId: rice, qty: u(5) }],
        tenders: [{ paymentAccountId: CASH, amount: m(15_000) }],
      },
      ACTOR,
    );

    voidPurchase(context.db, first.purchaseId, 'Supplier invoiced us twice', ACTOR);

    expect(batchesOf(rice)[0]!.qtyMilli).toBe(5_000);
    expectBatchesIntact('void of a partly-sold delivery');
  });

  it('holds coverage through a stock adjustment in both directions', () => {
    const rice = makeProduct();

    createStockAdjustment(
      context.db,
      {
        businessDate: DAY,
        reason: 'OPENING_STOCK',
        items: [{ productId: rice, direction: 'IN', qty: u(20), totalCost: m(20_000) }],
      },
      ACTOR,
    );
    createStockAdjustment(
      context.db,
      {
        businessDate: DAY,
        reason: 'DAMAGED',
        items: [{ productId: rice, direction: 'OUT', qty: u(3) }],
      },
      ACTOR,
    );

    expect(batchesOf(rice)[0]!.qtyMilli).toBe(17_000);
    expectBatchesIntact('adjustments both ways');
  });
});

describe('a batch that empties', () => {
  it('is closed, and reopens rather than being replaced when stock returns', () => {
    const rice = makeProduct();
    moveIn(rice, 5, 5_000);
    const opened = batchesOf(rice)[0]!.id;

    moveOut(rice, 5);
    expect(batchesOf(rice)[0]!.qtyMilli).toBe(0);
    expect(batchesOf(rice)[0]!.isClosed).toBe(true);

    moveIn(rice, 2, 2_000);

    const after = batchesOf(rice);
    expect(after).toHaveLength(1);
    expect(after[0]!.id, 'the same batch, not a new one').toBe(opened);
    expect(after[0]!.isClosed).toBe(false);
    expect(after[0]!.qtyMilli).toBe(2_000);
    expectBatchesIntact('emptied and refilled');
  });

  it('stays open while it is below zero, because that is a debt not an empty shelf', () => {
    const rice = makeProduct();
    moveIn(rice, 2, 2_000);
    moveOut(rice, 5, { allowNegative: true });

    const [batch] = batchesOf(rice);
    expect(batch!.qtyMilli).toBe(-3_000);
    expect(batch!.isClosed).toBe(false);
    expectBatchesIntact('oversold');
  });

  it('names the same batch once, not twice, when an oversell drains it', () => {
    // The allocation drains the batch and then pushes the SAME one negative. A
    // movement may touch a batch once — `uq_stock_ledger_batches`.
    const rice = makeProduct();
    moveIn(rice, 2, 2_000);

    const taken = moveOut(rice, 5, { allowNegative: true });
    expect(taken).toHaveLength(1);
    expect(taken[0]!.qtyMilli).toBe(5_000);
    expectBatchesIntact('oversell in one line');
  });
});

describe('first-expiry-first-out, reached through the gateway', () => {
  it('takes the tightest date first, then the next, then the undated', () => {
    const milk = makeProduct('Evaporated Milk');
    moveIn(milk, 5, 5_000); // undated
    moveIn(milk, 5, 5_000, { expiryDate: '2026-12-31' });
    moveIn(milk, 5, 5_000, { expiryDate: '2026-09-01' });

    const taken = moveOut(milk, 12);
    const byId = new Map(batchesOf(milk).map((b) => [b.id, b]));

    expect(taken.map((a) => [byId.get(a.batchId)!.expiryDate, a.qtyMilli])).toEqual([
      ['2026-09-01', 5_000],
      ['2026-12-31', 5_000],
      [null, 2_000],
    ]);
    expectBatchesIntact('fefo across three batches');
  });

  it('judges the date as at the shop day of the movement, not the wall clock', () => {
    // A sale entered late for a day when the goods were still good.
    const milk = makeProduct('Evaporated Milk');
    moveIn(milk, 5, 5_000, { expiryDate: LATER });
    moveIn(milk, 5, 5_000);

    const taken = moveOut(milk, 3, { businessDate: DAY });
    const dated = batchesOf(milk).find((b) => b.expiryDate === LATER)!;
    expect(taken).toEqual([expect.objectContaining({ batchId: dated.id, qtyMilli: 3_000 })]);
  });

  it('walks past expired stock in silence while good stock covers the sale', () => {
    const milk = makeProduct('Evaporated Milk');
    moveIn(milk, 5, 5_000, { expiryDate: '2026-01-01' }); // long gone
    moveIn(milk, 5, 5_000, { expiryDate: '2026-12-31' });

    const taken = moveOut(milk, 4);
    const good = batchesOf(milk).find((b) => b.expiryDate === '2026-12-31')!;
    expect(taken).toEqual([expect.objectContaining({ batchId: good.id, qtyMilli: 4_000 })]);
    expectBatchesIntact('expired stock skipped');
  });

  it('refuses the movement when only expired stock is left', () => {
    const milk = makeProduct('Evaporated Milk');
    moveIn(milk, 5, 5_000, { expiryDate: '2026-01-01' });

    expect(() => moveOut(milk, 2)).toThrow(ExpiredStockError);

    // And nothing moved: the throw happened inside the transaction.
    expect(batchesOf(milk)[0]!.qtyMilli).toBe(5_000);
    expectBatchesIntact('refused movement');
  });

  it('takes expired stock when someone with the right says so, oldest first', () => {
    const milk = makeProduct('Evaporated Milk');
    moveIn(milk, 5, 5_000, { expiryDate: '2026-02-01' });
    moveIn(milk, 5, 5_000, { expiryDate: '2026-01-01' });

    const taken = moveOut(milk, 6, { allowExpired: true });
    const byId = new Map(batchesOf(milk).map((b) => [b.id, b]));

    expect(taken.map((a) => [byId.get(a.batchId)!.expiryDate, a.qtyMilli])).toEqual([
      ['2026-01-01', 5_000],
      ['2026-02-01', 1_000],
    ]);
    expectBatchesIntact('expired taken with approval');
  });

  it('lets a shop that does not want the block turn it off', () => {
    context.db
      .update(businessSettings)
      .set({ expiryBlocksSales: false })
      .where(eq(businessSettings.id, 1))
      .run();

    const milk = makeProduct('Evaporated Milk');
    moveIn(milk, 5, 5_000, { expiryDate: '2026-01-01' });

    const taken = moveOut(milk, 2);
    expect(taken).toEqual([
      expect.objectContaining({ batchId: batchesOf(milk)[0]!.id, qtyMilli: 2_000 }),
    ]);
    expectBatchesIntact('block turned off');
  });
});
