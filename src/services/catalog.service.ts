import { and, asc, eq, gt, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db } from '@/db/types';
import {
  businessSettings,
  categories,
  productBatches,
  products,
  purchaseItems,
  purchases,
  stockLedger,
} from '@/db/schema';
import { minor, type Minor } from '@/domain/money';
import { qty as makeQty, type Qty } from '@/domain/quantity';
import { averageUnitCost, isLowStock, isOutOfStock } from '@/domain/inventory/costing';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { toBusinessDate } from '@/lib/format';
import { writeAudit } from './audit.service';
import type { Actor } from './journal.service';

/**
 * Products and categories.
 *
 * Note what is NOT here: no function sets a product's stock. Quantity and value
 * are owned by the inventory service and can only change through a recorded
 * stock movement. A product form that could type over the stock figure would
 * make the ledger unprovable.
 */

// --- categories -----------------------------------------------------------

export interface CategoryInput {
  name: string;
  description?: string | undefined;
  sortOrder?: number;
}

/**
 * Categories with how many products each holds.
 *
 * Uses JOIN + GROUP BY rather than a correlated subquery: drizzle only
 * qualifies column names when the outer query has a join, so a subquery like
 * `WHERE category_id = id` in a single-table select binds `id` to the WRONG
 * table and silently returns nonsense.
 */
export function listCategories(db: Db, includeInactive = false) {
  const base = db
    .select({
      id: categories.id,
      name: categories.name,
      description: categories.description,
      isActive: categories.isActive,
      sortOrder: categories.sortOrder,
      productCount: sql<number>`COUNT(${products.id})`,
    })
    .from(categories)
    .leftJoin(products, eq(products.categoryId, categories.id));

  const filtered = includeInactive ? base : base.where(eq(categories.isActive, true));
  return filtered
    .groupBy(categories.id)
    .orderBy(asc(categories.sortOrder), asc(categories.name))
    .all();
}

export function createCategory(db: Db, input: CategoryInput, actor: Actor): number {
  const name = input.name.trim();
  if (name.length === 0) throw new ValidationError('Enter a category name.');

  return writeTransaction(db, (tx) => {
    const existing = tx
      .select({ id: categories.id })
      .from(categories)
      .where(sql`lower(${categories.name}) = lower(${name})`)
      .get();
    if (existing) throw new ConflictError(`A category called "${name}" already exists.`);

    const now = new Date();
    const inserted = tx
      .insert(categories)
      .values({
        name,
        description: input.description?.trim() || null,
        sortOrder: input.sortOrder ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: categories.id })
      .get();

    if (!inserted) throw new ConflictError('Could not create the category.');

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'category',
      entityId: inserted.id,
      userId: actor.id,
      username: actor.username,
      summary: `Created category "${name}"`,
      at: now,
    });

    return inserted.id;
  });
}

export function updateCategory(db: Db, id: number, input: CategoryInput, actor: Actor): void {
  const name = input.name.trim();
  if (name.length === 0) throw new ValidationError('Enter a category name.');

  writeTransaction(db, (tx) => {
    const existing = tx.select().from(categories).where(eq(categories.id, id)).get();
    if (!existing) throw new NotFoundError('Category', id);

    const clash = tx
      .select({ id: categories.id })
      .from(categories)
      .where(sql`lower(${categories.name}) = lower(${name}) AND ${categories.id} <> ${id}`)
      .get();
    if (clash) throw new ConflictError(`A category called "${name}" already exists.`);

    const now = new Date();
    tx.update(categories)
      .set({
        name,
        description: input.description?.trim() || null,
        sortOrder: input.sortOrder ?? existing.sortOrder,
        updatedAt: now,
      })
      .where(eq(categories.id, id))
      .run();

    writeAudit(tx, {
      action: 'UPDATE',
      entityType: 'category',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `Updated category "${name}"`,
      metadata: { before: { name: existing.name }, after: { name } },
      at: now,
    });
  });
}

/**
 * Categories are archived, never deleted, so historical products keep their
 * classification and old reports stay readable.
 */
export function setCategoryActive(db: Db, id: number, isActive: boolean, actor: Actor): void {
  writeTransaction(db, (tx) => {
    const existing = tx.select().from(categories).where(eq(categories.id, id)).get();
    if (!existing) throw new NotFoundError('Category', id);

    const now = new Date();
    tx.update(categories).set({ isActive, updatedAt: now }).where(eq(categories.id, id)).run();

    writeAudit(tx, {
      action: isActive ? 'RESTORE' : 'ARCHIVE',
      entityType: 'category',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `${isActive ? 'Restored' : 'Archived'} category "${existing.name}"`,
      at: now,
    });
  });
}

// --- products -------------------------------------------------------------

export interface ProductInput {
  name: string;
  sku?: string | undefined;
  barcode?: string | undefined;
  categoryId?: number | null;
  unit?: string;
  description?: string | undefined;
  costPrice: Minor;
  sellingPrice: Minor;
  minStock?: Qty | null;
  /**
   * Days before this product's stock expires that the shop wants telling.
   * Null uses the shop-wide setting, like `minStock` above it.
   */
  warnDays?: number | null;
  trackInventory?: boolean;
}

function normaliseCode(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function assertProductInput(input: ProductInput): void {
  if (input.name.trim().length === 0) throw new ValidationError('Enter a product name.');
  if (input.costPrice < 0) throw new ValidationError('Cost price cannot be negative.');
  if (input.sellingPrice < 0) throw new ValidationError('Selling price cannot be negative.');
  if (input.minStock !== null && input.minStock !== undefined && input.minStock < 0) {
    throw new ValidationError('Reorder level cannot be negative.');
  }
  if (input.warnDays !== null && input.warnDays !== undefined) {
    if (!Number.isInteger(input.warnDays) || input.warnDays < 0) {
      throw new ValidationError('The expiry warning period must be a whole number of days.', {
        warnDays: input.warnDays,
      });
    }
  }
}

export function createProduct(db: Db, input: ProductInput, actor: Actor): number {
  assertProductInput(input);
  const sku = normaliseCode(input.sku);
  const barcode = normaliseCode(input.barcode);

  return writeTransaction(db, (tx) => {
    assertCodesAvailable(tx, sku, barcode, null);

    const now = new Date();
    const inserted = tx
      .insert(products)
      .values({
        name: input.name.trim(),
        sku,
        barcode,
        categoryId: input.categoryId ?? null,
        unit: (input.unit ?? 'pcs').trim() || 'pcs',
        description: input.description?.trim() || null,
        costPriceMinor: input.costPrice,
        sellingPriceMinor: input.sellingPrice,
        minStockMilli: input.minStock ?? null,
        warnDays: input.warnDays ?? null,
        trackInventory: input.trackInventory ?? true,
        // Stock starts empty. The ONLY way to give a product opening stock is a
        // recorded stock adjustment, so its value always traces to the ledger.
        qtyOnHandMilli: 0,
        stockValueMinor: 0,
        isActive: true,
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: products.id })
      .get();

    if (!inserted) throw new ConflictError('Could not create the product.');

    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'product',
      entityId: inserted.id,
      userId: actor.id,
      username: actor.username,
      summary: `Created product "${input.name.trim()}"`,
      metadata: { sku, barcode, sellingPriceMinor: input.sellingPrice },
      at: now,
    });

    return inserted.id;
  });
}

export function updateProduct(db: Db, id: number, input: ProductInput, actor: Actor): void {
  assertProductInput(input);
  const sku = normaliseCode(input.sku);
  const barcode = normaliseCode(input.barcode);

  writeTransaction(db, (tx) => {
    const existing = tx.select().from(products).where(eq(products.id, id)).get();
    if (!existing) throw new NotFoundError('Product', id);

    assertCodesAvailable(tx, sku, barcode, id);

    // Turning off inventory tracking for a product that holds stock would
    // orphan that value in the ledger.
    if (input.trackInventory === false && existing.qtyOnHandMilli !== 0) {
      throw new ValidationError(
        'Clear this product’s stock before turning off inventory tracking.',
        { qtyOnHandMilli: existing.qtyOnHandMilli },
      );
    }

    const now = new Date();
    tx.update(products)
      .set({
        name: input.name.trim(),
        sku,
        barcode,
        categoryId: input.categoryId ?? null,
        unit: (input.unit ?? existing.unit).trim() || 'pcs',
        description: input.description?.trim() || null,
        costPriceMinor: input.costPrice,
        sellingPriceMinor: input.sellingPrice,
        minStockMilli: input.minStock ?? null,
        warnDays: input.warnDays ?? null,
        trackInventory: input.trackInventory ?? existing.trackInventory,
        updatedAt: now,
      })
      .where(eq(products.id, id))
      .run();

    writeAudit(tx, {
      action: 'UPDATE',
      entityType: 'product',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `Updated product "${input.name.trim()}"`,
      metadata: {
        before: {
          name: existing.name,
          sellingPriceMinor: existing.sellingPriceMinor,
          costPriceMinor: existing.costPriceMinor,
        },
        after: { name: input.name.trim(), sellingPriceMinor: input.sellingPrice },
      },
      at: now,
    });
  });
}

function assertCodesAvailable(
  tx: Db,
  sku: string | null,
  barcode: string | null,
  excludeId: number | null,
): void {
  if (sku) {
    const clash = tx
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(
        excludeId === null
          ? sql`lower(${products.sku}) = lower(${sku})`
          : sql`lower(${products.sku}) = lower(${sku}) AND ${products.id} <> ${excludeId}`,
      )
      .get();
    if (clash) throw new ConflictError(`SKU "${sku}" is already used by "${clash.name}".`);
  }

  if (barcode) {
    const clash = tx
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(
        excludeId === null
          ? eq(products.barcode, barcode)
          : and(eq(products.barcode, barcode), sql`${products.id} <> ${excludeId}`),
      )
      .get();
    if (clash) throw new ConflictError(`Barcode "${barcode}" is already used by "${clash.name}".`);
  }
}

/**
 * Products are archived, never deleted.
 *
 * Deleting one would break every historical sale line and stock movement that
 * refers to it. The database enforces this too (ON DELETE RESTRICT), so even a
 * direct SQL delete cannot destroy the history.
 */
export function setProductActive(db: Db, id: number, isActive: boolean, actor: Actor): void {
  writeTransaction(db, (tx) => {
    const existing = tx.select().from(products).where(eq(products.id, id)).get();
    if (!existing) throw new NotFoundError('Product', id);

    const now = new Date();
    tx.update(products).set({ isActive, updatedAt: now }).where(eq(products.id, id)).run();

    writeAudit(tx, {
      action: isActive ? 'RESTORE' : 'ARCHIVE',
      entityType: 'product',
      entityId: id,
      userId: actor.id,
      username: actor.username,
      summary: `${isActive ? 'Restored' : 'Archived'} product "${existing.name}"`,
      at: now,
    });
  });
}

/** True when a product has any stock history and so must never be deleted. */
export function hasStockHistory(db: Db, productId: number): boolean {
  const row = db
    .select({ id: stockLedger.id })
    .from(stockLedger)
    .where(eq(stockLedger.productId, productId))
    .limit(1)
    .get();
  return row !== undefined;
}

// --- reads ----------------------------------------------------------------

export interface ProductListItem {
  id: number;
  name: string;
  sku: string | null;
  barcode: string | null;
  categoryId: number | null;
  categoryName: string | null;
  unit: string;
  costPrice: Minor;
  sellingPrice: Minor;
  qtyOnHand: Qty;
  stockValue: Minor;
  averageCost: Minor;
  minStock: Qty | null;
  /** Null means the product uses the shop-wide expiry warning window. */
  warnDays: number | null;
  trackInventory: boolean;
  isActive: boolean;
  lowStock: boolean;
  outOfStock: boolean;
}

/**
 * The outer product's own columns, written out with their table name.
 *
 * Drizzle omits the table qualifier for a query's primary table when the query
 * has no joins, so a bare interpolation can render as an unqualified column
 * name — which SQLite then binds to the SUBQUERY's table, quietly turning a
 * correlated subquery into an uncorrelated one that returns the same plausible
 * number for every row. See the note on listCategories in catalog.service.ts,
 * which hit the same thing. Writing the qualifier out means these fragments
 * cannot depend on the shape of the query they land in.
 */
const PRODUCT_ID = sql`products.id`;

export const STOCK_STATUSES = ['in-stock', 'low', 'out', 'negative'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

export const PRODUCT_SORTS = ['name', 'quantity', 'cost', 'price', 'value', 'category'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export interface ProductQuery {
  /**
   * One product by id. Present so a single product can be fetched as an INDEXED
   * lookup — see `getProduct`, which used to page through the list and find it
   * in JavaScript, and so could not see past the page limit at all.
   */
  id?: number;
  search?: string;
  categoryId?: number;
  /** Products this supplier has ever delivered. */
  supplierId?: number;
  includeInactive?: boolean;
  /** 'active' or 'archived'. Narrower than `includeInactive`, which widens. */
  productStatus?: 'active' | 'archived';
  /**
   * What is on the shelf.
   *
   * `low` INCLUDES what has run out, because a product at zero is the most
   * urgent case of "below its minimum" and hiding it from the low-stock list
   * would be the one thing that list must never do. `out` and `negative`
   * narrow further. A negative figure is not a stock level, it is a sign
   * something was recorded wrongly, so it gets its own filter.
   */
  stockStatus?: StockStatus;
  /** @deprecated Use `stockStatus: 'low'`. Kept for existing callers. */
  lowStockOnly?: boolean;
  /**
   * Products holding dated stock: `'expired'` for what has already turned,
   * `'soon'` for what falls inside the shop's warning window.
   */
  expiring?: 'expired' | 'soon';
  /** The day the window is measured from. Defaults to today. */
  asAt?: string;
  sort?: ProductSort;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export function getLowStockThreshold(db: Db): Qty {
  const settings = db
    .select({ threshold: businessSettings.lowStockThresholdMilli })
    .from(businessSettings)
    .where(eq(businessSettings.id, 1))
    .get();
  return makeQty(settings?.threshold ?? 0);
}

/**
 * Every product filter as one clause, shared by the list and the count.
 *
 * Stock status is the one that has to be here rather than in JavaScript. It
 * used to be applied after the query came back, which meant "low stock" showed
 * the low-stock products among the first five hundred by name — a shop whose
 * reorder list stops at the letter M does not know it is missing anything.
 */
function productConditions(db: Db, query: ProductQuery): SQL[] {
  const fallbackMin = getLowStockThreshold(db);
  const conditions: SQL[] = [];

  if (query.id !== undefined) conditions.push(eq(products.id, query.id));

  if (query.productStatus === 'active') conditions.push(eq(products.isActive, true));
  else if (query.productStatus === 'archived') conditions.push(eq(products.isActive, false));
  else if (!query.includeInactive) conditions.push(eq(products.isActive, true));

  if (query.categoryId !== undefined) conditions.push(eq(products.categoryId, query.categoryId));

  if (query.supplierId !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${purchaseItems}
                  JOIN ${purchases} ON ${purchases.id} = ${purchaseItems.purchaseId}
                  WHERE ${purchaseItems.productId} = ${PRODUCT_ID}
                    AND ${purchases.supplierId} = ${query.supplierId})`,
    );
  }

  const stockStatus: StockStatus | undefined =
    query.stockStatus ?? (query.lowStockOnly ? 'low' : undefined);

  if (stockStatus !== undefined) {
    // Products that do not track stock have no shelf to be low on, so they are
    // out of every stock-status answer rather than showing as "out of stock".
    conditions.push(eq(products.trackInventory, true));

    // The threshold is the product's own minimum where it has one, and the
    // shop-wide default where it does not — the same rule `isLowStock` applies.
    const threshold = sql`COALESCE(${products.minStockMilli}, ${fallbackMin})`;

    switch (stockStatus) {
      case 'low':
        conditions.push(sql`${products.qtyOnHandMilli} <= ${threshold}`);
        break;
      case 'out':
        conditions.push(sql`${products.qtyOnHandMilli} <= 0`);
        break;
      case 'negative':
        conditions.push(sql`${products.qtyOnHandMilli} < 0`);
        break;
      case 'in-stock':
        conditions.push(sql`${products.qtyOnHandMilli} > ${threshold}`);
        break;
    }
  }

  /**
   * Products whose batches carry a date worth looking at.
   *
   * An EXISTS rather than a join: a product with three crates going off is one
   * row in this list, and a join would give it three. The dates live on the
   * batches, so this is the one place the two tables meet.
   */
  if (query.expiring !== undefined) {
    const asAt = query.asAt ?? toBusinessDate();
    // The same three-level window `getExpirySummary` uses, or this page and the
    // notice that sends people to it would disagree about what "soon" means.
    const shopDays = getExpirySummary(db, asAt).warningDays;
    const window =
      query.expiring === 'expired'
        ? sql`${productBatches.expiryDate} < ${asAt}`
        : sql`${productBatches.expiryDate} >= ${asAt}
              AND CAST(julianday(${productBatches.expiryDate}) - julianday(${asAt}) AS INTEGER)
                  <= COALESCE(${productBatches.warnDays}, ${products.warnDays}, ${shopDays})`;

    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM ${productBatches}
        WHERE ${productBatches.productId} = ${PRODUCT_ID}
          AND ${productBatches.isClosed} = 0
          AND ${productBatches.qtyMilli} > 0
          AND ${productBatches.expiryDate} IS NOT NULL
          AND ${window}
      )`,
    );
  }

  if (query.search) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    const match = or(
      sql`lower(${products.name}) LIKE ${term}`,
      sql`lower(COALESCE(${products.sku}, '')) LIKE ${term}`,
      sql`lower(COALESCE(${products.barcode}, '')) LIKE ${term}`,
    );
    if (match) conditions.push(match);
  }

  return conditions;
}

export function listProducts(db: Db, query: ProductQuery = {}): ProductListItem[] {
  const fallbackMin = getLowStockThreshold(db);
  const conditions = productConditions(db, query);

  const base = db
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      barcode: products.barcode,
      categoryId: products.categoryId,
      categoryName: categories.name,
      unit: products.unit,
      costPriceMinor: products.costPriceMinor,
      sellingPriceMinor: products.sellingPriceMinor,
      qtyOnHandMilli: products.qtyOnHandMilli,
      stockValueMinor: products.stockValueMinor,
      minStockMilli: products.minStockMilli,
      warnDays: products.warnDays,
      trackInventory: products.trackInventory,
      isActive: products.isActive,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId));

  const rows = (conditions.length > 0 ? base.where(and(...conditions)) : base)
    .orderBy(...productOrderBy(query))
    .limit(Math.min(query.limit ?? 200, 500))
    .offset(query.offset ?? 0)
    .all();

  return rows.map((row): ProductListItem => {
    const qtyOnHand = makeQty(row.qtyOnHandMilli);
    const stockValue = minor(row.stockValueMinor);
    const minStock = row.minStockMilli === null ? null : makeQty(row.minStockMilli);

    return {
      warnDays: row.warnDays,
      id: row.id,
      name: row.name,
      sku: row.sku,
      barcode: row.barcode,
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      unit: row.unit,
      costPrice: minor(row.costPriceMinor),
      sellingPrice: minor(row.sellingPriceMinor),
      qtyOnHand,
      stockValue,
      averageCost: averageUnitCost({ qty: qtyOnHand, value: stockValue }),
      minStock,
      trackInventory: row.trackInventory,
      isActive: row.isActive,
      lowStock: row.trackInventory && isLowStock(qtyOnHand, minStock, fallbackMin),
      outOfStock: row.trackInventory && isOutOfStock(qtyOnHand),
    };
  });
}

function productOrderBy(query: ProductQuery): SQL[] {
  const ascending = (query.direction ?? 'asc') === 'asc';
  const dir = (column: SQL): SQL => (ascending ? sql`${column} ASC` : sql`${column} DESC`);
  const byName = sql`lower(${products.name}) ASC`;

  switch (query.sort) {
    case 'quantity':
      return [dir(sql`${products.qtyOnHandMilli}`), byName];
    case 'cost':
      return [dir(sql`${products.costPriceMinor}`), byName];
    case 'price':
      return [dir(sql`${products.sellingPriceMinor}`), byName];
    case 'value':
      return [dir(sql`${products.stockValueMinor}`), byName];
    case 'category':
      return [dir(sql`lower(COALESCE(${categories.name}, 'zzzz'))`), byName];
    default:
      return [dir(sql`lower(${products.name})`)];
  }
}

/** How many products match, ignoring the page. What the pager counts. */
export function countProducts(db: Db, query: ProductQuery = {}): number {
  const conditions = productConditions(db, query);

  const base = db
    .select({ total: sql<number>`COUNT(*)` })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId));
  const row = (conditions.length > 0 ? base.where(and(...conditions)) : base).get();
  return row?.total ?? 0;
}

/**
 * One product, by id.
 *
 * This used to ask for the first 500 products by NAME and look through them in
 * JavaScript, which had two faults. It read the whole catalogue to answer a
 * question about one row; and, worse, a shop with more than 500 products simply
 * could not fetch the ones sorted after the five hundredth — `getProduct` threw
 * NotFoundError for a product that plainly existed. That reached the till,
 * because scanning a barcode resolves an id and then comes through here.
 */
/**
 * Just enough to fill a filter dropdown.
 *
 * `listProducts` does real work per row — stock levels, average cost, low-stock flags — which is right for
 * the table and wasted on a `<select>` that needs a name and an id. It also
 * makes the cap matter: a list function truncated at its page size would leave
 * entries missing from the dropdown with nothing to say so, and a filter that
 * cannot offer a value the shop actually has is a dead end.
 */
export interface ProductOption {
  id: number;
  name: string;
  sku: string | null;
  isActive: boolean;
}

export function listProductOptions(db: Db, includeInactive = false): ProductOption[] {
  const base = db
    .select({ id: products.id, name: products.name, sku: products.sku, isActive: products.isActive })
    .from(products);

  return (includeInactive ? base : base.where(eq(products.isActive, true)))
    .orderBy(asc(products.name))
    .all();
}

export function getProduct(db: Db, id: number): ProductListItem {
  const found = listProducts(db, { includeInactive: true, id, limit: 1 })[0];
  if (!found) throw new NotFoundError('Product', id);
  return found;
}

/** Fast lookup for the POS: exact barcode or SKU match first, then name. */
export function findProductByCode(db: Db, code: string): ProductListItem | null {
  const trimmed = code.trim();
  if (trimmed.length === 0) return null;

  const row = db
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.isActive, true),
        or(
          eq(products.barcode, trimmed),
          sql`lower(${products.sku}) = lower(${trimmed})`,
        ) as SQL,
      ),
    )
    .get();

  return row ? getProduct(db, row.id) : null;
}

export interface StockSummary {
  productCount: number;
  trackedCount: number;
  totalStockValue: Minor;
  lowStockCount: number;
  outOfStockCount: number;
}

/**
 * The headline stock figures, for whatever set of products a filter selects.
 *
 * Aggregated in SQL. This used to fetch the first five hundred products by name
 * and count them in JavaScript, which meant a shop with more than five hundred
 * products was shown a stock value, a low-stock count and an out-of-stock count
 * that silently excluded everything sorted after the five hundredth — and gave
 * no hint it had done so. A reorder list that stops at the letter M is worse
 * than no reorder list, because the owner trusts it.
 *
 * Called with no query it describes the whole active catalogue, which is what
 * the dashboard wants; called with the page's filters it describes the table
 * underneath it.
 */
export function getStockSummary(db: Db, query: ProductQuery = {}): StockSummary {
  const fallbackMin = getLowStockThreshold(db);
  const conditions = productConditions(db, query);
  const threshold = sql`COALESCE(${products.minStockMilli}, ${fallbackMin})`;

  const base = db
    .select({
      productCount: sql<number>`COUNT(*)`,
      trackedCount: sql<number>`COALESCE(SUM(CASE WHEN ${products.trackInventory} THEN 1 ELSE 0 END), 0)`,
      totalStockValue: sql<number>`COALESCE(SUM(${products.stockValueMinor}), 0)`,
      // "Low" here EXCLUDES what has run out, because the two are shown side by
      // side and a product counted in both would be reported twice.
      lowStockCount: sql<number>`COALESCE(SUM(CASE
        WHEN ${products.trackInventory}
         AND ${products.qtyOnHandMilli} <= ${threshold}
         AND ${products.qtyOnHandMilli} > 0
        THEN 1 ELSE 0 END), 0)`,
      outOfStockCount: sql<number>`COALESCE(SUM(CASE
        WHEN ${products.trackInventory} AND ${products.qtyOnHandMilli} <= 0
        THEN 1 ELSE 0 END), 0)`,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId));

  const row = (conditions.length > 0 ? base.where(and(...conditions)) : base).get();

  return {
    productCount: row?.productCount ?? 0,
    trackedCount: row?.trackedCount ?? 0,
    totalStockValue: minor(row?.totalStockValue ?? 0),
    lowStockCount: row?.lowStockCount ?? 0,
    outOfStockCount: row?.outOfStockCount ?? 0,
  };
}

export interface ExpirySummary {
  /** Products holding stock that has passed its date. */
  expiredCount: number;
  /** How much of it there is, in milli-units, across every product. */
  expiredQtyMilli: number;
  /** Products whose soonest date falls inside their own warning window. */
  expiringSoonCount: number;
  /** The shop-wide window, for a message that needs to name a number. */
  warningDays: number;
  /**
   * Whether every product counted uses that shop-wide window.
   *
   * False as soon as one product sets its own, at which point no single number
   * describes "soon" and a message must not pretend otherwise.
   */
  uniformWindow: boolean;
}

/**
 * What the shop needs to be told about dates, in one pass.
 *
 * Counts PRODUCTS, not batches, because that is the unit an owner acts on —
 * three crates of the same milk going off is one thing to deal with, not three.
 *
 * Deliberately no value figure for expiring-soon stock. Goods that have not
 * turned yet are worth exactly what the books say; putting a number beside them
 * would invite writing it off early, which is the opposite of the point.
 */
/**
 * Whether any stock on the shelf carries a date.
 *
 * Decides whether a shop that has switched expiry dates off must still be shown
 * the settings that govern them. With nothing dated, `expiryBlocksSales` cannot
 * fire and the card it lives on is hiding an inert control; the moment one
 * crate is dated the block becomes reachable, and the owner must be able to
 * reach it too. A menu setting must never leave the till refusing a sale for a
 * reason nobody on the shop floor can see or undo.
 */
export function hasDatedStock(db: Db): boolean {
  const row = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(productBatches)
    .where(
      and(
        eq(productBatches.isClosed, false),
        isNotNull(productBatches.expiryDate),
        gt(productBatches.qtyMilli, 0),
      ),
    )
    .get();
  return (row?.count ?? 0) > 0;
}

export function getExpirySummary(db: Db, asAt: string = toBusinessDate()): ExpirySummary {
  const settings = db
    .select({ warningDays: businessSettings.expiryWarningDays })
    .from(businessSettings)
    .where(eq(businessSettings.id, 1))
    .get();
  const warningDays = settings?.warningDays ?? 30;

  /**
   * The window that applies to a batch, in SQL: its own, else its product's,
   * else the shop's.
   *
   * Three levels because each answers a different question. The shop sets a
   * default; a product overrides it because bread and tinned milk cannot share
   * one number; a crate overrides that for the rare delivery that is different
   * from the rest.
   */
  const effectiveDays = sql`COALESCE(${productBatches.warnDays}, ${products.warnDays}, ${warningDays})`;

  const expired = db
    .select({
      productCount: sql<number>`COUNT(DISTINCT ${productBatches.productId})`,
      qtyMilli: sql<number>`COALESCE(SUM(${productBatches.qtyMilli}), 0)`,
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
    .get();

  const soon = db
    .select({
      productCount: sql<number>`COUNT(DISTINCT ${productBatches.productId})`,
      // Counted here rather than queried again: a message can only name a
      // number when every product it counted agrees on one.
      overrides: sql<number>`SUM(
        CASE WHEN ${productBatches.warnDays} IS NOT NULL OR ${products.warnDays} IS NOT NULL
             THEN 1 ELSE 0 END
      )`,
    })
    .from(productBatches)
    .innerJoin(products, eq(products.id, productBatches.productId))
    .where(
      and(
        eq(productBatches.isClosed, false),
        sql`${productBatches.qtyMilli} > 0`,
        sql`${productBatches.expiryDate} IS NOT NULL`,
        sql`${productBatches.expiryDate} >= ${asAt}`,
        // Days between today and the date, against the window that applies to
        // THIS crate — not one horizon for the whole shop.
        sql`CAST(julianday(${productBatches.expiryDate}) - julianday(${asAt}) AS INTEGER) <= ${effectiveDays}`,
      ),
    )
    .get();

  return {
    expiredCount: expired?.productCount ?? 0,
    expiredQtyMilli: expired?.qtyMilli ?? 0,
    expiringSoonCount: soon?.productCount ?? 0,
    warningDays,
    uniformWindow: (soon?.overrides ?? 0) === 0,
  };
}

/** Products with no category, used to prompt the owner to tidy up. */
export function countUncategorised(db: Db): number {
  const row = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(products)
    .where(and(eq(products.isActive, true), isNull(products.categoryId)))
    .get();
  return row?.count ?? 0;
}
