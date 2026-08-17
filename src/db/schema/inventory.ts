import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { businessDate, createdAt, isDemo, moneyMinor, qtyMilli, timestampMs, updatedAt } from './_shared';
import { oneOf } from './_check';
import { journalEntries } from './accounting';
import { products } from './catalog';
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

export type StockLedgerRow = typeof stockLedger.$inferSelect;
export type NewStockLedgerRow = typeof stockLedger.$inferInsert;
export type StockAdjustment = typeof stockAdjustments.$inferSelect;
export type StockAdjustmentItem = typeof stockAdjustmentItems.$inferSelect;
export type MovementType = (typeof MOVEMENT_TYPES)[number];
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];
export type AdjustmentDirection = (typeof ADJUSTMENT_DIRECTIONS)[number];
export type AdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number];
