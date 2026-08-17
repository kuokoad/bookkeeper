import { asc, eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/types';
import { products, stockLedger } from '@/db/schema';
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

/** Verify every stock-tracked product. Used by the integrity report. */
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
