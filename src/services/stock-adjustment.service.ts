import { desc, eq } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db, Tx } from '@/db/types';
import {
  accounts,
  businessSettings,
  products,
  stockAdjustmentItems,
  stockAdjustments,
} from '@/db/schema';
import type { AdjustmentDirection, AdjustmentReason } from '@/db/schema/inventory';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { credit, debit, type DraftLine } from '@/domain/accounting/journal';
import { add, isZero, minor, sum, ZERO, type Minor } from '@/domain/money';
import type { Qty } from '@/domain/quantity';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';
import { postJournalEntry, reverseJournalEntry, type Actor } from './journal.service';
import { recordStockMovement } from './inventory.service';
import { DOC_TYPES, nextDocumentNumber } from './sequence.service';

/**
 * Stock adjustments: the only way stock changes without a sale or a purchase.
 *
 * Each adjustment is one atomic transaction producing:
 *   1. the adjustment document and its items,
 *   2. one stock ledger movement per item,
 *   3. ONE balanced journal entry for the whole document,
 *   4. an audit record.
 *
 * If any step fails, all of it rolls back — there is no such thing as stock
 * that moved without a corresponding accounting entry.
 */

/**
 * Which account the value is posted against.
 *
 * Inventory is always the other side. Keeping this mapping in one place means
 * the accounting treatment of a reason is a single, reviewable fact rather than
 * something scattered across the code.
 */
const REASON_ACCOUNT: Record<AdjustmentReason, string> = {
  // Opening stock is capital introduced, not an expense.
  OPENING_STOCK: ACCOUNT_CODES.OPENING_BALANCE_EQUITY,
  DAMAGED: ACCOUNT_CODES.INVENTORY_SHRINKAGE,
  LOST: ACCOUNT_CODES.INVENTORY_SHRINKAGE,
  EXPIRED: ACCOUNT_CODES.INVENTORY_SHRINKAGE,
  FOUND: ACCOUNT_CODES.INVENTORY_SHRINKAGE,
  COUNT_CORRECTION: ACCOUNT_CODES.INVENTORY_SHRINKAGE,
  // Goods consumed by the business are a running cost.
  INTERNAL_USE: '6900',
  OTHER: ACCOUNT_CODES.INVENTORY_SHRINKAGE,
};

export const REASON_LABELS: Record<AdjustmentReason, string> = {
  OPENING_STOCK: 'Opening stock',
  DAMAGED: 'Damaged',
  LOST: 'Lost or stolen',
  EXPIRED: 'Expired',
  FOUND: 'Found / extra stock',
  COUNT_CORRECTION: 'Stock count correction',
  INTERNAL_USE: 'Used in the business',
  OTHER: 'Other',
};

/** Reasons that only ever add stock, and those that only ever remove it. */
export const REASON_DEFAULT_DIRECTION: Record<AdjustmentReason, AdjustmentDirection | null> = {
  OPENING_STOCK: 'IN',
  FOUND: 'IN',
  DAMAGED: 'OUT',
  LOST: 'OUT',
  EXPIRED: 'OUT',
  INTERNAL_USE: 'OUT',
  COUNT_CORRECTION: null, // can go either way
  OTHER: null,
};

export interface AdjustmentItemInput {
  productId: number;
  direction: AdjustmentDirection;
  qty: Qty;
  /**
   * Required when adding stock — the value entering inventory. Ignored when
   * removing stock, where the cost basis comes from the weighted average.
   */
  totalCost?: Minor;
  note?: string | undefined;
}

export interface CreateAdjustmentInput {
  businessDate: string;
  reason: AdjustmentReason;
  note?: string | undefined;
  items: AdjustmentItemInput[];
  occurredAt?: Date;
  isDemo?: boolean;
}

export interface CreatedAdjustment {
  adjustmentId: number;
  adjustmentNo: string;
  journalEntryId: number;
  totalInValue: Minor;
  totalOutValue: Minor;
}

function accountIdByCode(tx: Tx, code: string): number {
  const account = tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code)).get();
  if (!account) throw new NotFoundError('Account', code);
  return account.id;
}

function allowNegativeStock(tx: Tx): boolean {
  const settings = tx
    .select({ allow: businessSettings.allowNegativeStock })
    .from(businessSettings)
    .where(eq(businessSettings.id, 1))
    .get();
  return settings?.allow ?? false;
}

export function createStockAdjustment(
  db: Db,
  input: CreateAdjustmentInput,
  actor: Actor,
): CreatedAdjustment {
  if (input.items.length === 0) {
    throw new ValidationError('Add at least one product to the adjustment.');
  }

  return writeTransaction(db, (tx) => {
    const occurredAt = input.occurredAt ?? new Date();
    const adjustmentNo = nextDocumentNumber(tx, DOC_TYPES.ADJUSTMENT);
    const allowNegative = allowNegativeStock(tx);

    const adjustment = tx
      .insert(stockAdjustments)
      .values({
        adjustmentNo,
        businessDate: input.businessDate,
        occurredAt,
        reason: input.reason,
        note: input.note ?? null,
        status: 'POSTED',
        createdBy: actor.id,
        isDemo: input.isDemo ?? false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .returning({ id: stockAdjustments.id })
      .get();

    if (!adjustment) throw new ConflictError('Could not create the stock adjustment.');

    const inValues: Minor[] = [];
    const outValues: Minor[] = [];

    for (const item of input.items) {
      if (item.qty <= 0) {
        throw new ValidationError('Every adjustment line needs a quantity greater than zero.');
      }
      if (item.direction === 'IN' && item.totalCost === undefined) {
        throw new ValidationError('Adding stock requires the value of the goods received.');
      }

      const movement = recordStockMovement(tx, {
        productId: item.productId,
        direction: item.direction,
        qty: item.qty,
        ...(item.totalCost !== undefined ? { totalCost: item.totalCost } : {}),
        // Opening stock is tagged distinctly in the ledger so it is never mixed
        // in with ordinary trading movements, which reports depend on.
        movementType:
          input.reason === 'OPENING_STOCK' && item.direction === 'IN'
            ? 'OPENING_STOCK'
            : item.direction === 'IN'
              ? 'ADJUSTMENT_IN'
              : 'ADJUSTMENT_OUT',
        sourceType: 'STOCK_ADJUSTMENT',
        sourceId: adjustment.id,
        sourceRef: adjustmentNo,
        businessDate: input.businessDate,
        occurredAt,
        userId: actor.id,
        note: item.note,
        allowNegative,
        isDemo: input.isDemo ?? false,
      });

      tx.insert(stockAdjustmentItems)
        .values({
          adjustmentId: adjustment.id,
          productId: item.productId,
          direction: item.direction,
          qtyMilli: item.qty,
          unitCostMinor: movement.unitCost,
          totalCostMinor: movement.totalCost,
          note: item.note ?? null,
          createdAt: occurredAt,
        })
        .run();

      if (item.direction === 'IN') inValues.push(movement.totalCost);
      else outValues.push(movement.totalCost);
    }

    const totalIn = sum(inValues);
    const totalOut = sum(outValues);

    const inventoryAccountId = accountIdByCode(tx, ACCOUNT_CODES.INVENTORY);
    const counterAccountId = accountIdByCode(tx, REASON_ACCOUNT[input.reason]);

    // Stock in  -> Dr Inventory,  Cr counter account
    // Stock out -> Dr counter account, Cr Inventory
    const lines: DraftLine[] = [];
    if (!isZero(totalIn)) {
      lines.push(
        debit(inventoryAccountId, totalIn, { description: `${REASON_LABELS[input.reason]} (in)` }),
        credit(counterAccountId, totalIn, { description: `${REASON_LABELS[input.reason]} (in)` }),
      );
    }
    if (!isZero(totalOut)) {
      lines.push(
        debit(counterAccountId, totalOut, {
          description: `${REASON_LABELS[input.reason]} (out)`,
        }),
        credit(inventoryAccountId, totalOut, {
          description: `${REASON_LABELS[input.reason]} (out)`,
        }),
      );
    }

    if (lines.length === 0) {
      // Every movement was valued at zero — real when writing off stock that
      // already carried no value. Nothing to post, and posting an empty entry
      // would fail the balance assertion.
      tx.update(stockAdjustments)
        .set({ updatedAt: occurredAt })
        .where(eq(stockAdjustments.id, adjustment.id))
        .run();

      writeAudit(tx, {
        action: 'CREATE',
        entityType: 'stock_adjustment',
        entityId: adjustment.id,
        userId: actor.id,
        username: actor.username,
        summary: `${adjustmentNo}: ${REASON_LABELS[input.reason]} (no value moved)`,
        metadata: { reason: input.reason, itemCount: input.items.length },
        at: occurredAt,
      });

      return {
        adjustmentId: adjustment.id,
        adjustmentNo,
        journalEntryId: 0,
        totalInValue: ZERO,
        totalOutValue: ZERO,
      };
    }

    const posted = postJournalEntry(
      tx,
      {
        entryDate: input.businessDate,
        sourceType: 'STOCK_ADJUSTMENT',
        sourceId: adjustment.id,
        memo: `${adjustmentNo} — ${REASON_LABELS[input.reason]}`,
        isOpening: input.reason === 'OPENING_STOCK',
        lines,
        occurredAt,
        isDemo: input.isDemo ?? false,
      },
      actor,
    );

    tx.update(stockAdjustments)
      .set({ journalEntryId: posted.entryId, updatedAt: occurredAt })
      .where(eq(stockAdjustments.id, adjustment.id))
      .run();

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'stock_adjustment',
      entityId: adjustment.id,
      userId: actor.id,
      username: actor.username,
      summary: `${adjustmentNo}: ${REASON_LABELS[input.reason]}, ${input.items.length} product(s)`,
      metadata: {
        reason: input.reason,
        totalInMinor: totalIn,
        totalOutMinor: totalOut,
        entryNo: posted.entryNo,
      },
      at: occurredAt,
    });

    return {
      adjustmentId: adjustment.id,
      adjustmentNo,
      journalEntryId: posted.entryId,
      totalInValue: totalIn,
      totalOutValue: totalOut,
    };
  });
}

/**
 * Void an adjustment by writing its opposite.
 *
 * The original document, its items and its ledger movements all remain exactly
 * as recorded. A new adjustment moves the stock back and a reversing journal
 * entry cancels the accounting effect, so the history shows both what was
 * recorded and that it was corrected.
 */
export function voidStockAdjustment(
  db: Db,
  adjustmentId: number,
  reason: string,
  actor: Actor,
  now: Date = new Date(),
): CreatedAdjustment {
  return writeTransaction(db, (tx) => {
    const original = tx
      .select()
      .from(stockAdjustments)
      .where(eq(stockAdjustments.id, adjustmentId))
      .get();

    if (!original) throw new NotFoundError('Stock adjustment', adjustmentId);
    if (original.status === 'VOIDED') {
      throw new ConflictError('That adjustment has already been voided.');
    }
    if (reason.trim().length < 3) {
      throw new ValidationError('Give a reason for voiding this adjustment.');
    }

    const items = tx
      .select()
      .from(stockAdjustmentItems)
      .where(eq(stockAdjustmentItems.adjustmentId, adjustmentId))
      .all();

    const businessDate = toBusinessDateString(now);
    const reversalNo = nextDocumentNumber(tx, DOC_TYPES.ADJUSTMENT);
    const allowNegative = allowNegativeStock(tx);

    /** Value the shelf could not keep. Posted below if it is not zero. */
    let costingResidual: Minor = ZERO;

    const reversal = tx
      .insert(stockAdjustments)
      .values({
        adjustmentNo: reversalNo,
        businessDate,
        occurredAt: now,
        reason: original.reason,
        note: `Void of ${original.adjustmentNo}: ${reason.trim()}`,
        status: 'POSTED',
        voidsAdjustmentId: adjustmentId,
        createdBy: actor.id,
        isDemo: original.isDemo,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: stockAdjustments.id })
      .get();

    if (!reversal) throw new ConflictError('Could not create the reversing adjustment.');

    for (const item of items) {
      /**
       * Opposite direction, at the ORIGINAL value in both directions.
       *
       * Putting stock back restores what left. Taking stock back out has to
       * remove what went in — and that half used to be left to the running
       * average, which by then may have moved on. The general ledger side is an
       * exact reversal of the original entry either way, so an average-costed
       * removal made the two counts of inventory disagree: opening stock of ten
       * bags at GHS 10, a delivery of ten at GHS 20, then void the opening
       * stock, and the shelf said GHS 150 while the accounts said GHS 200.
       */
      const opposite: AdjustmentDirection = item.direction === 'IN' ? 'OUT' : 'IN';

      const movement = recordStockMovement(tx, {
        productId: item.productId,
        direction: opposite,
        qty: item.qtyMilli as Qty,
        totalCost: minor(item.totalCostMinor),
        movementType: opposite === 'IN' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
        sourceType: 'STOCK_ADJUSTMENT_VOID',
        sourceId: reversal.id,
        sourceRef: reversalNo,
        businessDate,
        occurredAt: now,
        userId: actor.id,
        note: `Void of ${original.adjustmentNo}`,
        allowNegative,
        isDemo: original.isDemo,
      });

      tx.insert(stockAdjustmentItems)
        .values({
          adjustmentId: reversal.id,
          productId: item.productId,
          direction: opposite,
          qtyMilli: item.qtyMilli,
          unitCostMinor: movement.unitCost,
          totalCostMinor: movement.totalCost,
          note: `Void of ${original.adjustmentNo}`,
          createdAt: now,
        })
        .run();

      costingResidual = add(costingResidual, movement.residual);
    }

    let reversalEntryId = 0;
    if (original.journalEntryId !== null) {
      const reversed = reverseJournalEntry(
        tx,
        original.journalEntryId,
        {
          entryDate: businessDate,
          sourceType: 'STOCK_ADJUSTMENT',
          sourceId: reversal.id,
          memo: `Void of ${original.adjustmentNo}: ${reason.trim()}`,
          occurredAt: now,
        },
        actor,
      );
      reversalEntryId = reversed.entryId;

      tx.update(stockAdjustments)
        .set({ journalEntryId: reversed.entryId, updatedAt: now })
        .where(eq(stockAdjustments.id, reversal.id))
        .run();
    }

    /**
     * Value the shelf could not keep, posted as its own entry.
     *
     * Emptying a product at the value that originally went in can leave the
     * running value short of, or over, zero, because the average moved on in
     * between. Zero quantity must mean zero value, so the difference leaves
     * inventory — and it has to leave the general ledger with it, or the stock
     * ledger and the accounts stop agreeing.
     */
    if (!isZero(costingResidual)) {
      postJournalEntry(
        tx,
        {
          entryDate: businessDate,
          sourceType: 'STOCK_ADJUSTMENT',
          sourceId: reversal.id,
          memo: `Stock costing difference on voiding ${original.adjustmentNo}`,
          occurredAt: now,
          lines:
            costingResidual > 0
              ? [
                  debit(accountIdByCode(tx, ACCOUNT_CODES.COST_OF_GOODS_SOLD), costingResidual, {
                    description: `${reversalNo} costing difference`,
                  }),
                  credit(accountIdByCode(tx, ACCOUNT_CODES.INVENTORY), costingResidual, {
                    description: `${reversalNo} stock value released`,
                  }),
                ]
              : [
                  debit(accountIdByCode(tx, ACCOUNT_CODES.INVENTORY), minor(-costingResidual), {
                    description: `${reversalNo} stock value restored`,
                  }),
                  credit(
                    accountIdByCode(tx, ACCOUNT_CODES.COST_OF_GOODS_SOLD),
                    minor(-costingResidual),
                    { description: `${reversalNo} costing difference` },
                  ),
                ],
        },
        actor,
      );
    }

    tx.update(stockAdjustments)
      .set({
        status: 'VOIDED',
        voidedAt: now,
        voidReason: reason.trim(),
        voidedByAdjustmentId: reversal.id,
        updatedAt: now,
      })
      .where(eq(stockAdjustments.id, adjustmentId))
      .run();

    writeAudit(tx, {
      action: 'VOID',
      entityType: 'stock_adjustment',
      entityId: adjustmentId,
      userId: actor.id,
      username: actor.username,
      summary: `Voided ${original.adjustmentNo} with ${reversalNo}`,
      metadata: { reason: reason.trim(), reversalId: reversal.id },
      at: now,
    });

    return {
      adjustmentId: reversal.id,
      adjustmentNo: reversalNo,
      journalEntryId: reversalEntryId,
      totalInValue: ZERO,
      totalOutValue: ZERO,
    };
  });
}

function toBusinessDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// --- reads ----------------------------------------------------------------

export function listStockAdjustments(db: Db, limit = 50, offset = 0) {
  return db
    .select()
    .from(stockAdjustments)
    .orderBy(desc(stockAdjustments.occurredAt), desc(stockAdjustments.id))
    .limit(Math.min(limit, 200))
    .offset(offset)
    .all();
}

export function getStockAdjustment(db: Db, adjustmentId: number) {
  const adjustment = db
    .select()
    .from(stockAdjustments)
    .where(eq(stockAdjustments.id, adjustmentId))
    .get();
  if (!adjustment) throw new NotFoundError('Stock adjustment', adjustmentId);

  const items = db
    .select({
      id: stockAdjustmentItems.id,
      productId: stockAdjustmentItems.productId,
      productName: products.name,
      unit: products.unit,
      direction: stockAdjustmentItems.direction,
      qtyMilli: stockAdjustmentItems.qtyMilli,
      unitCostMinor: stockAdjustmentItems.unitCostMinor,
      totalCostMinor: stockAdjustmentItems.totalCostMinor,
      note: stockAdjustmentItems.note,
    })
    .from(stockAdjustmentItems)
    .innerJoin(products, eq(products.id, stockAdjustmentItems.productId))
    .where(eq(stockAdjustmentItems.adjustmentId, adjustmentId))
    .all();

  return { adjustment, items };
}

/** Human-readable summary line for a list row. */
export function describeAdjustment(items: { direction: string; qtyMilli: number }[]): string {
  const inCount = items.filter((item) => item.direction === 'IN').length;
  const outCount = items.length - inCount;
  const parts: string[] = [];
  if (inCount > 0) parts.push(`${inCount} in`);
  if (outCount > 0) parts.push(`${outCount} out`);
  return parts.join(', ') || 'no items';
}
