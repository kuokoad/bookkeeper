import { sql } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { productBatches, products } from '@/db/schema';
import { writeTransaction } from '@/db/transaction';

/**
 * Give every product holding stock an undated opening batch, if it has none.
 *
 * The same job migration 0019 does for a shop that already existed, for stock
 * that arrives afterwards by a path which does not yet allocate batches itself.
 * Today that means the demo seed, whose products are created after the
 * migration has run and whose stock moves through the ordinary services.
 *
 * Idempotent: a product that already has any batch is left alone, so running it
 * twice cannot double-count a shelf.
 *
 * Undated on purpose, exactly as the migration leaves real stock. Nothing here
 * carries a date anybody entered, and inventing one would put a warning — or a
 * refused sale — behind a number nobody chose.
 */
export function openOpeningBatches(db: Db, receivedDate: string): number {
  return writeTransaction(db, (tx) => {
    const uncovered = tx.all<{ id: number; qty: number; isDemo: number }>(sql`
      SELECT p.id AS id, p.qty_on_hand_milli AS qty, p.is_demo AS isDemo
      FROM products p
      WHERE p.track_inventory = 1
        AND p.qty_on_hand_milli <> 0
        AND NOT EXISTS (SELECT 1 FROM product_batches b WHERE b.product_id = p.id)
    `);

    for (const product of uncovered) {
      tx.insert(productBatches)
        .values({
          productId: product.id,
          // Outside the BAT-##### sequence, like the migration's, so the first
          // real delivery still opens BAT-00001.
          batchRef: `BAT-OPEN-${String(product.id).padStart(5, '0')}`,
          expiryDate: null,
          receivedDate,
          qtyMilli: product.qty,
          // Recorded rather than derived — see `verifyProductBatches`.
          openingQtyMilli: product.qty,
          sourceType: 'OPENING',
          isDemo: product.isDemo === 1,
        })
        .run();
    }

    return uncovered.length;
  });
}

/** Whether any stock is not yet owned by a batch. Used by tests and tooling. */
export function countUncoveredProducts(db: Db): number {
  const row = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(products)
    .where(
      sql`${products.trackInventory} = 1
        AND ${products.qtyOnHandMilli} <> 0
        AND NOT EXISTS (SELECT 1 FROM product_batches b WHERE b.product_id = ${products.id})`,
    )
    .get();
  return row?.n ?? 0;
}
