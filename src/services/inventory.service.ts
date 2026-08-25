import { asc, eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/types';
import { productBatches, products, stockLedger, stockLedgerBatches } from '@/db/schema';
import type { MovementType } from '@/db/schema/inventory';
import {
  applyStockIn,
  applyStockOut,
  applyStockOutAtCost,
  averageUnitCost,
  replayChain,
  type StockState,
} from '@/domain/inventory/costing';
import { minor, subtract, type Minor } from '@/domain/money';
import { qty as makeQty, type Qty } from '@/domain/quantity';
import { InvariantViolatedError, NotFoundError, ValidationError } from '@/domain/errors';
import { assertPeriodOpen } from '@/domain/accounting/period-lock';
import { readLockDate } from './journal.service';

/**
 * The single gateway through which inventory changes.
 *
 * Sales, purchases, returns and adjustments all call `recordStockMovement`, so
 * the weighted-average arithmetic exists in exactly one place and every
 * movement lands in the ledger with its running balance attached.
 *
 * Every function here takes a `Tx` and MUST be called inside a transaction: a
 * ledger row and the product cache update have to commit together or not at all.
 */

export interface StockMovementInput {
  productId: number;
  direction: 'IN' | 'OUT';
  qty: Qty;
  /**
   * For IN: required — the exact value entering inventory.
   *
   * For OUT: OPTIONAL. Omit it and the cost is allocated from the running
   * weighted average (a sale, a write-off). Supply it and the stock leaves at
   * that exact cost instead — used when returning goods to a supplier, which
   * must leave at the price that supplier charged rather than at a blended
   * average that includes other deliveries.
   */
  totalCost?: Minor;
  movementType: MovementType;
  sourceType: string;
  sourceId?: number | undefined;
  sourceRef?: string | undefined;
  businessDate: string;
  occurredAt: Date;
  userId?: number | undefined;
  note?: string | undefined;
  /** Shop policy, read from settings by the caller. */
  allowNegative?: boolean;
  isDemo?: boolean;
  /** Owner-level bypass of the books lock. See postJournalEntry. */
  overridePeriodLock?: boolean;
}

export interface StockMovementResult {
  ledgerId: number;
  /** Value that moved. For OUT this is the cost of goods sold. */
  totalCost: Minor;
  unitCost: Minor;
  state: StockState;
  /**
   * Value forced out of inventory ON TOP of `totalCost` to keep an empty shelf
   * worth nothing. Almost always zero. When it is not, the caller MUST post it
   * to the ledger — see `MovementResult.residual`.
   */
  residual: Minor;
}

export function getStockState(tx: Tx, productId: number): StockState {
  const product = tx
    .select({
      qty: products.qtyOnHandMilli,
      value: products.stockValueMinor,
    })
    .from(products)
    .where(eq(products.id, productId))
    .get();

  if (!product) throw new NotFoundError('Product', productId);

  return { qty: makeQty(product.qty), value: minor(product.value) };
}

export function recordStockMovement(tx: Tx, input: StockMovementInput): StockMovementResult {
  // Second books-lock checkpoint. Most movements accompany a journal entry and
  // are already covered by `postJournalEntry`, but a write-off of stock that
  // carries no value posts nothing — so the lock is enforced here too.
  assertPeriodOpen(input.businessDate, readLockDate(tx), {
    ...(input.overridePeriodLock === true ? { allowOverride: true } : {}),
  });

  const product = tx.select().from(products).where(eq(products.id, input.productId)).get();
  if (!product) throw new NotFoundError('Product', input.productId);

  if (!product.trackInventory) {
    throw new ValidationError(
      `"${product.name}" is not stock-tracked, so its stock cannot be moved.`,
      { productId: input.productId },
    );
  }
  if (input.qty <= 0) {
    throw new ValidationError('Stock movement quantity must be greater than zero.', {
      qty: input.qty,
    });
  }

  const current: StockState = {
    qty: makeQty(product.qtyOnHandMilli),
    value: minor(product.stockValueMinor),
  };

  const movement =
    input.direction === 'IN'
      ? applyStockIn(current, input.qty, requireTotalCost(input))
      : input.totalCost !== undefined
        ? applyStockOutAtCost(current, input.qty, input.totalCost, {
            allowNegative: input.allowNegative ?? false,
            productName: product.name,
          })
        : applyStockOut(current, input.qty, {
            allowNegative: input.allowNegative ?? false,
            fallbackUnitCost: minor(product.costPriceMinor),
            productName: product.name,
          });

  const ledgerRow = tx
    .insert(stockLedger)
    .values({
      productId: input.productId,
      businessDate: input.businessDate,
      occurredAt: input.occurredAt,
      movementType: input.movementType,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      sourceRef: input.sourceRef ?? null,
      qtyInMilli: input.direction === 'IN' ? input.qty : 0,
      qtyOutMilli: input.direction === 'OUT' ? input.qty : 0,
      unitCostMinor: movement.unitCost,
      totalCostMinor: movement.totalCost,
      balanceQtyMilli: movement.state.qty,
      balanceValueMinor: movement.state.value,
      note: input.note ?? null,
      userId: input.userId ?? null,
      isDemo: input.isDemo ?? false,
      createdAt: input.occurredAt,
    })
    .returning({ id: stockLedger.id })
    .get();

  if (!ledgerRow) {
    throw new InvariantViolatedError('Stock ledger row could not be written.');
  }

  // Refresh the cache from the movement we just computed. The ledger row above
  // is the source of truth; this keeps product lists fast without an aggregate.
  tx.update(products)
    .set({
      qtyOnHandMilli: movement.state.qty,
      stockValueMinor: movement.state.value,
      updatedAt: input.occurredAt,
    })
    .where(eq(products.id, input.productId))
    .run();

  return {
    ledgerId: ledgerRow.id,
    totalCost: movement.totalCost,
    unitCost: movement.unitCost,
    state: movement.state,
    residual: movement.residual,
  };
}

function requireTotalCost(input: StockMovementInput): Minor {
  if (input.totalCost === undefined) {
    throw new ValidationError('Receiving stock requires the total cost of the goods.', {
      productId: input.productId,
    });
  }
  return input.totalCost;
}

// --- batch integrity -------------------------------------------------------

export interface BatchVerification {
  batchId: number;
  batchRef: string;
  productId: number;
  cachedQty: Qty;
  /** Opening quantity plus every allocation the ledger recorded against it. */
  allocatedQty: Qty;
  drift: number;
  ok: boolean;
}

export interface BatchCoverageCheck {
  productId: number;
  productName: string;
  productQty: Qty;
  /** The sum of every batch this product has. */
  batchedQty: Qty;
  drift: number;
  ok: boolean;
  batchCount: number;
}

/**
 * Per batch: does its cached quantity match what it opened with, plus every
 * movement the ledger allocated to it?
 *
 *     qtyMilli === openingQtyMilli + sum(qtyIn) - sum(qtyOut)
 *
 * The same relationship `verifyProductStock` proves for a product, one level
 * down. `product_batches.qtyMilli` is a cache exactly as
 * `products.qtyOnHandMilli` is, and it is worth no more than its proof.
 *
 * `openingQtyMilli` is what makes this a real check rather than a tautology.
 * Stock that predates batches has no allocations to replay, so an earlier draft
 * of this function derived the opening figure by winding the cache back through
 * its own allocations — which can only ever agree with itself. Recording what
 * the batch started with, once, at migration, is the difference between proving
 * something and appearing to.
 */
export function verifyProductBatches(db: Db, productId: number): BatchVerification[] {
  const batches = db
    .select()
    .from(productBatches)
    .where(eq(productBatches.productId, productId))
    .all();

  return batches.map((batch) => {
    const moved = db
      .select({
        inQty: sql<number>`COALESCE(SUM(${stockLedgerBatches.qtyInMilli}), 0)`,
        outQty: sql<number>`COALESCE(SUM(${stockLedgerBatches.qtyOutMilli}), 0)`,
      })
      .from(stockLedgerBatches)
      .where(eq(stockLedgerBatches.batchId, batch.id))
      .get();

    const allocated = batch.openingQtyMilli + (moved?.inQty ?? 0) - (moved?.outQty ?? 0);
    const drift = batch.qtyMilli - allocated;

    return {
      batchId: batch.id,
      batchRef: batch.batchRef,
      productId: batch.productId,
      cachedQty: makeQty(batch.qtyMilli),
      allocatedQty: makeQty(allocated),
      drift,
      ok: drift === 0,
    };
  });
}

/**
 * Per product: does every unit on the shelf belong to some batch?
 *
 * THE ONE THAT MATTERS MOST. If this fails, stock exists that no batch owns,
 * which means picking runs against an incomplete set: a sale can report there is
 * nothing to take while the shelf is full, and — worse and quieter — an expiry
 * warning can be missing for goods that are about to turn.
 *
 * Cheap by design, so it can sit in `preflight` beside the stock-cache check:
 * one grouped sum against a cached column, no replay.
 */
export function verifyBatchCoverage(db: Db): BatchCoverageCheck[] {
  const rows = db.all<{
    productId: number;
    productName: string;
    productQty: number;
    batchedQty: number;
    batchCount: number;
  }>(sql`
    SELECT
      p.id                                        AS productId,
      p.name                                      AS productName,
      p.qty_on_hand_milli                         AS productQty,
      COALESCE(SUM(b.qty_milli), 0)               AS batchedQty,
      COUNT(b.id)                                 AS batchCount
    FROM products p
    LEFT JOIN product_batches b ON b.product_id = p.id
    WHERE p.track_inventory = 1
    GROUP BY p.id
  `);

  return rows.map((row) => {
    const drift = row.productQty - row.batchedQty;
    return {
      productId: row.productId,
      productName: row.productName,
      productQty: makeQty(row.productQty),
      batchedQty: makeQty(row.batchedQty),
      drift,
      ok: drift === 0,
      batchCount: row.batchCount,
    };
  });
}

// --- integrity ------------------------------------------------------------

export interface StockVerification {
  productId: number;
  productName: string;
  cachedQty: Qty;
  cachedValue: Minor;
  ledgerQty: Qty;
  ledgerValue: Minor;
  qtyDrift: number;
  valueDrift: Minor;
  ok: boolean;
  movementCount: number;
}

/**
 * Recompute a product's position from its FIRST movement and compare it with
 * the cached columns.
 *
 * This is what makes the cache honest: it is never the authority, and any
 * disagreement with the ledger is detectable rather than silently believed.
 */
export function verifyProductStock(db: Db, productId: number): StockVerification {
  const product = db.select().from(products).where(eq(products.id, productId)).get();
  if (!product) throw new NotFoundError('Product', productId);

  const movements = db
    .select({
      qtyIn: stockLedger.qtyInMilli,
      qtyOut: stockLedger.qtyOutMilli,
      totalCost: stockLedger.totalCostMinor,
    })
    .from(stockLedger)
    .where(eq(stockLedger.productId, productId))
    .orderBy(asc(stockLedger.id))
    .all();

  const replayed = replayChain(
    movements.map((row) => ({
      qtyIn: makeQty(row.qtyIn),
      qtyOut: makeQty(row.qtyOut),
      totalCost: minor(row.totalCost),
    })),
  );

  const cachedQty = makeQty(product.qtyOnHandMilli);
  const cachedValue = minor(product.stockValueMinor);
  const qtyDrift = cachedQty - replayed.qty;
  const valueDrift = subtract(cachedValue, replayed.value);

  return {
    productId,
    productName: product.name,
    cachedQty,
    cachedValue,
    ledgerQty: replayed.qty,
    ledgerValue: replayed.value,
    qtyDrift,
    valueDrift,
    ok: qtyDrift === 0 && valueDrift === 0,
    movementCount: movements.length,
  };
}

/**
 * The cheap integrity check: does the cache agree with the LAST balance the
 * ledger recorded?
 *
 * One query that seeks straight to each product's newest movement, rather than
 * reading every movement ever made — which is what `verifyAllStock` does, and
 * why it grows without bound as the shop trades. That one proves the whole
 * chain and belongs somewhere a person has chosen to wait; this one is cheap
 * enough for a page that renders on every visit.
 *
 * The cost is one index seek per PRODUCT. It is not free — a shop with more
 * products pays more — but it no longer climbs with the number of movements,
 * which is the thing that grows for ever. Measured by `npm run benchmark`.
 *
 * It catches what actually goes wrong: the cached columns on `products` drifting
 * away from the ledger, because they were written by something other than
 * `recordStockMovement`. Both are written from the same computed state inside one
 * transaction, so any disagreement means a write got in from outside.
 *
 * What it does NOT catch is a ledger that is internally inconsistent — a row
 * removed from the middle of a chain, leaving the running balances describing a
 * history that no longer exists. Only a replay finds that, which is why
 * `npm run preflight` still does one.
 */
export type StockCacheCheck = Omit<StockVerification, 'movementCount'>;

export function verifyStockAgainstLedger(db: Db): StockCacheCheck[] {
  /**
   * `MAX(id)` correlated to one product is an index SEEK on
   * `idx_stock_ledger_product (product_id, id)` — straight to the end of that
   * product's range. Written as `... GROUP BY product_id` instead it becomes a
   * scan of the whole index, one entry per movement, and the cost of the check
   * climbs with the shop's history again. Same answer, and the difference is
   * measurable: see `npm run benchmark`.
   */
  const rows = db.all<{
    productId: number;
    productName: string;
    cachedQty: number;
    cachedValue: number;
    ledgerQty: number;
    ledgerValue: number;
  }>(sql`
    SELECT
      p.id                                AS productId,
      p.name                              AS productName,
      p.qty_on_hand_milli                 AS cachedQty,
      p.stock_value_minor                 AS cachedValue,
      COALESCE(l.balance_qty_milli, 0)    AS ledgerQty,
      COALESCE(l.balance_value_minor, 0)  AS ledgerValue
    FROM products p
    LEFT JOIN stock_ledger l
      ON l.id = (SELECT MAX(id) FROM stock_ledger WHERE product_id = p.id)
    WHERE p.track_inventory = 1
  `);

  return rows.map((product) => {
    // A product that has never moved has no ledger row, so COALESCE reads zero.
    // Holding nothing is the right answer for it, and it is CHECKED rather than
    // skipped — stock on a product that never received any is exactly the sort
    // of thing this is looking for.
    const cachedQty = makeQty(product.cachedQty);
    const cachedValue = minor(product.cachedValue);
    const ledgerQty = makeQty(product.ledgerQty);
    const ledgerValue = minor(product.ledgerValue);
    const qtyDrift = cachedQty - ledgerQty;
    const valueDrift = subtract(cachedValue, ledgerValue);

    return {
      productId: product.productId,
      productName: product.productName,
      cachedQty,
      cachedValue,
      ledgerQty,
      ledgerValue,
      qtyDrift,
      valueDrift,
      ok: qtyDrift === 0 && valueDrift === 0,
    };
  });
}

/**
 * Verify every stock-tracked product by REPLAYING its whole movement history.
 *
 * Thorough and slow: one query per product, each reading that product's entire
 * ledger. Use it where somebody has asked for a deep check and can wait — never
 * on a page that renders on every visit. For that, use
 * `verifyStockAgainstLedger` above.
 */
export function verifyAllStock(db: Db): StockVerification[] {
  return db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.trackInventory, true))
    .all()
    .map((row) => verifyProductStock(db, row.id));
}

/** Total value of stock on hand, from the product cache. */
export function getInventoryValue(db: Db): Minor {
  const row = db
    .select({ total: sql<number>`COALESCE(SUM(${products.stockValueMinor}), 0)` })
    .from(products)
    .get();
  return minor(row?.total ?? 0);
}

/** Total value of stock on hand, recomputed from the ledger. */
export function getInventoryValueFromLedger(db: Db): Minor {
  return minor(
    verifyAllStock(db).reduce((total, verification) => total + verification.ledgerValue, 0),
  );
}

// --- reads ----------------------------------------------------------------

export interface LedgerQuery {
  productId?: number;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export function getStockLedger(db: Db, query: LedgerQuery = {}) {
  const conditions = [];
  if (query.productId !== undefined) conditions.push(eq(stockLedger.productId, query.productId));
  if (query.from !== undefined) conditions.push(sql`${stockLedger.businessDate} >= ${query.from}`);
  if (query.to !== undefined) conditions.push(sql`${stockLedger.businessDate} <= ${query.to}`);

  const base = db
    .select({
      id: stockLedger.id,
      productId: stockLedger.productId,
      productName: products.name,
      productUnit: products.unit,
      businessDate: stockLedger.businessDate,
      occurredAt: stockLedger.occurredAt,
      movementType: stockLedger.movementType,
      sourceType: stockLedger.sourceType,
      sourceRef: stockLedger.sourceRef,
      qtyIn: stockLedger.qtyInMilli,
      qtyOut: stockLedger.qtyOutMilli,
      unitCost: stockLedger.unitCostMinor,
      totalCost: stockLedger.totalCostMinor,
      balanceQty: stockLedger.balanceQtyMilli,
      balanceValue: stockLedger.balanceValueMinor,
      note: stockLedger.note,
    })
    .from(stockLedger)
    .innerJoin(products, eq(products.id, stockLedger.productId));

  const filtered = conditions.length > 0 ? base.where(sql.join(conditions, sql` AND `)) : base;

  return filtered
    .orderBy(sql`${stockLedger.occurredAt} DESC`, sql`${stockLedger.id} DESC`)
    .limit(Math.min(query.limit ?? 100, 500))
    .offset(query.offset ?? 0)
    .all();
}

/** Display-only average unit cost for a product. */
export function getAverageCost(tx: Tx, productId: number): Minor {
  return averageUnitCost(getStockState(tx, productId));
}
