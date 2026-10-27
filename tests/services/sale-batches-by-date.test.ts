import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { businessSettings, paymentAccounts, productBatches } from '@/db/schema';
import { writeTransaction } from '@/db/transaction';
import { createProduct } from '@/services/catalog.service';
import { createSale } from '@/services/sale.service';
import {
  recordStockMovement,
  verifyBatchCoverage,
  verifyProductBatches,
} from '@/services/inventory.service';
import { getTrialBalance } from '@/services/reporting/balances.service';
import { ValidationError } from '@/domain/errors';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * A sale takes stock that was on the shelf on the day it is dated.
 *
 * A sale entered late for an earlier day used to be picked from every batch
 * the product has now, including a delivery that arrived after it. The money
 * was right — cost is a pooled average, whichever crate went — but the batch
 * record was not: the recall trail named customers who bought from a delivery
 * before it reached the shop, and that crate's count went down while an older
 * one stayed full.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;
let MILK = 0;

/** Stock arriving on `businessDate`, in a batch of its own when it is dated. */
function deliver(qtyUnits: number, businessDate: string, expiryDate: string | null) {
  writeTransaction(context.db, (tx) =>
    recordStockMovement(tx, {
      productId: MILK,
      direction: 'IN',
      qty: u(qtyUnits),
      totalCost: m(300 * qtyUnits),
      movementType: 'PURCHASE',
      sourceType: 'TEST',
      businessDate,
      occurredAt: new Date(`${businessDate}T08:00:00Z`),
      batch: { kind: 'NEW', expiryDate },
    }),
  );
}

/**
 * A sale the till records on an earlier day: it passes `arrivedBy` exactly as
 * `createSaleAction` does when the chosen date is not today.
 */
function sellOn(businessDate: string, qtyUnits: number, options: { backdated?: boolean } = {}) {
  return createSale(
    context.db,
    {
      businessDate,
      items: [{ productId: MILK, qty: u(qtyUnits) }],
      tenders: [{ paymentAccountId: CASH, amount: m(500 * qtyUnits) }],
      ...(options.backdated !== false ? { arrivedBy: businessDate } : {}),
    },
    ACTOR,
  );
}

/** What each batch holds now, by the day it arrived. */
const leftByArrival = () =>
  Object.fromEntries(
    context.db
      .select()
      .from(productBatches)
      .where(eq(productBatches.productId, MILK))
      .orderBy(asc(productBatches.id))
      .all()
      .map((batch) => [batch.receivedDate, batch.qtyMilli / 1000]),
  );

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');

  CASH = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;
  MILK = createProduct(
    context.db,
    { name: 'Evaporated Milk', costPrice: m(300), sellingPrice: m(500), unit: 'tin' },
    ACTOR,
  );

  // Five tins on 1 August, ten more on 20 August. The later delivery expires
  // first, which is exactly what makes first-expiry-first-out reach for it.
  deliver(5, '2026-08-01', '2027-06-30');
  deliver(10, '2026-08-20', '2027-01-31');
});

afterEach(() => context.cleanup());

describe('a sale dated before a delivery', () => {
  it('takes the stock that was there that day, not the delivery that came later', () => {
    sellOn('2026-08-10', 3);

    expect(leftByArrival()).toEqual({ '2026-08-01': 2, '2026-08-20': 10 });
  });

  it('is refused when that day’s stock cannot cover it, and says why', () => {
    expect(() => sellOn('2026-08-10', 8)).toThrow(ValidationError);
    expect(() => sellOn('2026-08-10', 8)).toThrow(
      /On 10 Aug 2026 there was only 5 tin of Evaporated Milk in stock; the rest arrived later/,
    );

    expect(leftByArrival()).toEqual({ '2026-08-01': 5, '2026-08-20': 10 });
  });

  it('can use a delivery from the same day', () => {
    sellOn('2026-08-20', 3);

    expect(leftByArrival()).toEqual({ '2026-08-01': 5, '2026-08-20': 7 });
  });

  it('leaves the books and the batch records agreeing', () => {
    sellOn('2026-08-10', 3);

    expect(getTrialBalance(context.db).balanced).toBe(true);
    for (const row of verifyBatchCoverage(context.db)) {
      expect(row.ok, `coverage for product ${row.productId}`).toBe(true);
    }
    for (const check of verifyProductBatches(context.db, MILK)) {
      expect(check.ok, `batch ${check.batchId}`).toBe(true);
    }
  });
});

describe('a sale dated today', () => {
  it('still reaches for the stock that expires first', () => {
    sellOn('2026-08-25', 3, { backdated: false });

    expect(leftByArrival()).toEqual({ '2026-08-01': 5, '2026-08-20': 7 });
  });
});

describe('a sale nobody re-dated', () => {
  // Seeds, imports and quote conversions call createSale directly without
  // `arrivedBy`. They pick from every open batch, exactly as before.
  it('is picked as it always was', () => {
    sellOn('2026-08-10', 3, { backdated: false });

    expect(leftByArrival()).toEqual({ '2026-08-01': 5, '2026-08-20': 7 });
  });
});

describe('a shop that allows negative stock', () => {
  it('records the shortfall on the undated batch rather than refusing', () => {
    context.db
      .update(businessSettings)
      .set({ allowNegativeStock: true })
      .where(eq(businessSettings.id, 1))
      .run();

    sellOn('2026-08-10', 8);

    const left = leftByArrival();
    // The early crate is emptied, the later one untouched; the rest is owed.
    expect(left['2026-08-01']).toBe(0);
    expect(left['2026-08-20']).toBe(10);
  });
});

describe('stock that predates batches', () => {
  it('counts as on the shelf for any earlier day', () => {
    // Migration 0019 stamped pre-existing stock with the day it ran. That
    // stock was already in the shop, so a sale dated before it may use it.
    context.connection
      .prepare(
        `INSERT INTO product_batches
           (product_id, batch_ref, expiry_date, received_date, qty_milli, opening_qty_milli,
            source_type, is_closed, is_demo, created_at, updated_at)
         VALUES (?, 'BAT-OPEN-00099', NULL, '2026-09-01', 2000, 2000, 'OPENING', 0, 0, 0, 0)`,
      )
      .run(MILK);

    sellOn('2026-07-15', 1);

    const opening = context.db
      .select()
      .from(productBatches)
      .where(eq(productBatches.batchRef, 'BAT-OPEN-00099'))
      .get();
    expect(opening?.qtyMilli).toBe(1000);
  });
});
