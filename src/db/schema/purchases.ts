import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import {
  businessDate,
  createdAt,
  isDemo,
  moneyMinor,
  qtyMilli,
  timestampMs,
  updatedAt,
} from './_shared';
import { oneOf } from './_check';
import { journalEntries, paymentAccounts } from './accounting';
import { products } from './catalog';
import { suppliers } from './suppliers';
import { users } from './users';

export const PURCHASE_STATUSES = ['POSTED', 'VOIDED'] as const;

/**
 * What kind of document this row is.
 *
 * A return is a genuine business event and a void is a correction, so they are
 * distinguished explicitly rather than inferred from which link column happens
 * to be set. Reports can then separate real returns from mistakes.
 */
export const PURCHASE_KINDS = ['PURCHASE', 'RETURN', 'VOID'] as const;

export const purchases = sqliteTable(
  'purchases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    purchaseNo: text('purchase_no').notNull(),

    kind: text('kind', { enum: PURCHASE_KINDS }).notNull().default('PURCHASE'),

    supplierId: integer('supplier_id').references(() => suppliers.id, { onDelete: 'restrict' }),

    businessDate: businessDate('business_date').notNull(),
    occurredAt: timestampMs('occurred_at').notNull(),

    /** The supplier's own invoice number, for matching against their paperwork. */
    invoiceNo: text('invoice_no'),

    subtotalMinor: moneyMinor('subtotal_minor').notNull(),
    discountMinor: moneyMinor('discount_minor').notNull().default(0),
    taxMinor: moneyMinor('tax_minor').notNull().default(0),
    totalMinor: moneyMinor('total_minor').notNull(),

    status: text('status', { enum: PURCHASE_STATUSES }).notNull().default('POSTED'),

    journalEntryId: integer('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    /** Links a RETURN or VOID document back to the purchase it relates to. */
    returnsPurchaseId: integer('returns_purchase_id'),
    voidsPurchaseId: integer('voids_purchase_id'),
    voidedByPurchaseId: integer('voided_by_purchase_id'),
    voidedAt: timestampMs('voided_at'),
    voidReason: text('void_reason'),

    note: text('note'),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_purchases_no').on(t.purchaseNo),
    index('idx_purchases_date').on(t.businessDate),
    index('idx_purchases_supplier').on(t.supplierId),
    index('idx_purchases_status').on(t.status),
    index('idx_purchases_kind').on(t.kind),

    check('ck_purchases_status', oneOf(t.status, PURCHASE_STATUSES)),
    check('ck_purchases_kind', oneOf(t.kind, PURCHASE_KINDS)),
    check(
      'ck_purchases_date_format',
      sql`${t.businessDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
    check(
      'ck_purchases_total_arithmetic',
      sql`${t.totalMinor} = ${t.subtotalMinor} - ${t.discountMinor} + ${t.taxMinor}`,
    ),
    check(
      'ck_purchases_not_self_voiding',
      sql`${t.voidsPurchaseId} IS NULL OR ${t.voidsPurchaseId} <> ${t.id}`,
    ),
    check(
      'ck_purchases_not_self_returning',
      sql`${t.returnsPurchaseId} IS NULL OR ${t.returnsPurchaseId} <> ${t.id}`,
    ),
  ],
);

export const purchaseItems = sqliteTable(
  'purchase_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    purchaseId: integer('purchase_id')
      .notNull()
      .references(() => purchases.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),

    productName: text('product_name').notNull(),
    unit: text('unit').notNull(),

    qtyMilli: qtyMilli('qty_milli').notNull(),
    /** What the shop actually paid per unit on this purchase. */
    unitCostMinor: moneyMinor('unit_cost_minor').notNull(),
    discountMinor: moneyMinor('discount_minor').notNull().default(0),
    /** qty x unitCost - discount. The exact value added to inventory. */
    lineTotalMinor: moneyMinor('line_total_minor').notNull(),

    /** For a return line: how many of these were sent back. */
    returnedQtyMilli: qtyMilli('returned_qty_milli').notNull().default(0),

    createdAt: createdAt(),
  },
  (t) => [
    index('idx_purchase_items_purchase').on(t.purchaseId),
    index('idx_purchase_items_product').on(t.productId),
    uniqueIndex('uq_purchase_items_purchase_line').on(t.purchaseId, t.lineNo),
    check('ck_purchase_items_qty_nonzero', sql`${t.qtyMilli} <> 0`),
    check('ck_purchase_items_returned_nonneg', sql`${t.returnedQtyMilli} >= 0`),
  ],
);

/** Money paid AT THE TIME of the purchase, one row per method. */
export const purchasePayments = sqliteTable(
  'purchase_payments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    purchaseId: integer('purchase_id')
      .notNull()
      .references(() => purchases.id, { onDelete: 'cascade' }),

    paymentAccountId: integer('payment_account_id')
      .notNull()
      .references(() => paymentAccounts.id, { onDelete: 'restrict' }),

    amountMinor: moneyMinor('amount_minor').notNull(),
    reference: text('reference'),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_purchase_payments_purchase').on(t.purchaseId),
    check('ck_purchase_payments_amount_nonzero', sql`${t.amountMinor} <> 0`),
  ],
);

export const SUPPLIER_PAYMENT_STATUSES = ['POSTED', 'VOIDED'] as const;

/** Money paid to a supplier AFTER the purchase, settling what is owed. */
export const supplierPayments = sqliteTable(
  'supplier_payments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    paymentNo: text('payment_no').notNull(),

    supplierId: integer('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),

    businessDate: businessDate('business_date').notNull(),
    occurredAt: timestampMs('occurred_at').notNull(),

    paymentAccountId: integer('payment_account_id')
      .notNull()
      .references(() => paymentAccounts.id, { onDelete: 'restrict' }),

    amountMinor: moneyMinor('amount_minor').notNull(),
    reference: text('reference'),
    note: text('note'),

    status: text('status', { enum: SUPPLIER_PAYMENT_STATUSES }).notNull().default('POSTED'),
    journalEntryId: integer('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    voidedAt: timestampMs('voided_at'),
    voidReason: text('void_reason'),

    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_supplier_payments_no').on(t.paymentNo),
    index('idx_supplier_payments_supplier').on(t.supplierId),
    index('idx_supplier_payments_date').on(t.businessDate),
    check('ck_supplier_payments_status', oneOf(t.status, SUPPLIER_PAYMENT_STATUSES)),
    check('ck_supplier_payments_amount_positive', sql`${t.amountMinor} > 0`),
    check(
      'ck_supplier_payments_date_format',
      sql`${t.businessDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
  ],
);

export const supplierPaymentAllocations = sqliteTable(
  'supplier_payment_allocations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    paymentId: integer('payment_id')
      .notNull()
      .references(() => supplierPayments.id, { onDelete: 'cascade' }),
    purchaseId: integer('purchase_id')
      .notNull()
      .references(() => purchases.id, { onDelete: 'restrict' }),

    amountMinor: moneyMinor('amount_minor').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_supplier_payment_allocations_payment').on(t.paymentId),
    index('idx_supplier_payment_allocations_purchase').on(t.purchaseId),
    uniqueIndex('uq_supplier_payment_allocations').on(t.paymentId, t.purchaseId),
    check('ck_supplier_payment_allocations_amount_nonzero', sql`${t.amountMinor} <> 0`),
  ],
);

export type Purchase = typeof purchases.$inferSelect;
export type PurchaseItem = typeof purchaseItems.$inferSelect;
export type PurchasePayment = typeof purchasePayments.$inferSelect;
export type SupplierPayment = typeof supplierPayments.$inferSelect;
export type PurchaseKind = (typeof PURCHASE_KINDS)[number];
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];
