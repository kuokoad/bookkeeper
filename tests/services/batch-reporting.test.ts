import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts, productBatches, products } from '@/db/schema';
import { writeTransaction } from '@/db/transaction';
import { createProduct, hasDatedStock } from '@/services/catalog.service';
import { createSupplier } from '@/services/supplier.service';
import { createCustomer } from '@/services/customer.service';
import { createPurchase, voidPurchase } from '@/services/purchase.service';
import { createSale, voidSale } from '@/services/sale.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import {
  EXPIRY_BUCKETS,
  getBatchHistory,
  getExpiryAgeing,
  listProductBatches,
  recordStockMovement,
  setBatchExpiry,
} from '@/services/inventory.service';
import { search } from '@/services/search.service';
import type { Principal } from '@/lib/auth/permissions';
import { NotFoundError, ValidationError } from '@/domain/errors';
import { auditLogs } from '@/db/schema';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import { addDays } from '@/domain/business-date';

/**
 * Reading it back.
 *
 * Everything before this phase wrote batch data down. This is the part that
 * makes it worth having written: the shop can see how long its stock has left,
 * and — on the day a supplier telephones about a bad lot — can name the
 * customers who took it home.
 *
 * The recall answer is the payoff for a decision made in Phase 1: the batch
 * split hangs off the LEDGER ROW rather than the sale line, so one join
 * through `sourceType`/`sourceId` answers the question for sales, returns,
 * voids and write-offs alike.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-25';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;
let SUPPLIER = 0;

const OWNER: Principal = {
  id: 1,
  username: 'kwame',
  displayName: 'Kwame',
  role: 'OWNER',
  permissions: {},
};

function makeProduct(name = 'Evaporated Milk'): number {
  return createProduct(
    context.db,
    { name, costPrice: m(300), sellingPrice: m(500), unit: 'tin' },
    ACTOR,
  );
}

/** Stock in, into a batch with the given date. Returns the batch id. */
function deliver(productId: number, qtyUnits: number, expiryDate: string | null): number {
  return writeTransaction(context.db, (tx) =>
    recordStockMovement(tx, {
      productId,
      direction: 'IN',
      qty: u(qtyUnits),
      totalCost: m(300 * qtyUnits),
      movementType: 'PURCHASE',
      sourceType: 'TEST',
      businessDate: TODAY,
      occurredAt: new Date(`${TODAY}T08:00:00Z`),
      userId: 1,
      batch: { kind: 'NEW', expiryDate },
    }),
  ).batchAllocations[0]!.batchId;
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  CASH = context.db
    .select()
    .from(paymentAccounts)
    .all()
    .find((account) => account.kind === 'CASH')!.id;
  SUPPLIER = createSupplier(context.db, { name: 'Kofi Wholesale' }, ACTOR);
});

afterEach(() => context.cleanup());

describe('how long the stock has left', () => {
  it('puts every batch in exactly one bucket, adding up to the shelf', () => {
    const milk = makeProduct();
    deliver(milk, 3, addDays(TODAY, -1)); // expired
    deliver(milk, 5, addDays(TODAY, 3)); // within 7
    deliver(milk, 7, addDays(TODAY, 20)); // within 30
    deliver(milk, 11, addDays(TODAY, 60)); // within 90
    deliver(milk, 13, addDays(TODAY, 400)); // later
    deliver(milk, 17, null); // undated

    const ageing = getExpiryAgeing(context.db, TODAY);
    const byBucket = new Map(ageing.map((row) => [row.bucket, row]));

    expect(byBucket.get('expired')!.qtyMilli).toBe(3_000);
    expect(byBucket.get('within7')!.qtyMilli).toBe(5_000);
    expect(byBucket.get('within30')!.qtyMilli).toBe(7_000);
    expect(byBucket.get('within90')!.qtyMilli).toBe(11_000);
    expect(byBucket.get('later')!.qtyMilli).toBe(13_000);
    expect(byBucket.get('undated')!.qtyMilli).toBe(17_000);

    // The whole point of buckets: they account for everything, once.
    const total = ageing.reduce((sum, row) => sum + row.qtyMilli, 0);
    const shelf = context.db.select().from(products).where(eq(products.id, milk)).get()!;
    expect(total).toBe(shelf.qtyOnHandMilli);
    expect(ageing.reduce((sum, row) => sum + row.batchCount, 0)).toBe(6);
  });

  it('never files undated stock under "later", because unknown is not distant', () => {
    // A shop whose perishables all arrived before it started dating would
    // otherwise be told its stock runs out in a year or more.
    const bread = makeProduct('Tea Bread');
    deliver(bread, 20, null);

    const ageing = getExpiryAgeing(context.db, TODAY);
    const byBucket = new Map(ageing.map((row) => [row.bucket, row]));
    expect(byBucket.get('later')!.qtyMilli).toBe(0);
    expect(byBucket.get('undated')!.qtyMilli).toBe(20_000);
  });

  it('counts the last good day as still good', () => {
    const milk = makeProduct();
    deliver(milk, 4, TODAY);

    const byBucket = new Map(getExpiryAgeing(context.db, TODAY).map((row) => [row.bucket, row]));
    expect(byBucket.get('expired')!.qtyMilli).toBe(0);
    expect(byBucket.get('within7')!.qtyMilli).toBe(4_000);
  });

  it('returns every bucket even when the shop has no stock at all', () => {
    // A report with rows missing reads as a report that failed.
    const ageing = getExpiryAgeing(context.db, TODAY);
    expect(ageing.map((row) => row.bucket)).toEqual([...EXPIRY_BUCKETS]);
    expect(ageing.every((row) => row.qtyMilli === 0 && row.batchCount === 0)).toBe(true);
  });

  it('drops a batch out once it is emptied', () => {
    const milk = makeProduct();
    deliver(milk, 4, addDays(TODAY, 3));
    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'DAMAGED',
        items: [{ productId: milk, direction: 'OUT', qty: u(4) }],
      },
      ACTOR,
    );

    expect(getExpiryAgeing(context.db, TODAY).every((row) => row.batchCount === 0)).toBe(true);
  });
});

describe('tracing a delivery to the people who took it home', () => {
  it('lists the delivery in and every sale out, in order', () => {
    const milk = makeProduct();
    const ama = createCustomer(context.db, { name: 'Ama Serwaa' }, ACTOR);

    createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId: SUPPLIER,
        items: [{ productId: milk, qty: u(10), unitCost: m(300), expiryDate: addDays(TODAY, 30) }],
        tenders: [{ paymentAccountId: CASH, amount: m(3_000) }],
      },
      ACTOR,
    );

    const batchId = context.db.select().from(productBatches).all()[0]!.id;

    createSale(
      context.db,
      {
        businessDate: TODAY,
        customerId: ama,
        items: [{ productId: milk, qty: u(3) }],
        tenders: [{ paymentAccountId: CASH, amount: m(1_500) }],
      },
      ACTOR,
    );
    createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: milk, qty: u(2) }],
        tenders: [{ paymentAccountId: CASH, amount: m(1_000) }],
      },
      ACTOR,
    );

    const history = getBatchHistory(context.db, batchId);

    expect(history.batch.batchRef).toMatch(/^BAT-\d{5}$/);
    expect(history.batch.productName).toBe('Evaporated Milk');
    expect(history.batch.supplierName).toBe('Kofi Wholesale');
    expect(history.batch.qtyMilli).toBe(5_000);

    expect(
      history.entries.map((entry) => [entry.sourceType, entry.qtyInMilli, entry.qtyOutMilli]),
    ).toEqual([
      ['PURCHASE', 10_000, 0],
      ['SALE', 0, 3_000],
      ['SALE', 0, 2_000],
    ]);

    // The names are the point. A walk-in is a real answer, not a missing one:
    // it is the customer who cannot be telephoned.
    expect(history.entries.map((entry) => entry.partyName)).toEqual([
      'Kofi Wholesale',
      'Ama Serwaa',
      'Walk-in customer',
    ]);
    expect(history.entries.every((entry) => entry.sourceRef !== null)).toBe(true);
  });

  it('shows a void as its own line rather than erasing the sale', () => {
    const milk = makeProduct();
    createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId: SUPPLIER,
        items: [{ productId: milk, qty: u(10), unitCost: m(300), expiryDate: addDays(TODAY, 30) }],
        tenders: [{ paymentAccountId: CASH, amount: m(3_000) }],
      },
      ACTOR,
    );
    const batchId = context.db.select().from(productBatches).all()[0]!.id;

    const sale = createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: milk, qty: u(4) }],
        tenders: [{ paymentAccountId: CASH, amount: m(2_000) }],
      },
      ACTOR,
    );
    voidSale(context.db, sale.saleId, 'Rang it up twice', ACTOR);

    const history = getBatchHistory(context.db, batchId);
    expect(history.entries.map((entry) => entry.sourceType)).toEqual([
      'PURCHASE',
      'SALE',
      'SALE_VOID',
    ]);
    expect(history.batch.qtyMilli).toBe(10_000);
  });

  it('follows a voided delivery back out of the crate it filled', () => {
    const milk = makeProduct();
    const purchase = createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId: SUPPLIER,
        items: [{ productId: milk, qty: u(6), unitCost: m(300), expiryDate: addDays(TODAY, 30) }],
        tenders: [{ paymentAccountId: CASH, amount: m(1_800) }],
      },
      ACTOR,
    );
    const batchId = context.db.select().from(productBatches).all()[0]!.id;

    voidPurchase(context.db, purchase.purchaseId, 'Never arrived', ACTOR);

    const history = getBatchHistory(context.db, batchId);
    expect(history.entries.map((entry) => entry.sourceType)).toEqual([
      'PURCHASE',
      'PURCHASE_VOID',
    ]);
    expect(history.entries[1]!.partyName).toBe('Kofi Wholesale');
    expect(history.batch.qtyMilli).toBe(0);
    expect(history.batch.isClosed).toBe(true);
  });

  it('has nothing to show for a batch the migration opened', () => {
    // An opening batch was never delivered by anybody: it is what was on the
    // shelf on the day. The page has to survive saying so.
    const milk = makeProduct();
    context.connection
      .prepare(
        `INSERT INTO product_batches
           (product_id, batch_ref, expiry_date, received_date, qty_milli, opening_qty_milli,
            source_type, is_closed, is_demo, created_at, updated_at)
         VALUES (?, 'BAT-OPEN-00001', NULL, ?, 5000, 5000, 'OPENING', 0, 0, 0, 0)`,
      )
      .run(milk, TODAY);

    const batchId = context.db.select().from(productBatches).all()[0]!.id;
    const history = getBatchHistory(context.db, batchId);

    expect(history.entries).toEqual([]);
    expect(history.batch.openingQtyMilli).toBe(5_000);
    expect(history.batch.supplierName).toBeNull();
  });

  it('refuses a batch that does not exist', () => {
    expect(() => getBatchHistory(context.db, 9_999)).toThrow(NotFoundError);
  });
});

describe('finding a batch by its reference', () => {
  it('is what somebody holding the crate types in', () => {
    const milk = makeProduct();
    const batchId = deliver(milk, 10, addDays(TODAY, 30));
    const batch = context.db
      .select()
      .from(productBatches)
      .where(eq(productBatches.id, batchId))
      .get()!;

    const hits = search(context.db, batch.batchRef, OWNER).groups.flatMap((group) => group.hits);
    const hit = hits.find((row) => row.kind === 'batch');

    expect(hit, `searching "${batch.batchRef}" should find it`).toBeDefined();
    expect(hit!.id).toBe(batchId);
    expect(hit!.href).toBe(`/inventory/batches/${batchId}`);
    expect(hit!.title).toBe(batch.batchRef);
    expect(hit!.detail).toContain('Evaporated Milk');
  });

  it('finds it by product name too, which is what people actually remember', () => {
    const milk = makeProduct();
    deliver(milk, 10, addDays(TODAY, 30));

    const hits = search(context.db, 'Evaporated', OWNER).groups.flatMap((group) => group.hits);
    expect(hits.some((row) => row.kind === 'batch')).toBe(true);
  });

  it('does not offer a batch that is closed and empty', () => {
    const milk = makeProduct();
    const batchId = deliver(milk, 4, addDays(TODAY, 30));
    const batch = context.db
      .select()
      .from(productBatches)
      .where(eq(productBatches.id, batchId))
      .get()!;

    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'DAMAGED',
        items: [{ productId: milk, direction: 'OUT', qty: u(4) }],
      },
      ACTOR,
    );

    // Still reachable by its exact reference — a recall is about a crate that
    // has GONE — but it should not clutter a search for the product.
    const byRef = search(context.db, batch.batchRef, OWNER).groups.flatMap((group) => group.hits);
    expect(byRef.some((row) => row.kind === 'batch')).toBe(true);

    const byName = search(context.db, 'Evaporated', OWNER).groups.flatMap((group) => group.hits);
    expect(byName.some((row) => row.kind === 'batch')).toBe(false);
  });
});

describe('correcting the date on a crate', () => {
  /**
   * The opening batch is a lie the shop has to be allowed to correct.
   *
   * On the day this is installed, everything already on the shelf lands in an
   * undated batch — the goods were bought before anybody was asked for a date.
   * For a shop selling milk that says "this stock does not expire", which is
   * false, and no amount of trading afterwards makes it true.
   */
  it('gives a date to stock that arrived without one', () => {
    const milk = makeProduct();
    const batchId = deliver(milk, 10, null);

    setBatchExpiry(context.db, batchId, addDays(TODAY, 5), ACTOR);

    const batch = context.db
      .select()
      .from(productBatches)
      .where(eq(productBatches.id, batchId))
      .get()!;
    expect(batch.expiryDate).toBe(addDays(TODAY, 5));
  });

  it('changes which crate the till reaches for next', () => {
    // The whole point. Before: the dated crate leads and the undated one waits.
    // After: the corrected crate expires sooner, so it goes first.
    const milk = makeProduct();
    const undated = deliver(milk, 10, null);
    const dated = deliver(milk, 10, addDays(TODAY, 60));

    expect(listProductBatches(context.db, milk, TODAY).map((row) => row.id)).toEqual([
      dated,
      undated,
    ]);

    setBatchExpiry(context.db, undated, addDays(TODAY, 3), ACTOR);

    expect(listProductBatches(context.db, milk, TODAY).map((row) => row.id)).toEqual([
      undated,
      dated,
    ]);
  });

  it('records what it was before, not just what it is now', () => {
    const milk = makeProduct();
    const batchId = deliver(milk, 10, addDays(TODAY, 30));

    setBatchExpiry(context.db, batchId, addDays(TODAY, 2), ACTOR);

    const entry = context.db
      .select()
      .from(auditLogs)
      .all()
      .find((row) => row.entityType === 'product_batch');

    expect(entry, 'changing a date is audited').toBeDefined();
    const metadata = JSON.parse(entry!.metadata ?? '{}') as {
      before: { expiryDate: string | null };
      after: { expiryDate: string | null };
    };
    expect(metadata.before.expiryDate).toBe(addDays(TODAY, 30));
    expect(metadata.after.expiryDate).toBe(addDays(TODAY, 2));
  });

  it('writes nothing when the date has not actually changed', () => {
    const milk = makeProduct();
    const batchId = deliver(milk, 10, addDays(TODAY, 30));

    setBatchExpiry(context.db, batchId, addDays(TODAY, 30), ACTOR);

    expect(
      context.db
        .select()
        .from(auditLogs)
        .all()
        .filter((row) => row.entityType === 'product_batch'),
    ).toEqual([]);
  });

  it('can take a date away again', () => {
    const milk = makeProduct();
    const batchId = deliver(milk, 10, addDays(TODAY, 30));

    setBatchExpiry(context.db, batchId, null, ACTOR);

    expect(
      context.db.select().from(productBatches).where(eq(productBatches.id, batchId)).get()!
        .expiryDate,
    ).toBeNull();
  });

  it('refuses a date that is not a date', () => {
    const milk = makeProduct();
    const batchId = deliver(milk, 10, null);

    expect(() => setBatchExpiry(context.db, batchId, '31/12/2027', ACTOR)).toThrow(ValidationError);
  });

  it('refuses a batch that does not exist', () => {
    expect(() => setBatchExpiry(context.db, 9_999, TODAY, ACTOR)).toThrow(NotFoundError);
  });

  it('does not touch the quantity, which only a movement may change', () => {
    const milk = makeProduct();
    const batchId = deliver(milk, 10, null);

    setBatchExpiry(context.db, batchId, addDays(TODAY, 5), ACTOR);

    const batch = context.db
      .select()
      .from(productBatches)
      .where(eq(productBatches.id, batchId))
      .get()!;
    expect(batch.qtyMilli).toBe(10_000);
  });
});

/**
 * Whether anything on the shelf carries a date.
 *
 * This is what decides whether a shop that has switched expiry dates off must
 * still be shown the settings that govern them — so it decides whether an owner
 * can reach the switch that is refusing sales at the till.
 */
const SOON = '2026-09-10';

describe('whether the shop has anything dated', () => {
  it('is false in a shop that has never entered a date', () => {
    const milk = makeProduct('Evaporated Milk');
    deliver(milk, 20, null);

    expect(hasDatedStock(context.db)).toBe(false);
  });

  it('is true the moment one delivery carries a date', () => {
    const milk = makeProduct('Evaporated Milk');
    deliver(milk, 20, null);
    deliver(milk, 5, SOON);

    expect(hasDatedStock(context.db)).toBe(true);
  });

  it('is false again once the dated stock is gone', () => {
    const milk = makeProduct('Evaporated Milk');
    const batch = deliver(milk, 5, SOON);

    context.db
      .update(productBatches)
      .set({ qtyMilli: 0, isClosed: true })
      .where(eq(productBatches.id, batch))
      .run();

    expect(hasDatedStock(context.db)).toBe(false);
  });
});
