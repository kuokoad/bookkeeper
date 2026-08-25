import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/types';
import {
  businessSettings,
  customers,
  productBatches,
  products,
  purchases,
  sales,
  stockLedger,
  stockLedgerBatches,
  suppliers,
} from '@/db/schema';
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
import {
  ExpiredStockError,
  InvariantViolatedError,
  NotFoundError,
  ValidationError,
} from '@/domain/errors';
import { assertPeriodOpen } from '@/domain/accounting/period-lock';
import { addDays, assertBusinessDate, daysBetween } from '@/domain/business-date';
import { readLockDate } from './journal.service';
import { writeAudit } from './audit.service';
import { writeTransaction } from '@/db/transaction';
import { DOC_TYPES, nextDocumentNumber } from './sequence.service';
import {
  allocateFefo,
  allocateProportional,
  formatQty,
  type Allocation,
  type FefoPlan,
} from '@/domain/inventory/batches';

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

  /**
   * Which batch the stock should come from, or land in.
   *
   * IN  — `NEW` opens a batch, which is what a dated delivery does.
   *       `SOURCE` puts units back into the exact batches they left from,
   *       which is what a void or a customer return must do, or the dates on a
   *       shelf become fiction after the first one.
   *       Omitted: lands in the product's undated batch.
   *
   * OUT — `PICK` runs first-expiry-first-out. Omitted means the same with
   *       `allowExpired: false`, which is the ordinary till.
   *       `SOURCE` takes the units back out of the batches a document put
   *       there, which is what returning goods to a supplier must do: their
   *       crate goes back, not whichever crate happens to be oldest.
   *
   * Every caller may omit this and get today's behaviour, because a shop whose
   * stock is all undated picks from one batch either way.
   */
  batch?: BatchDirective;
}

export type BatchDirective =
  | {
      kind: 'NEW';
      /** 'YYYY-MM-DD', or omitted for goods that do not expire. */
      expiryDate?: string | null;
      supplierId?: number | undefined;
      warnDays?: number | undefined;
      note?: string | undefined;
    }
  /**
   * The split a document originally made, from `readBatchSplits`.
   *
   * Works in both directions and means the same thing either way: these exact
   * batches, in proportion to what each contributed. Going IN it puts units
   * back where they were; going OUT it takes back what a document brought.
   */
  | { kind: 'SOURCE'; allocations: readonly Allocation[] }
  | {
      kind: 'PICK';
      allowExpired?: boolean;
      /**
       * Take the expired stock FIRST, which is what writing it off means.
       * Implies `allowExpired`: refusing to touch expired goods during a
       * write-off of expired goods would be absurd.
       */
      expiredFirst?: boolean;
    };

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

  /**
   * Which batches this movement touched, and by how much.
   *
   * Quantity only. A batch never carries a cost, so nothing here can be
   * multiplied by anything — see `src/domain/inventory/batches.ts`.
   */
  batchAllocations: Allocation[];

  /**
   * Batches past their date that this movement actually drew from.
   *
   * Empty on every ordinary movement, INCLUDING one made while expired stock
   * sat on the shelf untouched. Non-empty only when somebody was asked and
   * said yes, which makes it the fact an audit row should be written from —
   * recorded here because this is the only place that knows it.
   */
  expiredTaken: string[];
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

  // Which physical units moved. Runs inside the same transaction as everything
  // above, so a shelf can never be left holding stock no batch owns.
  const batchAllocations = allocateMovementToBatches(tx, input, ledgerRow.id);

  return {
    ledgerId: ledgerRow.id,
    totalCost: movement.totalCost,
    unitCost: movement.unitCost,
    state: movement.state,
    residual: movement.residual,
    batchAllocations,
    expiredTaken: expiredRefsAmong(tx, input, batchAllocations),
  };
}

// --- batch allocation ------------------------------------------------------

/**
 * Decide which batches a movement touched, and record it.
 *
 * Deliberately the last thing `recordStockMovement` does, and deliberately
 * inside it. Every caller — sales, purchases, both returns, both voids,
 * adjustments — comes through this one function, so none of them grows its own
 * copy of the picking rule, and none of them can forget.
 *
 * Quantity only. Nothing in here reads or writes a cost.
 */
function allocateMovementToBatches(
  tx: Tx,
  input: StockMovementInput,
  ledgerId: number,
): Allocation[] {
  const allocations =
    input.direction === 'IN' ? allocateIn(tx, input) : allocateOut(tx, input);

  for (const allocation of allocations) {
    tx.insert(stockLedgerBatches)
      .values({
        ledgerId,
        batchId: allocation.batchId,
        qtyInMilli: input.direction === 'IN' ? allocation.qtyMilli : 0,
        qtyOutMilli: input.direction === 'OUT' ? allocation.qtyMilli : 0,
        createdAt: input.occurredAt,
      })
      .run();

    applyToBatchCache(tx, allocation.batchId, input.direction, allocation.qtyMilli, input.occurredAt);
  }

  return allocations;
}

/** Stock arriving: into a new batch, back where it came from, or undated. */
function allocateIn(tx: Tx, input: StockMovementInput): Allocation[] {
  const directive = input.batch;

  if (directive?.kind === 'NEW') {
    const batch = openBatch(tx, input, directive);
    return [{ batchId: batch.id, batchRef: batch.batchRef, qtyMilli: input.qty }];
  }

  if (directive?.kind === 'SOURCE') {
    // Put the units back in the batches they left from, whatever state those
    // are in now. A batch that emptied is reopened rather than replaced: open a
    // new one and the trace from a delivery to its customers is broken.
    const back = allocateProportional(directive.allocations, input.qty);
    for (const allocation of back) reopenIfClosed(tx, allocation.batchId);
    return back;
  }

  const undated = findOrOpenUndatedBatch(tx, input);
  return [{ batchId: undated.id, batchRef: undated.batchRef, qtyMilli: input.qty }];
}

/** Stock leaving: back to its source if a document named one, otherwise FEFO. */
function allocateOut(tx: Tx, input: StockMovementInput): Allocation[] {
  const directive = input.batch;
  const expiredFirst = directive?.kind === 'PICK' && directive.expiredFirst === true;
  const approved = expiredFirst || (directive?.kind === 'PICK' && directive.allowExpired === true);

  if (directive?.kind === 'SOURCE') return allocateOutToSource(tx, input, directive.allocations);

  const open = tx
    .select({
      id: productBatches.id,
      batchRef: productBatches.batchRef,
      expiryDate: productBatches.expiryDate,
      qtyMilli: productBatches.qtyMilli,
    })
    .from(productBatches)
    .where(and(eq(productBatches.productId, input.productId), eq(productBatches.isClosed, false)))
    .all();

  // Expiry is judged as at the SHOP'S day for this movement, not the wall
  // clock. A sale entered late for yesterday is judged as it stood yesterday.
  //
  // Planned WITHOUT expired stock first, always. That first answer is what
  // decides whether anybody needs to be asked — and on the ordinary path, where
  // good stock covers the quantity, it is also the answer, so an old crate at
  // the back of the shelf never interrupts the till.
  if (expiredFirst) {
    const written = allocateFefo(open, input.qty, {
      today: input.businessDate,
      allowExpired: true,
      expiredFirst: true,
    });
    return written.shortfall > 0
      ? withShortfall(tx, input, written)
      : written.allocations;
  }

  let plan = allocateFefo(open, input.qty, { today: input.businessDate, allowExpired: false });

  if (plan.expiredNeeded > 0) {
    if (!approved && expiryBlocksSales(tx)) {
      const product = tx
        .select({ name: products.name })
        .from(products)
        .where(eq(products.id, input.productId))
        .get();

      throw new ExpiredStockError(
        product?.name ?? 'this product',
        formatQty(plan.expiredNeeded),
        plan.expiredRefs,
      );
    }

    // Either somebody approved it or the shop does not block on dates. Plan
    // again including the expired batches — otherwise the stock leaves the
    // shelf while no batch is recorded as giving it up, which is exactly the
    // hole `verifyBatchCoverage` exists to catch.
    plan = allocateFefo(open, input.qty, { today: input.businessDate, allowExpired: true });
  }

  if (plan.shortfall > 0) return withShortfall(tx, input, plan);

  return plan.allocations;
}

/**
 * What to do when the batches cannot cover what the product says is there.
 *
 * The costing engine has already decided whether an oversell is allowed, so
 * only two cases are left — and neither may quietly take stock from nowhere.
 */
function withShortfall(tx: Tx, input: StockMovementInput, plan: FefoPlan): Allocation[] {
  if (input.allowNegative === true) {
    // Allowed: the shortfall drives the undated batch below zero, which keeps
    // every unit — including the ones that are not there — owned by a batch.
    //
    // Merged, not appended: the undated batch may already be in the plan
    // (drained to zero on the way past), and one movement may touch a batch
    // only once — see `uq_stock_ledger_batches`.
    const undated = findOrOpenUndatedBatch(tx, input);
    return mergeByBatch([
      ...plan.allocations,
      { batchId: undated.id, batchRef: undated.batchRef, qtyMilli: plan.shortfall },
    ]);
  }

  // Not allowed, and yet the product says there is enough: the batches no
  // longer cover the shelf. That is `verifyBatchCoverage` failing, and it must
  // stop the transaction rather than invent stock.
  throw new InvariantViolatedError(
    `Stock exists that no batch owns: ${formatQty(plan.shortfall)} of product ${input.productId}.`,
    { productId: input.productId, shortfall: plan.shortfall },
  );
}

/**
 * Fold repeated batches into one line, keeping first-touched order.
 *
 * `uq_stock_ledger_batches` allows a movement to touch a batch once, and the
 * only path that can name one twice is an oversell that drains a batch and then
 * pushes the same one negative.
 */
function mergeByBatch(allocations: readonly Allocation[]): Allocation[] {
  const merged = new Map<number, Allocation>();

  for (const allocation of allocations) {
    const seen = merged.get(allocation.batchId);
    if (seen) {
      seen.qtyMilli += allocation.qtyMilli;
    } else {
      merged.set(allocation.batchId, { ...allocation });
    }
  }

  return [...merged.values()];
}

/**
 * Take stock back out of the batches a document put it in.
 *
 * Returning goods to a supplier, or voiding their delivery, has to remove
 * THEIR crate. Picking the oldest one instead would leave the shop holding
 * goods it has been paid back for, under a date that belongs to something else.
 *
 * Their crate may not be there any more, because some of it was sold. What is
 * left goes back first; the remainder falls through to ordinary picking, which
 * is the honest answer — the goods really did have to come from somewhere else.
 * Expired batches are open to it, because a void is not a sale and refusing to
 * undo a mistake over a date helps nobody.
 */
function allocateOutToSource(
  tx: Tx,
  input: StockMovementInput,
  source: readonly Allocation[],
): Allocation[] {
  const held = new Map(
    tx
      .select({ id: productBatches.id, qtyMilli: productBatches.qtyMilli })
      .from(productBatches)
      .where(eq(productBatches.productId, input.productId))
      .all()
      .map((row) => [row.id, row.qtyMilli]),
  );

  const wanted = allocateProportional(source, input.qty);
  const allocations: Allocation[] = [];
  let short = 0;

  for (const allocation of wanted) {
    const available = Math.max(0, held.get(allocation.batchId) ?? 0);
    const take = Math.min(available, allocation.qtyMilli);
    if (take > 0) allocations.push({ ...allocation, qtyMilli: take });
    short += allocation.qtyMilli - take;
  }

  if (short === 0) return allocations;

  const taken = new Set(allocations.map((allocation) => allocation.batchId));
  const rest = tx
    .select({
      id: productBatches.id,
      batchRef: productBatches.batchRef,
      expiryDate: productBatches.expiryDate,
      qtyMilli: productBatches.qtyMilli,
    })
    .from(productBatches)
    .where(and(eq(productBatches.productId, input.productId), eq(productBatches.isClosed, false)))
    .all()
    .filter((batch) => !taken.has(batch.id));

  const plan =
    rest.length === 0
      ? { allocations: [], shortfall: short }
      : allocateFefo(rest, makeQty(short), { today: input.businessDate, allowExpired: true });

  const merged = mergeByBatch([...allocations, ...plan.allocations]);
  if (plan.shortfall === 0) return merged;

  // Nothing left anywhere. The costing engine has already decided whether the
  // shop tolerates that; batches follow it rather than argue with it.
  if (input.allowNegative === true) {
    const undated = findOrOpenUndatedBatch(tx, input);
    return mergeByBatch([
      ...merged,
      { batchId: undated.id, batchRef: undated.batchRef, qtyMilli: plan.shortfall },
    ]);
  }

  throw new InvariantViolatedError(
    `Stock exists that no batch owns: ${formatQty(plan.shortfall)} of product ${input.productId}.`,
    { productId: input.productId, shortfall: plan.shortfall },
  );
}

/**
 * Which of these batches had passed their date on the day of the movement.
 *
 * Read back from the batches themselves rather than threaded out of the
 * allocator, because the allocator answers a different question — what it would
 * need — and this one asks what was actually taken.
 */
function expiredRefsAmong(
  tx: Tx,
  input: StockMovementInput,
  allocations: readonly Allocation[],
): string[] {
  // Only a movement that was GIVEN the right can have used it. Every sale at
  // every till passes through here, so this returns before touching the
  // database on all of them but the handful somebody had to approve.
  const approved = input.batch?.kind === 'PICK' && input.batch.allowExpired === true;
  if (!approved || allocations.length === 0) return [];

  const dates = new Map(
    tx
      .select({ id: productBatches.id, expiryDate: productBatches.expiryDate })
      .from(productBatches)
      .where(eq(productBatches.productId, input.productId))
      .all()
      .map((row) => [row.id, row.expiryDate]),
  );

  return allocations
    .filter((allocation) => {
      const expiryDate = dates.get(allocation.batchId);
      return expiryDate !== undefined && expiryDate !== null && expiryDate < input.businessDate;
    })
    .map((allocation) => allocation.batchRef);
}

/** Shop policy: is expired stock refused at the till? */
function expiryBlocksSales(tx: Tx): boolean {
  const settings = tx
    .select({ blocks: businessSettings.expiryBlocksSales })
    .from(businessSettings)
    .where(eq(businessSettings.id, 1))
    .get();
  return settings?.blocks ?? true;
}

function openBatch(
  tx: Tx,
  input: StockMovementInput,
  directive: Extract<BatchDirective, { kind: 'NEW' }>,
): { id: number; batchRef: string } {
  if (directive.expiryDate !== null && directive.expiryDate !== undefined) {
    assertBusinessDate(directive.expiryDate, 'expiry date');
  }

  const batchRef = nextDocumentNumber(tx, DOC_TYPES.BATCH);

  const row = tx
    .insert(productBatches)
    .values({
      productId: input.productId,
      batchRef,
      expiryDate: directive.expiryDate ?? null,
      receivedDate: input.businessDate,
      // Opens empty and is filled by the allocation about to be written, so the
      // ledger is the whole story for it — see `verifyProductBatches`.
      qtyMilli: 0,
      openingQtyMilli: 0,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      supplierId: directive.supplierId ?? null,
      warnDays: directive.warnDays ?? null,
      note: directive.note ?? null,
      isDemo: input.isDemo ?? false,
      createdAt: input.occurredAt,
      updatedAt: input.occurredAt,
    })
    .returning({ id: productBatches.id, batchRef: productBatches.batchRef })
    .get();

  if (!row) throw new InvariantViolatedError('Batch could not be opened.');
  return row;
}

/**
 * The product's undated batch, opened if it has none.
 *
 * Where stock lands when nobody said otherwise, and where a negative position
 * is carried. One per product: a second undated batch would split the same
 * anonymous stock across two rows for no reason anybody could later explain.
 */
function findOrOpenUndatedBatch(
  tx: Tx,
  input: StockMovementInput,
): { id: number; batchRef: string } {
  const existing = tx
    .select({ id: productBatches.id, batchRef: productBatches.batchRef })
    .from(productBatches)
    .where(and(eq(productBatches.productId, input.productId), isNull(productBatches.expiryDate)))
    .orderBy(asc(productBatches.id))
    .get();

  if (existing) {
    reopenIfClosed(tx, existing.id);
    return existing;
  }

  return openBatch(tx, input, { kind: 'NEW', expiryDate: null });
}

/** A batch receiving stock again must not stay marked empty. */
function reopenIfClosed(tx: Tx, batchId: number): void {
  tx.update(productBatches)
    .set({ isClosed: false })
    .where(and(eq(productBatches.id, batchId), eq(productBatches.isClosed, true)))
    .run();
}

/**
 * Move a batch's cached quantity, and close it when it empties.
 *
 * The cache is never the authority — `verifyProductBatches` proves it against
 * the allocations — but it is what picking reads, so it moves in the same
 * transaction as the allocation that changed it.
 */
function applyToBatchCache(
  tx: Tx,
  batchId: number,
  direction: 'IN' | 'OUT',
  qtyMilli: number,
  at: Date,
): void {
  const batch = tx.select().from(productBatches).where(eq(productBatches.id, batchId)).get();
  if (!batch) throw new InvariantViolatedError('Batch vanished mid-movement.', { batchId });

  const next = direction === 'IN' ? batch.qtyMilli + qtyMilli : batch.qtyMilli - qtyMilli;

  tx.update(productBatches)
    .set({
      qtyMilli: next,
      // Exactly empty and nothing left to come: closed. A negative position is
      // NOT closed — it is an open debt against the next delivery.
      isClosed: next === 0,
      updatedAt: at,
    })
    .where(eq(productBatches.id, batchId))
    .run();
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
/**
 * The batch split of each stock movement a document made for one product,
 * oldest movement first.
 *
 * Direction-agnostic on purpose. A movement goes one way or the other — the
 * ledger enforces it — so the quantity that touched a batch is simply whichever
 * of the two columns is filled. That lets one function answer both questions a
 * reversal asks: which crates a delivery filled, and which crates a sale
 * emptied.
 *
 * One array per ledger row, because the same product can appear on two lines of
 * one invoice and each line moved its own goods. Callers walk the lines in
 * order and take the head, exactly as the void path already does with the
 * original costs.
 *
 * An EMPTY array back is not a failure and must not be treated as one: every
 * movement made before batches existed has no split, and voiding a delivery
 * from last year has to keep working. The caller falls back to ordinary
 * picking, which is what that delivery would have got anyway.
 */
export function readBatchSplits(
  tx: Tx,
  source: { sourceType: string; sourceId: number },
  productId: number,
): Allocation[][] {
  const rows = tx
    .select({
      ledgerId: stockLedgerBatches.ledgerId,
      batchId: stockLedgerBatches.batchId,
      batchRef: productBatches.batchRef,
      qtyInMilli: stockLedgerBatches.qtyInMilli,
      qtyOutMilli: stockLedgerBatches.qtyOutMilli,
    })
    .from(stockLedgerBatches)
    .innerJoin(stockLedger, eq(stockLedger.id, stockLedgerBatches.ledgerId))
    .innerJoin(productBatches, eq(productBatches.id, stockLedgerBatches.batchId))
    .where(
      and(
        eq(stockLedger.sourceType, source.sourceType),
        eq(stockLedger.sourceId, source.sourceId),
        eq(stockLedger.productId, productId),
      ),
    )
    .orderBy(asc(stockLedgerBatches.ledgerId), asc(stockLedgerBatches.id))
    .all();

  const byMovement = new Map<number, Allocation[]>();
  for (const row of rows) {
    const moved = row.qtyInMilli + row.qtyOutMilli;
    if (moved <= 0) continue;
    const split = byMovement.get(row.ledgerId) ?? [];
    split.push({ batchId: row.batchId, batchRef: row.batchRef, qtyMilli: moved });
    byMovement.set(row.ledgerId, split);
  }

  return [...byMovement.values()];
}

export interface ProductBatchRow {
  id: number;
  batchRef: string;
  expiryDate: string | null;
  receivedDate: string | null;
  qtyMilli: number;
  isClosed: boolean;
  supplierName: string | null;
  /** Negative when the date has passed. Null for undated stock. */
  daysLeft: number | null;
}

/**
 * One product's batches, in the order stock will be taken from them.
 *
 * The same ordering as `orderForPicking`, done in SQL: dated-and-good by
 * soonest date, then undated, then expired. A shelf listed in a different order
 * from the one the till draws in would be a second, quieter account of the same
 * thing — and the two would eventually disagree.
 */
export function listProductBatches(db: Db, productId: number, asAt: string): ProductBatchRow[] {
  const rows = db
    .select({
      id: productBatches.id,
      batchRef: productBatches.batchRef,
      expiryDate: productBatches.expiryDate,
      receivedDate: productBatches.receivedDate,
      qtyMilli: productBatches.qtyMilli,
      isClosed: productBatches.isClosed,
      supplierName: suppliers.name,
    })
    .from(productBatches)
    .leftJoin(suppliers, eq(suppliers.id, productBatches.supplierId))
    .where(and(eq(productBatches.productId, productId), eq(productBatches.isClosed, false)))
    .orderBy(
      // 0 dated and good, 1 undated, 2 expired — mirroring `orderForPicking`.
      sql`CASE
            WHEN ${productBatches.expiryDate} IS NULL THEN 1
            WHEN ${productBatches.expiryDate} < ${asAt} THEN 2
            ELSE 0
          END`,
      asc(productBatches.expiryDate),
      asc(productBatches.id),
    )
    .all();

  return rows.map((row) => ({
    ...row,
    daysLeft: row.expiryDate === null ? null : daysBetween(asAt, row.expiryDate),
  }));
}

/**
 * Correct the date on a crate.
 *
 * This exists for one situation, and it is not a rare one: on the day a shop
 * installs this, migration 0019 opens an undated batch for everything already
 * on the shelf. For a shop selling milk and bread, "this stock does not expire"
 * is simply false, and there is no other way to make it true — the goods were
 * bought before anybody was asked for a date.
 *
 * It changes NOTHING about quantity or value. It changes which crate the till
 * reaches for next, and whether it refuses, which is exactly why it is audited
 * with both the old value and the new.
 */
export function setBatchExpiry(
  db: Db,
  batchId: number,
  expiryDate: string | null,
  actor: { id: number; username: string },
): void {
  if (expiryDate !== null) assertBusinessDate(expiryDate, 'expiry date');

  writeTransaction(db, (tx) => {
    const batch = tx
      .select({
        id: productBatches.id,
        batchRef: productBatches.batchRef,
        expiryDate: productBatches.expiryDate,
        productId: productBatches.productId,
      })
      .from(productBatches)
      .where(eq(productBatches.id, batchId))
      .get();

    if (!batch) throw new NotFoundError('Batch', batchId);
    if (batch.expiryDate === expiryDate) return;

    const now = new Date();
    tx.update(productBatches)
      .set({ expiryDate, updatedAt: now })
      .where(eq(productBatches.id, batchId))
      .run();

    writeAudit(tx, {
      action: 'UPDATE',
      entityType: 'product_batch',
      entityId: batchId,
      userId: actor.id,
      username: actor.username,
      summary:
        expiryDate === null
          ? `${batch.batchRef}: expiry date removed`
          : `${batch.batchRef}: expiry date set to ${expiryDate}`,
      metadata: {
        before: { expiryDate: batch.expiryDate },
        after: { expiryDate },
        productId: batch.productId,
      },
      at: now,
    });
  });
}

export interface OpenBatchRow extends ProductBatchRow {
  productId: number;
  productName: string;
  sku: string | null;
  unit: string;
}

/**
 * Every crate in the shop that still holds stock, soonest date first.
 *
 * For the expiry export, which is opened to answer "which ones" — the summary
 * on screen answers "how bad is it". Undated crates come last: they are not
 * distant, they are unknown, and putting them among the far-off dates would
 * bury the ones that matter.
 */
export function listAllOpenBatches(db: Db, asAt: string): OpenBatchRow[] {
  const rows = db
    .select({
      id: productBatches.id,
      batchRef: productBatches.batchRef,
      expiryDate: productBatches.expiryDate,
      receivedDate: productBatches.receivedDate,
      qtyMilli: productBatches.qtyMilli,
      isClosed: productBatches.isClosed,
      supplierName: suppliers.name,
      productId: products.id,
      productName: products.name,
      sku: products.sku,
      unit: products.unit,
    })
    .from(productBatches)
    .innerJoin(products, eq(products.id, productBatches.productId))
    .leftJoin(suppliers, eq(suppliers.id, productBatches.supplierId))
    .where(and(eq(productBatches.isClosed, false), sql`${productBatches.qtyMilli} <> 0`))
    .orderBy(
      sql`CASE WHEN ${productBatches.expiryDate} IS NULL THEN 1 ELSE 0 END`,
      asc(productBatches.expiryDate),
      asc(products.name),
      asc(productBatches.id),
    )
    .all();

  return rows.map((row) => ({
    ...row,
    daysLeft: row.expiryDate === null ? null : daysBetween(asAt, row.expiryDate),
  }));
}

export const EXPIRY_BUCKETS = ['expired', 'within7', 'within30', 'within90', 'later', 'undated'] as const;

export type ExpiryBucket = (typeof EXPIRY_BUCKETS)[number];

export interface ExpiryAgeingRow {
  bucket: ExpiryBucket;
  label: string;
  batchCount: number;
  qtyMilli: number;
}

const BUCKET_LABELS: Record<ExpiryBucket, string> = {
  expired: 'Already expired',
  within7: 'Within 7 days',
  within30: 'Within 30 days',
  within90: 'Within 90 days',
  later: 'Later than 90 days',
  undated: 'No date recorded',
};

/**
 * Stock by how long it has left, in one pass.
 *
 * QUANTITY, not value. A batch has never carried a cost and must not start
 * here: value is weighted-average and pooled per product, so "the value of
 * stock expiring within 7 days" is a number this application cannot honestly
 * produce — see `src/domain/inventory/batches.ts`.
 *
 * Every open batch holding stock lands in exactly one bucket, and undated stock
 * has its own rather than being filed under "later". Undated is not distant;
 * it is unknown, and a report that blurs the two would tell a shop its
 * perishables were years away.
 */
export function getExpiryAgeing(db: Db, asAt: string): ExpiryAgeingRow[] {
  const rows = db
    .select({
      expiryDate: productBatches.expiryDate,
      qtyMilli: productBatches.qtyMilli,
    })
    .from(productBatches)
    .where(and(eq(productBatches.isClosed, false), sql`${productBatches.qtyMilli} > 0`))
    .all();

  const totals = new Map<ExpiryBucket, { batchCount: number; qtyMilli: number }>(
    EXPIRY_BUCKETS.map((bucket) => [bucket, { batchCount: 0, qtyMilli: 0 }]),
  );

  for (const row of rows) {
    const bucket: ExpiryBucket =
      row.expiryDate === null
        ? 'undated'
        : row.expiryDate < asAt
          ? 'expired'
          : row.expiryDate <= addDays(asAt, 7)
            ? 'within7'
            : row.expiryDate <= addDays(asAt, 30)
              ? 'within30'
              : row.expiryDate <= addDays(asAt, 90)
                ? 'within90'
                : 'later';

    const total = totals.get(bucket)!;
    total.batchCount += 1;
    total.qtyMilli += row.qtyMilli;
  }

  return EXPIRY_BUCKETS.map((bucket) => ({
    bucket,
    label: BUCKET_LABELS[bucket],
    ...totals.get(bucket)!,
  }));
}

export interface BatchHistoryEntry {
  ledgerId: number;
  businessDate: string;
  occurredAt: Date;
  movementType: string;
  sourceType: string;
  sourceId: number | null;
  sourceRef: string | null;
  qtyInMilli: number;
  qtyOutMilli: number;
  /** Who the goods went to, when the document names somebody. */
  partyName: string | null;
}

export interface BatchHistory {
  batch: {
    id: number;
    productId: number;
    productName: string;
    unit: string;
    batchRef: string;
    expiryDate: string | null;
    receivedDate: string | null;
    qtyMilli: number;
    openingQtyMilli: number;
    isClosed: boolean;
    supplierName: string | null;
    note: string | null;
  };
  entries: BatchHistoryEntry[];
}

/**
 * Everything that ever touched one batch, oldest first.
 *
 * The recall query, and the reason the split was hung off the LEDGER ROW rather
 * than the sale line: one join from `stock_ledger_batches` through
 * `stock_ledger.sourceType` and `sourceId` answers "who bought from this
 * delivery?" for sales, returns, voids and write-offs alike, without this
 * function needing to know what any of those documents look like.
 *
 * The customer name is looked up per entry rather than joined, because a
 * movement can belong to five different kinds of document and a five-way outer
 * join to fetch one string is worse than a handful of indexed reads on a page
 * nobody opens twice a day.
 */
export function getBatchHistory(db: Db, batchId: number): BatchHistory {
  const batch = db
    .select({
      id: productBatches.id,
      productId: productBatches.productId,
      productName: products.name,
      unit: products.unit,
      batchRef: productBatches.batchRef,
      expiryDate: productBatches.expiryDate,
      receivedDate: productBatches.receivedDate,
      qtyMilli: productBatches.qtyMilli,
      openingQtyMilli: productBatches.openingQtyMilli,
      isClosed: productBatches.isClosed,
      supplierName: suppliers.name,
      note: productBatches.note,
    })
    .from(productBatches)
    .innerJoin(products, eq(products.id, productBatches.productId))
    .leftJoin(suppliers, eq(suppliers.id, productBatches.supplierId))
    .where(eq(productBatches.id, batchId))
    .get();

  if (!batch) throw new NotFoundError('Batch', batchId);

  const rows = db
    .select({
      ledgerId: stockLedger.id,
      businessDate: stockLedger.businessDate,
      occurredAt: stockLedger.occurredAt,
      movementType: stockLedger.movementType,
      sourceType: stockLedger.sourceType,
      sourceId: stockLedger.sourceId,
      sourceRef: stockLedger.sourceRef,
      qtyInMilli: stockLedgerBatches.qtyInMilli,
      qtyOutMilli: stockLedgerBatches.qtyOutMilli,
    })
    .from(stockLedgerBatches)
    .innerJoin(stockLedger, eq(stockLedger.id, stockLedgerBatches.ledgerId))
    .where(eq(stockLedgerBatches.batchId, batchId))
    .orderBy(asc(stockLedger.id))
    .all();

  const entries = rows.map((row) => ({
    ...row,
    partyName: partyFor(db, row.sourceType, row.sourceId),
  }));

  return { batch, entries };
}

/** Who a movement's document was with, when it was with anybody. */
function partyFor(db: Db, sourceType: string, sourceId: number | null): string | null {
  if (sourceId === null) return null;

  if (sourceType === 'SALE' || sourceType === 'SALE_RETURN' || sourceType === 'SALE_VOID') {
    const row = db
      .select({ name: customers.name })
      .from(sales)
      .leftJoin(customers, eq(customers.id, sales.customerId))
      .where(eq(sales.id, sourceId))
      .get();
    // A walk-in customer is a real answer, not a missing one — and for a recall
    // it is the answer that matters most, because nobody can be telephoned.
    return row === undefined ? null : (row.name ?? 'Walk-in customer');
  }

  if (
    sourceType === 'PURCHASE' ||
    sourceType === 'PURCHASE_RETURN' ||
    sourceType === 'PURCHASE_VOID'
  ) {
    const row = db
      .select({ name: suppliers.name })
      .from(purchases)
      .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
      .where(eq(purchases.id, sourceId))
      .get();
    return row?.name ?? null;
  }

  return null;
}

export interface ExpiredBatch {
  id: number;
  productId: number;
  batchRef: string;
  expiryDate: string;
  qtyMilli: number;
}

/**
 * Every crate that has passed its date and still holds stock.
 *
 * For the write-off form, which has to let somebody say WHICH crate went off.
 * Ordered soonest-expired first, so the oldest problem is at the top of the
 * list where it belongs.
 */
export function listExpiredBatches(db: Db, asAt: string): ExpiredBatch[] {
  return db
    .select({
      id: productBatches.id,
      productId: productBatches.productId,
      batchRef: productBatches.batchRef,
      expiryDate: productBatches.expiryDate,
      qtyMilli: productBatches.qtyMilli,
    })
    .from(productBatches)
    .where(
      and(
        eq(productBatches.isClosed, false),
        sql`${productBatches.qtyMilli} > 0`,
        sql`${productBatches.expiryDate} IS NOT NULL`,
        sql`${productBatches.expiryDate} < ${asAt}`,
      ),
    )
    .orderBy(asc(productBatches.expiryDate), asc(productBatches.id))
    .all()
    .map((row) => ({ ...row, expiryDate: row.expiryDate as string }));
}

export interface ExpiryOutlook {
  /**
   * Stock that has NOT passed its date, in milli-units.
   *
   * The number that decides whether a sale goes through untroubled. Anything
   * above this is heading for a question.
   */
  goodQtyMilli: number;
  /**
   * The soonest date among that good stock, or null when none of it is dated.
   * This is the crate first-expiry-first-out will reach for next.
   */
  soonestExpiry: string | null;
}

/**
 * What each product's dates look like, as at a business day, in one pass.
 *
 * For the till, which needs this for every product on screen and cannot afford
 * a query per line. Undated stock counts as good, because it is: nothing about
 * it has run out.
 */
export function getExpiryOutlook(db: Db, businessDate: string): Map<number, ExpiryOutlook> {
  const rows = db
    .select({
      productId: productBatches.productId,
      goodQtyMilli: sql<number>`COALESCE(SUM(${productBatches.qtyMilli}), 0)`,
      soonestExpiry: sql<string | null>`MIN(${productBatches.expiryDate})`,
    })
    .from(productBatches)
    .where(
      and(
        eq(productBatches.isClosed, false),
        sql`${productBatches.qtyMilli} > 0`,
        sql`(${productBatches.expiryDate} IS NULL OR ${productBatches.expiryDate} >= ${businessDate})`,
      ),
    )
    .groupBy(productBatches.productId)
    .all();

  return new Map(
    rows.map((row) => [
      row.productId,
      { goodQtyMilli: row.goodQtyMilli, soonestExpiry: row.soonestExpiry },
    ]),
  );
}

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
