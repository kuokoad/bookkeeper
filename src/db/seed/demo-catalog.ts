import { eq } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { categories, products } from '@/db/schema';
import { createCategory, createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import type { Actor } from '@/services/journal.service';

/**
 * Demo catalogue for development: a plausible Ghanaian corner shop.
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
}

const DEMO_CATEGORIES = ['Drinks', 'Food', 'Snacks', 'Household'] as const;

const DEMO_PRODUCTS: readonly DemoProduct[] = [
  {
    name: 'Coca-Cola 350ml',
    category: 'Drinks',
    sku: 'COKE350',
    barcode: '5449000000996',
    unit: 'bottle',
    cost: 4.5,
    price: 6,
    minStock: 24,
    openingQty: 72,
    openingValue: 324,
  },
  {
    name: 'Bottled Water 750ml',
    category: 'Drinks',
    sku: 'WATER750',
    barcode: '6001240100015',
    unit: 'bottle',
    cost: 1.8,
    price: 3,
    minStock: 48,
    openingQty: 120,
    openingValue: 216,
  },
  {
    name: 'Milo Tin 400g',
    category: 'Drinks',
    sku: 'MILO400',
    barcode: '6001068600014',
    unit: 'tin',
    cost: 38,
    price: 46,
    minStock: 6,
    openingQty: 18,
    openingValue: 684,
  },
  {
    name: 'Evaporated Milk 170g',
    category: 'Food',
    sku: 'MILK170',
    unit: 'tin',
    cost: 6.5,
    price: 9,
    minStock: 12,
    openingQty: 40,
    openingValue: 260,
  },
  {
    name: 'Tea Bread',
    category: 'Food',
    sku: 'BREAD-TEA',
    unit: 'loaf',
    cost: 8,
    price: 12,
    minStock: 5,
    // Deliberately low so the low-stock warning is visible in the demo.
    openingQty: 4,
    openingValue: 32,
  },
  {
    name: 'Digestive Biscuits',
    category: 'Snacks',
    sku: 'BISC-DIG',
    unit: 'pack',
    cost: 5.2,
    price: 8,
    minStock: 10,
    openingQty: 30,
    openingValue: 156,
  },
  {
    name: 'Groundnuts 100g',
    category: 'Snacks',
    sku: 'NUTS100',
    unit: 'pack',
    cost: 2.5,
    price: 4,
    minStock: 15,
    openingQty: 45,
    openingValue: 112.5,
  },
  {
    name: 'Key Soap',
    category: 'Household',
    sku: 'SOAP-KEY',
    unit: 'bar',
    cost: 4,
    price: 6,
    minStock: 12,
    openingQty: 36,
    openingValue: 144,
  },
  {
    name: 'Rice (local)',
    category: 'Food',
    sku: 'RICE-KG',
    unit: 'kg',
    cost: 14,
    price: 19,
    minStock: 10,
    // Fractional unit — proves the milli-unit quantity handling in the UI.
    openingQty: 25.5,
    openingValue: 357,
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
        trackInventory: true,
      },
      actor,
    );

    // Mark the row as demo data so it can be purged wholesale.
    db.update(products).set({ isDemo: true }).where(eq(products.id, productId)).run();

    openingItems.push({
      productId,
      direction: 'IN',
      qty: u(demo.openingQty),
      totalCost: m(demo.openingValue),
    });
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
