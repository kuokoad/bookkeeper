import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { boolean, createdAt, isDemo, moneyMinor, qtyMilli, updatedAt } from './_shared';
import { users } from './users';

/**
 * Product categories. Entirely owner-defined — nothing is hard-coded, and a
 * shop selling building materials is as well served as one selling drinks.
 */
export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),

    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_categories_name').on(sql`lower(${t.name})`),
    index('idx_categories_active').on(t.isActive),
    check('ck_categories_name', sql`length(trim(${t.name})) > 0`),
  ],
);

export const products = sqliteTable(
  'products',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    name: text('name').notNull(),
    /** Optional — many small shops have no SKU scheme. Unique when present. */
    sku: text('sku'),
    /** Optional scan code. Unique when present. */
    barcode: text('barcode'),

    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),

    /** Free text: 'pcs', 'kg', 'crate', 'bag'. Not an enum — shops differ. */
    unit: text('unit').notNull().default('pcs'),
    description: text('description'),

    /**
     * Reference prices only.
     *
     * `costPriceMinor` is what the owner EXPECTS to pay — it pre-fills a
     * purchase form and is never used to value stock or compute profit. The
     * real cost basis lives in the stock ledger. Editing this tomorrow must not
     * change last week's reported profit.
     */
    costPriceMinor: moneyMinor('cost_price_minor').notNull().default(0),
    sellingPriceMinor: moneyMinor('selling_price_minor').notNull().default(0),

    /** Reorder level. Null falls back to the shop-wide default in settings. */
    minStockMilli: qtyMilli('min_stock_milli'),

    /**
     * How many days before this product's stock goes off the shop wants
     * telling. Null falls back to the shop-wide setting, like the reorder level
     * above it.
     *
     * One window for a whole shop cannot be right: thirty days suits tinned
     * milk and is absurd for bread, which will have been thrown away three
     * weeks before the warning arrives. It lives on the PRODUCT rather than on
     * each crate because nobody wants to answer the question per delivery —
     * they want to say "bread warns at three days" once, and have every loaf
     * after that inherit it.
     */
    warnDays: integer('warn_days'),

    /**
     * Cached mirror of the newest stock_ledger row for this product.
     *
     * The LEDGER is the source of truth; these two columns exist so a product
     * list does not need an aggregate per row. `verifyProductStock()` recomputes
     * the whole chain from the first movement and reports any drift, so the
     * cache can always be proven against its source.
     */
    qtyOnHandMilli: qtyMilli('qty_on_hand_milli').notNull().default(0),
    stockValueMinor: moneyMinor('stock_value_minor').notNull().default(0),

    /** Services and non-stock items skip inventory entirely. */
    trackInventory: boolean('track_inventory').notNull().default(true),

    isActive: boolean('is_active').notNull().default(true),

    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    isDemo: isDemo(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Multiple NULLs are permitted by a SQLite unique index, so optional codes
    // stay optional while remaining unique whenever they are supplied.
    uniqueIndex('uq_products_sku').on(sql`lower(${t.sku})`),
    uniqueIndex('uq_products_barcode').on(t.barcode),
    index('idx_products_category').on(t.categoryId),
    index('idx_products_active').on(t.isActive),
    index('idx_products_name').on(t.name),

    check('ck_products_name', sql`length(trim(${t.name})) > 0`),
    check('ck_products_unit', sql`length(trim(${t.unit})) > 0`),
    // Prices may be zero (a free sample) but never negative.
    check('ck_products_cost_price', sql`${t.costPriceMinor} >= 0`),
    check('ck_products_selling_price', sql`${t.sellingPriceMinor} >= 0`),
    check('ck_products_min_stock', sql`${t.minStockMilli} IS NULL OR ${t.minStockMilli} >= 0`),
    check('ck_products_warn_days', sql`${t.warnDays} IS NULL OR ${t.warnDays} >= 0`),
    // Stock quantity MAY be negative (only when the shop enables that policy),
    // but a product that holds no quantity must hold no value.
    check(
      'ck_products_zero_qty_zero_value',
      sql`${t.qtyOnHandMilli} <> 0 OR ${t.stockValueMinor} = 0`,
    ),
  ],
);

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
