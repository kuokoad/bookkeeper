import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { oneOf } from './_check';
import { boolean, createdAt, moneyMinor, updatedAt } from './_shared';
import { accounts } from './accounting';
import { purchases } from './purchases';
import { sales } from './sales';

/**
 * What a tax component is charged ON.
 *
 *  - `NET`              — the goods value, before any tax.
 *  - `NET_PLUS_LEVIES`  — the goods value plus every component ahead of it in
 *                         `sortOrder`, so the tax compounds on those.
 *
 * Ghana's GRA computes VAT the second way: NHIL and GETFund are added to the
 * value first, and VAT is charged on the sum, making the all-in rate 20.75%
 * rather than 20%. Which treatment a shop uses is data rather than code
 * because both exist in the wild and an invoice that disagrees with the
 * authority's own arithmetic is a problem for the shop, not for us.
 */
export const TAX_BASES = ['NET', 'NET_PLUS_LEVIES'] as const;
export type TaxBasis = (typeof TAX_BASES)[number];

/**
 * The taxes a shop charges, and what each sale actually collected.
 *
 * Ghana charges more than one: NHIL, the GETFund levy and VAT are three
 * separate obligations collected on the same sale and shown separately on the
 * invoice, so a single "tax" figure cannot represent them.
 *
 * They live in a TABLE rather than in code because these rates change with the
 * national budget more often than software gets rewritten. A shop that has to
 * wait for a new version to charge the correct tax will charge the wrong one.
 */
export const taxComponents = sqliteTable(
  'tax_components',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /** Stable identifier used in code and on the tax return — 'VAT', 'NHIL'. */
    code: text('code').notNull(),
    /** What the customer sees on the receipt. */
    name: text('name').notNull(),

    /** Rate in basis points. 250 = 2.5%, 1500 = 15%. */
    rateBp: integer('rate_bp').notNull().default(0),

    /**
     * What the rate is charged on — see `TAX_BASES`.
     *
     * Defaults to `NET`, which is what every shop was charging before the
     * column existed. An upgrade must not move anybody's invoice totals.
     */
    basis: text('basis', { enum: TAX_BASES }).notNull().default('NET'),

    /**
     * Whether tax paid on a PURCHASE can be reclaimed.
     *
     * In Ghana, VAT is recoverable and the levies are not: NHIL and GETFund
     * paid to a supplier are part of what the goods cost. Pricing stock
     * without them understates the cost of every sale made from it, which
     * quietly overstates profit on every one.
     */
    isRecoverable: boolean('is_recoverable').notNull().default(false),

    /** Where the tax collected is held until it is remitted. */
    glAccountId: integer('gl_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),

    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_tax_components_code').on(t.code),
    index('idx_tax_components_active').on(t.isActive),
    check('ck_tax_components_rate', sql`${t.rateBp} >= 0 AND ${t.rateBp} <= 100000`),
    check('ck_tax_components_basis', oneOf(t.basis, TAX_BASES)),
    check('ck_tax_components_code', sql`length(${t.code}) > 0`),
    check('ck_tax_components_name', sql`length(${t.name}) > 0`),
  ],
);

/**
 * What each sale charged, component by component.
 *
 * The code, name and rate are SNAPSHOTTED here rather than read back through
 * `componentId`. A receipt reprinted after the budget changes the VAT rate must
 * show what the customer was actually charged on the day, not what the shop
 * would charge for the same goods today.
 *
 * `sales.taxMinor` remains the total of these rows, so every report that asks
 * for "the tax" keeps working without knowing about the breakdown.
 */
export const saleTaxes = sqliteTable(
  'sale_taxes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    saleId: integer('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),
    componentId: integer('component_id').references(() => taxComponents.id, {
      onDelete: 'set null',
    }),

    code: text('code').notNull(),
    name: text('name').notNull(),
    rateBp: integer('rate_bp').notNull(),
    /** How the rate was applied on the day — snapshotted with the rate itself. */
    basis: text('basis', { enum: TAX_BASES }).notNull().default('NET'),
    /** Negative on a return or a void, mirroring the document it belongs to. */
    amountMinor: moneyMinor('amount_minor').notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    index('idx_sale_taxes_sale').on(t.saleId),
    check('ck_sale_taxes_basis', oneOf(t.basis, TAX_BASES)),
    uniqueIndex('uq_sale_taxes_sale_code').on(t.saleId, t.code),
  ],
);

/** The same, for tax paid to a supplier. */
export const purchaseTaxes = sqliteTable(
  'purchase_taxes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    purchaseId: integer('purchase_id')
      .notNull()
      .references(() => purchases.id, { onDelete: 'cascade' }),
    componentId: integer('component_id').references(() => taxComponents.id, {
      onDelete: 'set null',
    }),

    code: text('code').notNull(),
    name: text('name').notNull(),
    rateBp: integer('rate_bp').notNull(),
    /** How the rate was applied on the day — snapshotted with the rate itself. */
    basis: text('basis', { enum: TAX_BASES }).notNull().default('NET'),
    amountMinor: moneyMinor('amount_minor').notNull(),
    /** Whether this component was reclaimable when the goods were bought. */
    isRecoverable: boolean('is_recoverable').notNull().default(false),

    createdAt: createdAt(),
  },
  (t) => [
    index('idx_purchase_taxes_purchase').on(t.purchaseId),
    check('ck_purchase_taxes_basis', oneOf(t.basis, TAX_BASES)),
    uniqueIndex('uq_purchase_taxes_purchase_code').on(t.purchaseId, t.code),
  ],
);

export type TaxComponentRow = typeof taxComponents.$inferSelect;
export type SaleTaxRow = typeof saleTaxes.$inferSelect;
export type PurchaseTaxRow = typeof purchaseTaxes.$inferSelect;
