import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  boolean,
  businessDate,
  createdAt,
  isDemo,
  moneyMinor,
  qtyMilli,
  timestampMs,
  updatedAt,
} from './_shared';
import { oneOf } from './_check';
import { journalEntries } from './accounting';
import { products } from './catalog';
import { suppliers } from './suppliers';
import { users } from './users';

/** Why stock moved. Every ledger row names one. */
export const MOVEMENT_TYPES = [
  'OPENING_STOCK',
  'PURCHASE',
  'PURCHASE_RETURN',
  'SALE',
  'SALE_RETURN',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
] as const;

/**
 * The stock ledger — append-only, one row per movement, the SOURCE OF TRUTH for
 * inventory.
 *
 * `balanceQtyMilli` and `balanceValueMinor` are the running (quantity, value)
 * pair AFTER this movement, so any historical stock position is a single row
 * lookup and the whole chain can be recomputed from the first movement to prove
 * the product cache.
 *
 * Nothing in the application updates or deletes a row here. A mistake is
 * corrected by appending a reversing movement.
 */
export const stockLedger = sqliteTable(
  'stock_ledger',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),

    /** Shop-local business day this movement belongs to. */
    businessDate: businessDate('business_date').notNull(),
    occurredAt: timestampMs('occurred_at').notNull(),

    movementType: text('movement_type', { enum: MOVEMENT_TYPES }).notNull(),

    /** The document that caused it, e.g. 'STOCK_ADJUSTMENT' + its id. */
    sourceType: text('source_type').notNull(),
    sourceId: integer('source_id'),
    /** Human-facing reference such as 'ADJ-00007'. */
    sourceRef: text('source_ref'),

    qtyInMilli: qtyMilli('qty_in_milli').notNull().default(0),
    qtyOutMilli: qtyMilli('qty_out_milli').notNull().default(0),

    /**
     * `totalCostMinor` is the EXACT value that entered or left inventory and is
     * what the ledger arithmetic uses. `unitCostMinor` is a rounded per-unit
     * figure for display only — deriving cost from it would reintroduce drift.
     */
    unitCostMinor: moneyMinor('unit_cost_minor').notNull().default(0),
    totalCostMinor: moneyMinor('total_cost_minor').notNull().default(0),

    balanceQtyMilli: qtyMilli('balance_qty_milli').notNull(),
    balanceValueMinor: moneyMinor('balance_value_minor').notNull(),

    note: text('note'),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),

    isDemo: isDemo(),
    createdAt: createdAt(),
  },
  (t) => [
    // The chain-walk index: every movement for a product in insertion order.
    index('idx_stock_ledger_product').on(t.productId, t.id),
    index('idx_stock_ledger_date').on(t.businessDate),
    index('idx_stock_ledger_occurred').on(t.occurredAt),
    index('idx_stock_ledger_source').on(t.sourceType, t.sourceId),
    index('idx_stock_ledger_movement').on(t.movementType),

    check('ck_stock_ledger_movement_type', oneOf(t.movementType, MOVEMENT_TYPES)),
    check('ck_stock_ledger_qty_in_nonneg', sql`${t.qtyInMilli} >= 0`),
    check('ck_stock_ledger_qty_out_nonneg', sql`${t.qtyOutMilli} >= 0`),
    // Exactly one direction per row — never both, never neither.
    check(
      'ck_stock_ledger_one_direction',
      sql`(${t.qtyInMilli} > 0 AND ${t.qtyOutMilli} = 0) OR (${t.qtyInMilli} = 0 AND ${t.qtyOutMilli} > 0)`,
    ),
    check(
      'ck_stock_ledger_date_format',
      sql`${t.businessDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
    // Holding zero quantity must mean holding zero value.
    check(
      'ck_stock_ledger_zero_qty_zero_value',
      sql`${t.balanceQtyMilli} <> 0 OR ${t.balanceValueMinor} = 0`,
    ),
  ],
);

export const ADJUSTMENT_REASONS = [
  'OPENING_STOCK',
  'DAMAGED',
  'LOST',
  'EXPIRED',
  'FOUND',
  'COUNT_CORRECTION',
  'INTERNAL_USE',
  'OTHER',
] as const;

export const ADJUSTMENT_STATUSES = ['POSTED', 'VOIDED'] as const;

/**
 * A stock adjustment document. Groups one or more product movements under a
 * single reason and a single balanced journal entry.
 */
export const stockAdjustments = sqliteTable(
  'stock_adjustments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    adjustmentNo: text('adjustment_no').notNull(),

    businessDate: businessDate('business_date').notNull(),
    occurredAt: timestampMs('occurred_at').notNull(),

    reason: text('reason', { enum: ADJUSTMENT_REASONS }).notNull(),
    note: text('note'),

    status: text('status', { enum: ADJUSTMENT_STATUSES }).notNull().default('POSTED'),

    /** The balanced entry this document produced. */
    journalEntryId: integer('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    /** Void linkage — the original is never edited or deleted. */
    voidedByAdjustmentId: integer('voided_by_adjustment_id'),
    voidsAdjustmentId: integer('voids_adjustment_id'),
    voidedAt: timestampMs('voided_at'),
    voidReason: text('void_reason'),

    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_stock_adjustments_no').on(t.adjustmentNo),
    index('idx_stock_adjustments_date').on(t.businessDate),
    index('idx_stock_adjustments_status').on(t.status),
    index('idx_stock_adjustments_reason').on(t.reason),

    check('ck_stock_adjustments_reason', oneOf(t.reason, ADJUSTMENT_REASONS)),
    check('ck_stock_adjustments_status', oneOf(t.status, ADJUSTMENT_STATUSES)),
    check(
      'ck_stock_adjustments_date_format',
      sql`${t.businessDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
    check(
      'ck_stock_adjustments_not_self_voiding',
      sql`${t.voidsAdjustmentId} IS NULL OR ${t.voidsAdjustmentId} <> ${t.id}`,
    ),
  ],
);

export const ADJUSTMENT_DIRECTIONS = ['IN', 'OUT'] as const;

export const stockAdjustmentItems = sqliteTable(
  'stock_adjustment_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    adjustmentId: integer('adjustment_id')
      .notNull()
      .references(() => stockAdjustments.id, { onDelete: 'cascade' }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),

    direction: text('direction', { enum: ADJUSTMENT_DIRECTIONS }).notNull(),
    qtyMilli: qtyMilli('qty_milli').notNull(),

    /** Snapshot of the cost basis actually applied at the time. */
    unitCostMinor: moneyMinor('unit_cost_minor').notNull().default(0),
    totalCostMinor: moneyMinor('total_cost_minor').notNull().default(0),

    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_stock_adjustment_items_adjustment').on(t.adjustmentId),
    index('idx_stock_adjustment_items_product').on(t.productId),
    check('ck_stock_adjustment_items_direction', oneOf(t.direction, ADJUSTMENT_DIRECTIONS)),
    check('ck_stock_adjustment_items_qty_positive', sql`${t.qtyMilli} > 0`),
    check('ck_stock_adjustment_items_cost_nonneg', sql`${t.totalCostMinor} >= 0`),
  ],
);

/**
 * A batch: a quantity of one product that arrived together and runs out together.
 *
 * ---------------------------------------------------------------------------
 * A BATCH TRACKS QUANTITY. IT NEVER TRACKS COST.
 *
 * Inventory is valued by weighted average, pooled across all stock of a product,
 * and no per-unit average is ever stored — see `src/domain/inventory/costing.ts`.
 * Batches run ALONGSIDE that and answer a different question:
 *
 *   What is this stock worth?    -> stock_ledger, quantity AND value
 *   Which physical units left?   -> here, and stock_ledger_batches
 *
 * Nothing in the costing engine changes because of this table. The cost of a
 * unit sold is still the running average, whichever batch it came out of. That
 * is what makes expiry tracking affordable: no re-costing, no migration of
 * historical value, and no report that reads money has to change at all.
 *
 * The price of that decision, stated plainly: per-batch MARGIN does not exist
 * and cannot be added later without abandoning weighted average. What batches
 * buy instead is first-expiry-first-out, a warning before goods turn, and a
 * trace from a bad delivery to the customers who bought from it.
 * ---------------------------------------------------------------------------
 */
export const productBatches = sqliteTable(
  'product_batches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),

    /** 'BAT-00041'. From the sequence service, like every other document. */
    batchRef: text('batch_ref').notNull(),

    /**
     * NULL means "does not expire" — cement, hardware, and the opening batch
     * every stocked product receives at migration. Undated stock never warns,
     * and is picked only after everything dated that has not yet passed.
     */
    expiryDate: businessDate('expiry_date'),
    receivedDate: businessDate('received_date').notNull(),

    /**
     * Cached remaining quantity, exactly as `products.qtyOnHandMilli` is a
     * cache. The truth is this batch's rows in `stock_ledger_batches`, and
     * `verifyProductBatches` proves the one against the other.
     *
     * May go negative, but only where the shop has allowed negative stock.
     */
    qtyMilli: qtyMilli('qty_milli').notNull().default(0),

    /**
     * What this batch began with, before any movement was allocated to it.
     *
     * Zero for every batch the application opens: those start empty and are
     * filled by their own `stock_ledger_batches` rows, so the allocations are
     * the whole story.
     *
     * Non-zero only for the OPENING batches the migration creates, whose stock
     * arrived before batches existed and therefore has no allocations to
     * replay. Recording it makes `qtyMilli = openingQtyMilli + in - out` a real
     * check for every batch rather than a tautology for those.
     */
    openingQtyMilli: qtyMilli('opening_qty_milli').notNull().default(0),

    /** 'PURCHASE' and its id, or 'OPENING', or 'ADJUSTMENT'. */
    sourceType: text('source_type').notNull(),
    sourceId: integer('source_id'),

    /** For a recall: whose delivery was this? */
    supplierId: integer('supplier_id').references(() => suppliers.id, { onDelete: 'set null' }),

    /** Overrides the shop-wide warning window. Null uses the setting. */
    warnDays: integer('warn_days'),

    note: text('note'),

    /**
     * Set when the batch empties. Kept, never deleted: the ledger points at it,
     * and a recall asks about batches that are long gone.
     */
    isClosed: boolean('is_closed').notNull().default(false),

    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_product_batches_ref').on(t.batchRef),
    // The picking order reads this one: a product, earliest date first.
    index('idx_product_batches_product').on(t.productId, t.expiryDate),
    index('idx_product_batches_expiry').on(t.expiryDate),
    index('idx_product_batches_open').on(t.productId, t.isClosed),
    // "Which batch did this purchase open?" — what a supplier return asks.
    index('idx_product_batches_source').on(t.sourceType, t.sourceId),

    check('ck_product_batches_ref', sql`length(trim(${t.batchRef})) > 0`),
    check(
      'ck_product_batches_expiry_format',
      sql`${t.expiryDate} IS NULL OR ${t.expiryDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
    check(
      'ck_product_batches_received_format',
      sql`${t.receivedDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
    check('ck_product_batches_warn_days', sql`${t.warnDays} IS NULL OR ${t.warnDays} >= 0`),
    // A closed batch holds nothing — the same shape of rule as
    // `ck_products_zero_qty_zero_value`, and for the same reason.
    check('ck_product_batches_closed_is_empty', sql`${t.isClosed} = 0 OR ${t.qtyMilli} = 0`),
  ],
);

/**
 * Which batches one stock movement touched, and by how much.
 *
 * Hung off the LEDGER ROW rather than off a sale line, so a single table covers
 * sales, purchases, both kinds of return, both kinds of void and adjustments —
 * and sits beside the thing that is already the source of truth for stock.
 *
 * The recall question, "which documents drew from this batch?", is then one join
 * through `stock_ledger.sourceType` and `sourceId`.
 *
 * Append-only, like the ledger it hangs from.
 */
export const stockLedgerBatches = sqliteTable(
  'stock_ledger_batches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    ledgerId: integer('ledger_id')
      .notNull()
      .references(() => stockLedger.id, { onDelete: 'restrict' }),
    batchId: integer('batch_id')
      .notNull()
      .references(() => productBatches.id, { onDelete: 'restrict' }),

    qtyInMilli: qtyMilli('qty_in_milli').notNull().default(0),
    qtyOutMilli: qtyMilli('qty_out_milli').notNull().default(0),

    createdAt: createdAt(),
  },
  (t) => [
    // One movement touches a given batch once. A second allocation to the same
    // batch would be a double count that nothing downstream could unpick.
    uniqueIndex('uq_stock_ledger_batches').on(t.ledgerId, t.batchId),
    index('idx_stock_ledger_batches_batch').on(t.batchId),
    // The same one-direction rule the ledger itself enforces.
    check(
      'ck_stock_ledger_batches_one_direction',
      sql`(${t.qtyInMilli} > 0 AND ${t.qtyOutMilli} = 0)
       OR (${t.qtyInMilli} = 0 AND ${t.qtyOutMilli} > 0)`,
    ),
  ],
);

export type ProductBatch = typeof productBatches.$inferSelect;
export type NewProductBatch = typeof productBatches.$inferInsert;
export type StockLedgerBatch = typeof stockLedgerBatches.$inferSelect;

export type StockLedgerRow = typeof stockLedger.$inferSelect;
export type NewStockLedgerRow = typeof stockLedger.$inferInsert;
export type StockAdjustment = typeof stockAdjustments.$inferSelect;
export type StockAdjustmentItem = typeof stockAdjustmentItems.$inferSelect;
export type MovementType = (typeof MOVEMENT_TYPES)[number];
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];
export type AdjustmentDirection = (typeof ADJUSTMENT_DIRECTIONS)[number];
export type AdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number];
