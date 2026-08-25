import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import {
  auditLogs,
  businessSettings,
  paymentAccounts,
  productBatches,
  products,
  sales,
} from '@/db/schema';
import { writeTransaction } from '@/db/transaction';
import { createProduct } from '@/services/catalog.service';
import { createSale, voidSale } from '@/services/sale.service';
import { createCustomerReturn, getReturnableSaleItems } from '@/services/returns.service';
import {
  recordStockMovement,
  verifyBatchCoverage,
  verifyProductBatches,
  verifyProductStock,
} from '@/services/inventory.service';
import { getTrialBalance } from '@/services/reporting/balances.service';
import { ExpiredStockError } from '@/domain/errors';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * The block, and the one way past it.
 *
 * This is the point of the whole feature, and also the part most likely to do
 * harm. A shop where the till refuses sales it should not is a shop that stops
 * using the till: the goods go out anyway, off the books, and then nothing in
 * this application is true any more. So the rules are narrow and tested from
 * both sides.
 *
 *   - Expired stock is SKIPPED, silently, whenever good stock covers the sale.
 *     Not flagged, not warned about, not mentioned. That is the common case.
 *   - It blocks only when there is nothing else left, and then it is a question
 *     for somebody who can answer, not an error the cashier caused.
 *   - Nothing is written when it blocks. The whole transaction rolls back.
 *   - A shop that does not want any of this turns it off in settings.
 *
 * Coverage is asserted after every one of them: whatever happens, every unit of
 * stock still belongs to a batch.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-25';
const GONE = '2026-08-01';
const SOON = '2026-09-10';
const LATER = '2027-01-31';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;

function makeProduct(name = 'Evaporated Milk'): number {
  return createProduct(
    context.db,
    { name, costPrice: m(300), sellingPrice: m(500), unit: 'tin' },
    ACTOR,
  );
}

/** Stock in, into a batch with the given date. */
function deliver(productId: number, qtyUnits: number, expiryDate: string | null): number {
  const result = writeTransaction(context.db, (tx) =>
    recordStockMovement(tx, {
      productId,
      direction: 'IN',
      qty: u(qtyUnits),
      totalCost: m(300 * qtyUnits),
      movementType: 'PURCHASE',
      sourceType: 'TEST',
      businessDate: TODAY,
      occurredAt: new Date(`${TODAY}T08:00:00Z`),
      batch: { kind: 'NEW', expiryDate },
    }),
  );
  return result.batchAllocations[0]!.batchId;
}

function sell(productId: number, qtyUnits: number, options: { allowExpired?: boolean } = {}) {
  return createSale(
    context.db,
    {
      businessDate: TODAY,
      items: [{ productId, qty: u(qtyUnits) }],
      tenders: [{ paymentAccountId: CASH, amount: m(500 * qtyUnits) }],
      ...(options.allowExpired === true
        ? { allowExpiredStock: true, overrideReason: 'Customer was told and still wanted it' }
        : {}),
    },
    ACTOR,
  );
}

const batchesOf = (productId: number) =>
  context.db
    .select()
    .from(productBatches)
    .where(eq(productBatches.productId, productId))
    .orderBy(asc(productBatches.id))
    .all();

/** Everything that must be true whatever the till just did. */
function expectHealthy(label: string): void {
  for (const row of verifyBatchCoverage(context.db)) {
    expect(row.ok, `${label}: coverage for product ${row.productId}`).toBe(true);
  }
  for (const product of context.db.select({ id: products.id }).from(products).all()) {
    expect(verifyProductStock(context.db, product.id).ok, `${label}: stock p${product.id}`).toBe(
      true,
    );
    for (const check of verifyProductBatches(context.db, product.id)) {
      expect(check.ok, `${label}: batch ${check.batchId}`).toBe(true);
    }
  }
  expect(getTrialBalance(context.db).balanced, `${label}: trial balance`).toBe(true);
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
});

afterEach(() => context.cleanup());

describe('an old crate at the back of the shelf', () => {
  it('is not mentioned while there is good stock to sell', () => {
    const milk = makeProduct();
    const expired = deliver(milk, 20, GONE);
    const good = deliver(milk, 30, SOON);

    sell(milk, 5);

    const held = new Map(batchesOf(milk).map((b) => [b.id, b.qtyMilli]));
    expect(held.get(expired), 'the expired crate is untouched').toBe(20_000);
    expect(held.get(good)).toBe(25_000);
    expectHealthy('sale covered by good stock');
  });

  it('blocks the sale once the good stock runs out', () => {
    const milk = makeProduct();
    deliver(milk, 20, GONE);
    deliver(milk, 3, SOON);

    expect(() => sell(milk, 5)).toThrow(ExpiredStockError);
  });

  it('writes nothing at all when it blocks', () => {
    const milk = makeProduct();
    const expired = deliver(milk, 20, GONE);
    const good = deliver(milk, 3, SOON);

    expect(() => sell(milk, 5)).toThrow(ExpiredStockError);

    // Not the sale, not the stock, not the money. The throw happens inside the
    // transaction that would have done all three.
    expect(context.db.select().from(sales).all()).toEqual([]);
    const held = new Map(batchesOf(milk).map((b) => [b.id, b.qtyMilli]));
    expect(held.get(expired)).toBe(20_000);
    expect(held.get(good)).toBe(3_000);
    expectHealthy('after a refused sale');
  });

  it('names the goods and the crate, so somebody can be asked about them', () => {
    const milk = makeProduct('Ideal Milk 170g');
    deliver(milk, 20, GONE);
    deliver(milk, 3, SOON);

    try {
      sell(milk, 5);
      expect.unreachable('the sale should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ExpiredStockError);
      const details = (error as ExpiredStockError).details as {
        productName: string;
        qtyExpired: string;
        batchRefs: string[];
      };
      expect(details.productName).toBe('Ideal Milk 170g');
      expect(details.qtyExpired).toBe('2');
      expect(details.batchRefs).toHaveLength(1);
      expect((error as ExpiredStockError).userMessage).toContain('Ideal Milk 170g');
    }
  });
});

describe('when somebody senior says yes', () => {
  it('completes the sale, taking the good stock first', () => {
    const milk = makeProduct();
    const expired = deliver(milk, 20, GONE);
    const good = deliver(milk, 3, SOON);

    sell(milk, 5, { allowExpired: true });

    const held = new Map(batchesOf(milk).map((b) => [b.id, b.qtyMilli]));
    expect(held.get(good), 'good stock went first').toBe(0);
    expect(held.get(expired)).toBe(18_000);
    expectHealthy('approved sale of expired stock');
  });

  it('records who did it and which crate it came out of', () => {
    const milk = makeProduct();
    deliver(milk, 20, GONE);
    deliver(milk, 3, SOON);

    const sale = sell(milk, 5, { allowExpired: true });

    const override = context.db
      .select()
      .from(auditLogs)
      .all()
      .find((row) => row.entityType === 'expiry_override');

    expect(override, 'an override leaves its own audit row').toBeDefined();
    expect(override!.username).toBe('kwame');
    expect(override!.entityId).toBe(String(sale.saleId));
    expect(override!.summary).toContain(sale.receiptNo);

    const metadata = JSON.parse(override!.metadata ?? '{}') as {
      batchRefs: string[];
      reason?: string;
    };
    expect(metadata.batchRefs).toHaveLength(1);
    expect(override!.summary).toContain(metadata.batchRefs[0]!);
    expect(metadata.reason).toBe('Customer was told and still wanted it');
  });

  it('leaves no override row behind on an ordinary sale', () => {
    // The flag being SET is not the fact worth recording — reaching expired
    // stock is. A shop where every sale carries an override row has an audit
    // log nobody reads.
    const milk = makeProduct();
    deliver(milk, 20, GONE);
    deliver(milk, 30, SOON);

    sell(milk, 5, { allowExpired: true });

    expect(
      context.db
        .select()
        .from(auditLogs)
        .all()
        .filter((row) => row.entityType === 'expiry_override'),
    ).toEqual([]);
  });

  it('takes the oldest expired crate first', () => {
    const milk = makeProduct();
    const older = deliver(milk, 4, '2026-01-01');
    const newer = deliver(milk, 4, '2026-06-01');

    sell(milk, 6, { allowExpired: true });

    const held = new Map(batchesOf(milk).map((b) => [b.id, b.qtyMilli]));
    expect(held.get(older)).toBe(0);
    expect(held.get(newer)).toBe(2_000);
    expectHealthy('two expired crates');
  });
});

describe('a shop that does not want any of this', () => {
  it('sells expired stock without anybody being asked', () => {
    context.db
      .update(businessSettings)
      .set({ expiryBlocksSales: false })
      .where(eq(businessSettings.id, 1))
      .run();

    const milk = makeProduct();
    const expired = deliver(milk, 20, GONE);
    deliver(milk, 3, SOON);

    // No `allowExpiredStock`, and no refusal.
    sell(milk, 5);

    expect(batchesOf(milk).find((b) => b.id === expired)!.qtyMilli).toBe(18_000);
    expectHealthy('block turned off');
  });

  it('still records nothing as an override, because nobody overrode anything', () => {
    context.db
      .update(businessSettings)
      .set({ expiryBlocksSales: false })
      .where(eq(businessSettings.id, 1))
      .run();

    const milk = makeProduct();
    deliver(milk, 20, GONE);
    sell(milk, 5);

    expect(
      context.db
        .select()
        .from(auditLogs)
        .all()
        .filter((row) => row.entityType === 'expiry_override'),
    ).toEqual([]);
  });
});

describe('first-expiry-first-out among good stock', () => {
  it('picks the earlier date first', () => {
    const milk = makeProduct();
    const later = deliver(milk, 5, LATER);
    const soon = deliver(milk, 5, SOON);

    sell(milk, 7);

    const held = new Map(batchesOf(milk).map((b) => [b.id, b.qtyMilli]));
    expect(held.get(soon)).toBe(0);
    expect(held.get(later)).toBe(3_000);
    expectHealthy('fefo across two good crates');
  });

  it('drains dated stock before undated, which has no deadline', () => {
    const milk = makeProduct();
    const undated = deliver(milk, 5, null);
    const dated = deliver(milk, 5, LATER);

    sell(milk, 5);

    const held = new Map(batchesOf(milk).map((b) => [b.id, b.qtyMilli]));
    expect(held.get(dated)).toBe(0);
    expect(held.get(undated)).toBe(5_000);
    expectHealthy('dated before undated');
  });
});

describe('goods coming back', () => {
  it('a void returns each unit to the crate it left', () => {
    const milk = makeProduct();
    const soon = deliver(milk, 4, SOON);
    const later = deliver(milk, 10, LATER);

    // Takes all 4 of the tighter crate and 3 of the other.
    const sale = sell(milk, 7);
    expect(batchesOf(milk).find((b) => b.id === soon)!.qtyMilli).toBe(0);

    voidSale(context.db, sale.saleId, 'Customer changed their mind', ACTOR);

    const held = new Map(batchesOf(milk).map((b) => [b.id, b.qtyMilli]));
    expect(held.get(soon), 'the emptied crate is refilled, not replaced').toBe(4_000);
    expect(held.get(later)).toBe(10_000);
    expect(batchesOf(milk)).toHaveLength(2);
    expectHealthy('voided sale');
  });

  it('a partial return of a two-crate line splits in proportion', () => {
    const milk = makeProduct();
    const soon = deliver(milk, 2, SOON);
    const later = deliver(milk, 10, LATER);

    // 2 from the tighter crate, 6 from the other.
    const sale = sell(milk, 8);

    const items = getReturnableSaleItems(context.db, sale.saleId);
    createCustomerReturn(
      context.db,
      sale.saleId,
      {
        businessDate: TODAY,
        items: [{ itemId: items[0]!.id, qty: u(4) }],
        refunds: [{ paymentAccountId: CASH, amount: m(2_000) }],
      },
      ACTOR,
    );

    // Half the line came back, so half of each crate's share does.
    const held = new Map(batchesOf(milk).map((b) => [b.id, b.qtyMilli]));
    expect(held.get(soon)).toBe(1_000);
    expect(held.get(later)).toBe(7_000);
    expectHealthy('partial return across two crates');
  });

  it('still voids a sale made before batches existed', () => {
    const milk = makeProduct();
    deliver(milk, 10, LATER);
    const sale = sell(milk, 4);

    // As a pre-migration receipt looks: no split to put back.
    context.connection.prepare('DELETE FROM stock_ledger_batches').run();

    voidSale(context.db, sale.saleId, 'Rung up twice', ACTOR);

    expect(verifyProductStock(context.db, milk).ok).toBe(true);
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });
});
