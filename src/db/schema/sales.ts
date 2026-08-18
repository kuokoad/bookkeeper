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
import { customers } from './parties';
import { users } from './users';

export const SALE_STATUSES = ['POSTED', 'VOIDED'] as const;

/**
 * What kind of document this row is.
 *
 * A RETURN is a genuine business event (the customer brought goods back); a
 * VOID is a correction of a mistake. Distinguishing them explicitly, rather
 * than inferring from which link column is set, lets reports separate real
 * returns from data-entry errors.
 */
export const SALE_KINDS = ['SALE', 'RETURN', 'VOID'] as const;

/**
 * A completed sale.
 *
 * Money figures here are FACTS OF THE DOCUMENT — what was charged, what was
 * tendered at the till, what the goods cost. They are not running balances.
 * What is still owed is derived from the tender plus any later customer
 * payments allocated to this sale, so it can never drift out of step with the
 * ledger.
 */
export const sales = sqliteTable(
  'sales',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    receiptNo: text('receipt_no').notNull(),

    kind: text('kind', { enum: SALE_KINDS }).notNull().default('SALE'),
    /** Links a RETURN document back to the sale the goods came from. */
    returnsSaleId: integer('returns_sale_id'),

    businessDate: businessDate('business_date').notNull(),

    /**
     * Invoice identity, for a credit sale that a customer takes away to pay
     * against. Null on a sale paid in full at the counter — that gets a receipt
     * and needs no invoice, and issuing numbers for both would leave gaps in
     * the invoice sequence that look like missing documents.
     */
    invoiceNo: text('invoice_no'),
    /** Days allowed to pay, snapshotted so a later change to the shop default
     *  cannot silently move an invoice already issued. */
    termsDays: integer('terms_days'),
    dueDate: businessDate('due_date'),
    occurredAt: timestampMs('occurred_at').notNull(),

    /** NULL for a walk-in cash customer, which is most sales in a small shop. */
    customerId: integer('customer_id').references(() => customers.id, { onDelete: 'restrict' }),

    /** Sum of line totals BEFORE any invoice-level discount. */
    subtotalMinor: moneyMinor('subtotal_minor').notNull(),
    /** Invoice-level discount, on top of any per-line discounts. */
    discountMinor: moneyMinor('discount_minor').notNull().default(0),
    taxMinor: moneyMinor('tax_minor').notNull().default(0),
    /** subtotal - discount + tax. What the customer owes for this sale. */
    totalMinor: moneyMinor('total_minor').notNull(),

    /**
     * Cost of the goods sold, snapshotted at the moment of sale from the
     * weighted-average engine. Profit is `total - cogs`, and editing a
     * product's cost tomorrow cannot change it.
     */
    cogsMinor: moneyMinor('cogs_minor').notNull().default(0),

    status: text('status', { enum: SALE_STATUSES }).notNull().default('POSTED'),

    journalEntryId: integer('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    /** Void linkage — the original sale is never edited or deleted. */
    voidedBySaleId: integer('voided_by_sale_id'),
    voidsSaleId: integer('voids_sale_id'),
    voidedAt: timestampMs('voided_at'),
    voidReason: text('void_reason'),

    note: text('note'),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_sales_receipt_no').on(t.receiptNo),
    // SQLite permits many NULLs in a unique index, so cash sales do not collide.
    uniqueIndex('uq_sales_invoice_no').on(t.invoiceNo),
    index('idx_sales_due_date').on(t.dueDate),
    index('idx_sales_date').on(t.businessDate),
    index('idx_sales_customer').on(t.customerId),
    index('idx_sales_status').on(t.status),
    index('idx_sales_occurred').on(t.occurredAt),

    check('ck_sales_status', oneOf(t.status, SALE_STATUSES)),
    check(
      'ck_sales_date_format',
      sql`${t.businessDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
    check('ck_sales_discount_nonneg', sql`${t.discountMinor} >= 0`),
    check('ck_sales_tax_nonneg', sql`${t.taxMinor} >= 0`),
    // A void sale mirrors the original, so totals may be negative; only the
    // arithmetic relationship must always hold.
    check(
      'ck_sales_total_arithmetic',
      sql`${t.totalMinor} = ${t.subtotalMinor} - ${t.discountMinor} + ${t.taxMinor}`,
    ),
    check('ck_sales_not_self_voiding', sql`${t.voidsSaleId} IS NULL OR ${t.voidsSaleId} <> ${t.id}`),
    check('ck_sales_kind', oneOf(t.kind, SALE_KINDS)),
    check(
      'ck_sales_not_self_returning',
      sql`${t.returnsSaleId} IS NULL OR ${t.returnsSaleId} <> ${t.id}`,
    ),
  ],
);

export const saleItems = sqliteTable(
  'sale_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    saleId: integer('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),

    /**
     * Name and unit are snapshotted so a receipt reprinted next year shows what
     * was actually sold, even if the product has since been renamed.
     */
    productName: text('product_name').notNull(),
    unit: text('unit').notNull(),

    qtyMilli: qtyMilli('qty_milli').notNull(),
    /** Selling price at the moment of sale, not today's price. */
    unitPriceMinor: moneyMinor('unit_price_minor').notNull(),
    discountMinor: moneyMinor('discount_minor').notNull().default(0),
    /** qty x unitPrice - discount */
    lineTotalMinor: moneyMinor('line_total_minor').notNull(),

    /** Rounded per-unit cost, for display on reports. */
    unitCostMinor: moneyMinor('unit_cost_minor').notNull().default(0),
    /** EXACT cost released from inventory for this line. The profit basis. */
    totalCostMinor: moneyMinor('total_cost_minor').notNull().default(0),

    /**
     * How much of this line has since come back. Prevents a customer returning
     * more than they bought across several separate returns.
     */
    returnedQtyMilli: qtyMilli('returned_qty_milli').notNull().default(0),

    createdAt: createdAt(),
  },
  (t) => [
    index('idx_sale_items_sale').on(t.saleId),
    index('idx_sale_items_product').on(t.productId),
    uniqueIndex('uq_sale_items_sale_line').on(t.saleId, t.lineNo),
    check('ck_sale_items_qty_nonzero', sql`${t.qtyMilli} <> 0`),
    check('ck_sale_items_price_nonneg', sql`${t.unitPriceMinor} >= 0`),
    check('ck_sale_items_discount_nonneg', sql`${t.discountMinor} >= 0`),
    check('ck_sale_items_returned_nonneg', sql`${t.returnedQtyMilli} >= 0`),
  ],
);

/**
 * Money tendered AT THE TILL, one row per method.
 *
 * Several rows mean a split payment — part cash, part MoMo. Money received
 * later against a credit sale is a separate customer payment, not a row here.
 */
export const salePayments = sqliteTable(
  'sale_payments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    saleId: integer('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),

    paymentAccountId: integer('payment_account_id')
      .notNull()
      .references(() => paymentAccounts.id, { onDelete: 'restrict' }),

    amountMinor: moneyMinor('amount_minor').notNull(),
    /** MoMo transaction id, cheque number, and so on. */
    reference: text('reference'),

    createdAt: createdAt(),
  },
  (t) => [
    index('idx_sale_payments_sale').on(t.saleId),
    index('idx_sale_payments_account').on(t.paymentAccountId),
    check('ck_sale_payments_amount_nonzero', sql`${t.amountMinor} <> 0`),
  ],
);

export const CUSTOMER_PAYMENT_STATUSES = ['POSTED', 'VOIDED'] as const;

/** Money received from a customer AFTER the sale, settling what they owe. */
export const customerPayments = sqliteTable(
  'customer_payments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    paymentNo: text('payment_no').notNull(),

    customerId: integer('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),

    businessDate: businessDate('business_date').notNull(),
    occurredAt: timestampMs('occurred_at').notNull(),

    paymentAccountId: integer('payment_account_id')
      .notNull()
      .references(() => paymentAccounts.id, { onDelete: 'restrict' }),

    amountMinor: moneyMinor('amount_minor').notNull(),
    reference: text('reference'),
    note: text('note'),

    status: text('status', { enum: CUSTOMER_PAYMENT_STATUSES }).notNull().default('POSTED'),
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
    uniqueIndex('uq_customer_payments_no').on(t.paymentNo),
    index('idx_customer_payments_customer').on(t.customerId),
    index('idx_customer_payments_date').on(t.businessDate),
    index('idx_customer_payments_status').on(t.status),
    check('ck_customer_payments_status', oneOf(t.status, CUSTOMER_PAYMENT_STATUSES)),
    check('ck_customer_payments_amount_positive', sql`${t.amountMinor} > 0`),
    check(
      'ck_customer_payments_date_format',
      sql`${t.businessDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
  ],
);

/**
 * Which sales a customer payment settles.
 *
 * Allocating explicitly means a customer with several unpaid sales can say
 * which one they are paying, and each sale's outstanding amount stays
 * answerable rather than being guessed from a single running balance.
 */
export const customerPaymentAllocations = sqliteTable(
  'customer_payment_allocations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    paymentId: integer('payment_id')
      .notNull()
      .references(() => customerPayments.id, { onDelete: 'cascade' }),
    saleId: integer('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'restrict' }),

    amountMinor: moneyMinor('amount_minor').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_customer_payment_allocations_payment').on(t.paymentId),
    index('idx_customer_payment_allocations_sale').on(t.saleId),
    uniqueIndex('uq_customer_payment_allocations').on(t.paymentId, t.saleId),
    check('ck_customer_payment_allocations_amount_nonzero', sql`${t.amountMinor} <> 0`),
  ],
);

export type Sale = typeof sales.$inferSelect;
export type NewSale = typeof sales.$inferInsert;
export type SaleItem = typeof saleItems.$inferSelect;
export type SalePayment = typeof salePayments.$inferSelect;
export type CustomerPayment = typeof customerPayments.$inferSelect;
export type CustomerPaymentAllocation = typeof customerPaymentAllocations.$inferSelect;
export type SaleStatus = (typeof SALE_STATUSES)[number];
export type SaleKind = (typeof SALE_KINDS)[number];
