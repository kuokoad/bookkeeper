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
import { customers } from './parties';
import { products } from './catalog';
import { sales } from './sales';
import { users } from './users';

/**
 * A quotation is a PROPOSAL, not an accounting record.
 *
 * That single sentence decides everything below it. Nothing here posts to the
 * journal, moves stock, or reserves a single bag of cement. A quote becomes real
 * only when it converts, and conversion is an ordinary sale.
 *
 * So there are no cost columns on these tables — no unit cost, no cost of sale,
 * no returned quantity. Every one of those describes goods that have left the
 * shop, and nothing has left the shop. A quote that carried a cost basis would
 * be claiming something untrue about the stock room.
 *
 * It also means a quote can be edited freely while it is open, which the rest of
 * this schema would never allow. Sales and purchases are corrected by posting a
 * reversal because they are history; a quote is an offer, and an offer that has
 * not been accepted can simply be changed.
 */

export const QUOTATION_STATUSES = ['OPEN', 'CONVERTED', 'CANCELLED'] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

export const quotations = sqliteTable(
  'quotations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    quoteNo: text('quote_no').notNull(),

    businessDate: businessDate('business_date').notNull(),
    /**
     * The day the price stops being promised.
     *
     * NOT NULL on purpose. A quote with no end is a price list, and since the
     * quoted price is what the customer is charged at conversion, an open-ended
     * one lets a price from March be honoured in August. The shop would sell
     * below what the goods now cost and every figure would look perfectly
     * normal.
     */
    validUntil: businessDate('valid_until').notNull(),

    /**
     * Who it is addressed to.
     *
     * The typed name is always present and is what prints. `customerId` is
     * filled in at conversion, or earlier if the owner picks somebody already on
     * the books. Both, rather than either: a contractor asking for a price is
     * usually not a customer yet, and stopping to create a record before you can
     * quote them is friction at exactly the wrong moment. The name is
     * snapshotted so renaming a customer next year cannot rewrite the quote they
     * were handed.
     */
    customerName: text('customer_name').notNull(),
    customerId: integer('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    customerPhone: text('customer_phone'),
    /** The job, not the person. "Adenta site", "Block C roofing". */
    reference: text('reference'),

    /** Sum of line totals before any quote-level discount, net of tax. */
    subtotalMinor: moneyMinor('subtotal_minor').notNull(),
    discountMinor: moneyMinor('discount_minor').notNull().default(0),
    /**
     * The quote-level discount AS THE OWNER TYPED IT, which `discountMinor`
     * above is not: that one is net of tax, like every other document total
     * here.
     *
     * A quote is the only document in this application that has to reproduce
     * itself. Converting one re-runs the same pricing that produced it, and
     * that needs the raw figure back. Where a shop prices tax-exclusive the two
     * are identical and this looks redundant; where it prices tax-inclusive
     * they differ, and using the net one would quietly hand the customer a
     * sale that costs more than the paper they are holding.
     */
    quoteDiscountMinor: moneyMinor('quote_discount_minor').notNull().default(0),
    taxMinor: moneyMinor('tax_minor').notNull().default(0),
    /** subtotal - discount + tax. What the customer is being quoted. */
    totalMinor: moneyMinor('total_minor').notNull(),
    /** Snapshotted for the same reason `sales.taxInclusive` is. */
    taxInclusive: boolean('tax_inclusive').notNull().default(false),

    status: text('status', { enum: QUOTATION_STATUSES }).notNull().default('OPEN'),
    convertedSaleId: integer('converted_sale_id').references(() => sales.id, {
      onDelete: 'restrict',
    }),
    convertedAt: timestampMs('converted_at'),
    /** Recorded only when an EXPIRED quote was converted anyway. */
    overrideReason: text('override_reason'),

    cancelledAt: timestampMs('cancelled_at'),
    cancelReason: text('cancel_reason'),

    notes: text('notes'),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_quotations_no').on(t.quoteNo),

    /**
     * The convert-once guarantee, in the database rather than in whichever code
     * path happens to remember.
     *
     * Converting the same quote twice would ship the goods twice off one piece
     * of paper, and both sales would be internally perfect: own receipt number,
     * own stock movement, own balanced entry. No balance check anywhere would
     * notice. This is the same reasoning as `uq_sales_client_ref`, which exists
     * because that is the one duplicate nothing else can catch. SQLite permits
     * many NULLs in a unique index, so open quotes never collide.
     */
    uniqueIndex('uq_quotations_converted_sale').on(t.convertedSaleId),

    index('idx_quotations_status').on(t.status),
    index('idx_quotations_date').on(t.businessDate),
    index('idx_quotations_valid_until').on(t.validUntil),
    index('idx_quotations_customer').on(t.customerId),

    check('ck_quotations_status', oneOf(t.status, QUOTATION_STATUSES)),
    check('ck_quotations_name', sql`length(trim(${t.customerName})) > 0`),
    check('ck_quotations_quote_no', sql`length(trim(${t.quoteNo})) > 0`),
    check(
      'ck_quotations_date_format',
      sql`${t.businessDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
    check(
      'ck_quotations_valid_format',
      sql`${t.validUntil} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
    /** A quote cannot expire before it is issued. */
    check('ck_quotations_dates', sql`${t.validUntil} >= ${t.businessDate}`),

    /**
     * A quote is never negative. Unlike a sale it has no mirror document: it is
     * an offer, and an offer is withdrawn by cancelling it, not by posting its
     * opposite.
     */
    check(
      'ck_quotations_signs',
      sql`${t.subtotalMinor} >= 0 AND ${t.discountMinor} >= 0
        AND ${t.taxMinor} >= 0 AND ${t.totalMinor} >= 0`,
    ),
    check(
      'ck_quotations_total_arithmetic',
      sql`${t.totalMinor} = ${t.subtotalMinor} - ${t.discountMinor} + ${t.taxMinor}`,
    ),

    /** CONVERTED carries its sale; nothing else may. Both directions. */
    check(
      'ck_quotations_converted_link',
      sql`(${t.status} = 'CONVERTED') = (${t.convertedSaleId} IS NOT NULL)`,
    ),
    check(
      'ck_quotations_cancelled_reason',
      sql`${t.status} = 'CANCELLED' OR ${t.cancelledAt} IS NULL`,
    ),
  ],
);

export const quotationItems = sqliteTable(
  'quotation_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    quotationId: integer('quotation_id')
      .notNull()
      .references(() => quotations.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    /**
     * Snapshotted as `sale_items` does, so a quote reprinted next month shows
     * what was actually offered even if the product has since been renamed.
     */
    productName: text('product_name').notNull(),
    unit: text('unit').notNull(),

    qtyMilli: qtyMilli('qty_milli').notNull(),
    unitPriceMinor: moneyMinor('unit_price_minor').notNull(),
    discountMinor: moneyMinor('discount_minor').notNull().default(0),
    /** qty x unitPrice - discount */
    lineTotalMinor: moneyMinor('line_total_minor').notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    index('idx_quotation_items_quotation').on(t.quotationId),
    index('idx_quotation_items_product').on(t.productId),
    uniqueIndex('uq_quotation_items_line').on(t.quotationId, t.lineNo),

    /**
     * Strictly positive, unlike `sale_items` which permits a negative quantity
     * for the mirror document a void or a return produces. A quote has no such
     * document, so nothing here should ever be negative or zero.
     */
    check('ck_quotation_items_qty_positive', sql`${t.qtyMilli} > 0`),
    check('ck_quotation_items_price_nonneg', sql`${t.unitPriceMinor} >= 0`),
    check('ck_quotation_items_discount_nonneg', sql`${t.discountMinor} >= 0`),
  ],
);

export type Quotation = typeof quotations.$inferSelect;
export type NewQuotation = typeof quotations.$inferInsert;
export type QuotationItem = typeof quotationItems.$inferSelect;
export type NewQuotationItem = typeof quotationItems.$inferInsert;
