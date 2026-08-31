import { eq } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { categories, products } from '@/db/schema';
import { createCategory, createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import type { Actor } from '@/services/journal.service';

/**
 * Demo catalogue for development: a plausible Ghanaian building materials yard.
 *
 * Opening stock is entered through a REAL stock adjustment, exactly as an owner
 * would. Nothing here writes a stock quantity directly, so the demo data
 * exercises the same code path as production and its inventory value ties back
 * to the ledger like any other.
 */

const m = (cedis: number): Minor => minor(Math.round(cedis * 100));
const u = (units: number): Qty => fromUnits(units);

interface DemoProduct {
  name: string;
  category: string;
  sku: string;
  barcode?: string;
  unit: string;
  /** Cedis. */
  cost: number;
  price: number;
  minStock: number;
  /** Opening stock: units and the total value paid for them, in cedis. */
  openingQty: number;
  openingValue: number;
  /**
   * Cartage and offloading are sold but never stocked.
   *
   * A materials quote nearly always ends with transport to site, and the spec
   * for quotations says it is priced as a non-stock product rather than a
   * free-text line. A yard demo without one would not show that working.
   */
  service?: boolean;
}

const DEMO_CATEGORIES = ['Cement', 'Steel', 'Plumbing', 'Roofing', 'Fixings', 'Services'] as const;

const DEMO_PRODUCTS: readonly DemoProduct[] = [
  {
    name: 'Cement 50kg',
    category: 'Cement',
    sku: 'CEM50',
    unit: 'bag',
    cost: 86,
    price: 96,
    minStock: 100,
    openingQty: 400,
    openingValue: 34_400,
  },
  {
    name: 'Sand (tipper load)',
    category: 'Cement',
    sku: 'SAND-TIP',
    unit: 'load',
    cost: 900,
    price: 1_100,
    minStock: 1,
    openingQty: 4,
    openingValue: 3_600,
  },
  {
    name: 'Chippings 3/4in (tipper load)',
    category: 'Cement',
    sku: 'CHIP34',
    unit: 'load',
    cost: 1_150,
    price: 1_380,
    minStock: 1,
    openingQty: 3,
    openingValue: 3_450,
  },
  {
    name: 'Iron rod 12mm',
    category: 'Steel',
    sku: 'ROD12',
    unit: 'length',
    cost: 96,
    price: 112,
    minStock: 50,
    openingQty: 220,
    openingValue: 21_120,
  },
  {
    name: 'Iron rod 16mm',
    category: 'Steel',
    sku: 'ROD16',
    unit: 'length',
    cost: 172,
    price: 198,
    minStock: 30,
    openingQty: 120,
    openingValue: 20_640,
  },
  {
    name: 'Binding wire',
    category: 'Steel',
    sku: 'BWIRE',
    unit: 'roll',
    cost: 88,
    price: 108,
    minStock: 10,
    openingQty: 40,
    openingValue: 3_520,
  },
  {
    name: 'PVC pipe 4in',
    category: 'Plumbing',
    sku: 'PVC4',
    unit: 'length',
    cost: 118,
    price: 142,
    minStock: 20,
    openingQty: 90,
    openingValue: 10_620,
  },
  {
    name: 'PVC pipe 2in',
    category: 'Plumbing',
    sku: 'PVC2',
    unit: 'length',
    cost: 54,
    price: 68,
    minStock: 30,
    openingQty: 140,
    openingValue: 7_560,
  },
  {
    name: 'PVC elbow 4in',
    category: 'Plumbing',
    sku: 'ELB4',
    unit: 'pcs',
    cost: 16,
    price: 24,
    minStock: 40,
    openingQty: 200,
    openingValue: 3_200,
  },
  {
    name: 'Roofing sheet aluzinc 3m',
    category: 'Roofing',
    sku: 'ROOF3M',
    unit: 'sheet',
    cost: 182,
    price: 214,
    minStock: 40,
    openingQty: 160,
    openingValue: 29_120,
  },
  {
    name: 'Roofing nails 3in',
    category: 'Fixings',
    sku: 'NAIL3',
    unit: 'kg',
    cost: 14,
    price: 19,
    minStock: 25,
    openingQty: 120,
    openingValue: 1_680,
  },
  {
    name: 'Cartage to site',
    category: 'Services',
    sku: 'CARTAGE',
    unit: 'trip',
    cost: 0,
    price: 350,
    minStock: 0,
    openingQty: 0,
    openingValue: 0,
    service: true,
  },
];

export function seedDemoCatalog(db: Db, actor: Actor, businessDate: string): void {
  // Idempotent: if the demo catalogue is already present, do nothing.
  const existing = db.select({ id: products.id }).from(products).limit(1).get();
  if (existing) return;

  const categoryIds = new Map<string, number>();
  for (const name of DEMO_CATEGORIES) {
    const found = db.select().from(categories).where(eq(categories.name, name)).get();
    categoryIds.set(name, found ? found.id : createCategory(db, { name }, actor));
  }

  const openingItems: {
    productId: number;
    direction: 'IN';
    qty: Qty;
    totalCost: Minor;
  }[] = [];

  for (const demo of DEMO_PRODUCTS) {
    const productId = createProduct(
      db,
      {
        name: demo.name,
        sku: demo.sku,
        ...(demo.barcode ? { barcode: demo.barcode } : {}),
        categoryId: categoryIds.get(demo.category) ?? null,
        unit: demo.unit,
        costPrice: m(demo.cost),
        sellingPrice: m(demo.price),
        minStock: u(demo.minStock),
        trackInventory: demo.service !== true,
      },
      actor,
    );

    // Mark the row as demo data so it can be purged wholesale.
    db.update(products).set({ isDemo: true }).where(eq(products.id, productId)).run();

    // Nothing to open a service with: no quantity ever sat in the yard.
    if (demo.service !== true) {
      openingItems.push({
        productId,
        direction: 'IN',
        qty: u(demo.openingQty),
        totalCost: m(demo.openingValue),
      });
    }
  }

  db.update(categories).set({ isDemo: true }).run();

  // One opening-stock document for the whole shop, exactly as an owner would do
  // it at setup. This posts Dr Inventory / Cr Opening Balance Equity.
  createStockAdjustment(
    db,
    {
      businessDate,
      reason: 'OPENING_STOCK',
      note: 'Demo opening stock',
      items: openingItems,
      isDemo: true,
    },
    actor,
  );
}
