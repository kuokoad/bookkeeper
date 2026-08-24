import { and, asc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db } from '@/db/types';
import { businessSettings, categories, products, stockLedger } from '@/db/schema';
import { minor, type Minor } from '@/domain/money';
import { qty as makeQty, type Qty } from '@/domain/quantity';
import { averageUnitCost, isLowStock, isOutOfStock } from '@/domain/inventory/costing';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
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
  trackInventory: boolean;
  isActive: boolean;
  lowStock: boolean;
  outOfStock: boolean;
}

export interface ProductQuery {
  /**
   * One product by id. Present so a single product can be fetched as an INDEXED
   * lookup — see `getProduct`, which used to page through the list and find it
   * in JavaScript, and so could not see past the page limit at all.
   */
  id?: number;
  search?: string;
  categoryId?: number;
  includeInactive?: boolean;
  lowStockOnly?: boolean;
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

export function listProducts(db: Db, query: ProductQuery = {}): ProductListItem[] {
  const fallbackMin = getLowStockThreshold(db);
  const conditions: SQL[] = [];

  if (query.id !== undefined) conditions.push(eq(products.id, query.id));
  if (!query.includeInactive) conditions.push(eq(products.isActive, true));
  if (query.categoryId !== undefined) conditions.push(eq(products.categoryId, query.categoryId));

  if (query.search) {
    const term = `%${query.search.trim().toLowerCase()}%`;
    const match = or(
      sql`lower(${products.name}) LIKE ${term}`,
      sql`lower(COALESCE(${products.sku}, '')) LIKE ${term}`,
      sql`lower(COALESCE(${products.barcode}, '')) LIKE ${term}`,
    );
    if (match) conditions.push(match);
  }

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
      trackInventory: products.trackInventory,
      isActive: products.isActive,
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId));

  const rows = (conditions.length > 0 ? base.where(and(...conditions)) : base)
    .orderBy(asc(products.name))
    .limit(Math.min(query.limit ?? 200, 500))
    .offset(query.offset ?? 0)
    .all();

  const items = rows.map((row): ProductListItem => {
    const qtyOnHand = makeQty(row.qtyOnHandMilli);
    const stockValue = minor(row.stockValueMinor);
    const minStock = row.minStockMilli === null ? null : makeQty(row.minStockMilli);

    return {
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

  return query.lowStockOnly ? items.filter((item) => item.lowStock) : items;
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

export function getStockSummary(db: Db): StockSummary {
  const items = listProducts(db, { limit: 500 });
  return {
    productCount: items.length,
    trackedCount: items.filter((item) => item.trackInventory).length,
    totalStockValue: minor(items.reduce((total, item) => total + item.stockValue, 0)),
    lowStockCount: items.filter((item) => item.lowStock && !item.outOfStock).length,
    outOfStockCount: items.filter((item) => item.outOfStock).length,
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
