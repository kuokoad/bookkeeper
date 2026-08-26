import { and, asc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db } from '@/db/types';
import { businessSettings, categories, productBatches, products, stockLedger } from '@/db/schema';
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
  /**
   * Products holding dated stock: `'expired'` for what has already turned,
   * `'soon'` for what falls inside the shop's warning window.
   */
  expiring?: 'expired' | 'soon';
  /** The day the window is measured from. Defaults to today. */
  asAt?: string;
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
        WHERE ${productBatches.productId} = ${products.id}
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
    .orderBy(asc(products.name))
    .limit(Math.min(query.limit ?? 200, 500))
    .offset(query.offset ?? 0)
    .all();

  const items = rows.map((row): ProductListItem => {
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
