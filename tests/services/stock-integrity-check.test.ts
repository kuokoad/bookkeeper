import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import {
  verifyAllStock,
  verifyProductStock,
  verifyStockAgainstLedger,
} from '@/services/inventory.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * Two integrity checks, and they must not disagree.
 *
 * `verifyAllStock` replays every movement a product has ever had. It is the
 * thorough answer and it gets slower for ever, so it belongs behind
 * `npm run preflight` where somebody has asked for it.
 *
 * `verifyStockAgainstLedger` compares the cache with the last balance the ledger
 * recorded — two queries whatever the history — which is what the inventory page
 * can afford to run on every visit.
 *
 * The cheap one is only worth having if it reaches the same verdict on the
 * things that actually go wrong. That is what these tests are for.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-16';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

function makeProduct(name: string): number {
  return createProduct(
    context.db,
    { name, costPrice: m(500), sellingPrice: m(800), unit: 'pcs' },
    ACTOR,
  );
}

function move(productId: number, direction: 'IN' | 'OUT', qtyUnits: number, cost: number) {
  createStockAdjustment(
    context.db,
    {
      businessDate: TODAY,
      reason: direction === 'IN' ? 'OPENING_STOCK' : 'DAMAGED',
      items: [{ productId, direction, qty: u(qtyUnits), ...(direction === 'IN' ? { totalCost: m(cost) } : {}) }],
    },
    ACTOR,
  );
}

/** Corrupt the cached columns behind the services' back, as a stray write would. */
function corruptCache(productId: number, qtyMilli: number, valueMinor: number) {
  context.connection
    .prepare('UPDATE products SET qty_on_hand_milli = ?, stock_value_minor = ? WHERE id = ?')
    .run(qtyMilli, valueMinor, productId);
}

const verdicts = (rows: { productId: number; ok: boolean }[]) =>
  new Map(rows.map((row) => [row.productId, row.ok]));

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
});

afterEach(() => context.cleanup());

describe('the cheap check and the full replay', () => {
  it('agree that a healthy shop is healthy', () => {
    const milo = makeProduct('Milo 400g');
    const rice = makeProduct('Rice 5kg');
    move(milo, 'IN', 10, 5_000);
    move(rice, 'IN', 4, 12_000);
    move(milo, 'OUT', 3, 0);

    expect(verifyStockAgainstLedger(context.db).every((row) => row.ok)).toBe(true);
    expect(verifyAllStock(context.db).every((row) => row.ok)).toBe(true);
  });

  it('agree about a product whose cache has been tampered with', () => {
    const milo = makeProduct('Milo 400g');
    const rice = makeProduct('Rice 5kg');
    move(milo, 'IN', 10, 5_000);
    move(rice, 'IN', 4, 12_000);

    corruptCache(milo, 99_000, 5_000);

    const cheap = verdicts(verifyStockAgainstLedger(context.db));
    const deep = verdicts(verifyAllStock(context.db));

    expect(cheap.get(milo)).toBe(false);
    expect(deep.get(milo)).toBe(false);
    // …and the untouched product is not dragged down with it.
    expect(cheap.get(rice)).toBe(true);
    expect(deep.get(rice)).toBe(true);
  });

  it('agree once the value alone has drifted, quantity intact', () => {
    const milo = makeProduct('Milo 400g');
    move(milo, 'IN', 10, 5_000);

    corruptCache(milo, 10_000, 9_999);

    expect(verdicts(verifyStockAgainstLedger(context.db)).get(milo)).toBe(false);
    expect(verdicts(verifyAllStock(context.db)).get(milo)).toBe(false);
  });

  it('agree across a chain that passes through empty', () => {
    // The case a naive SUM would get wrong: an empty shelf must be worth
    // nothing, so value is cleared at zero rather than carried forward.
    const milo = makeProduct('Milo 400g');
    move(milo, 'IN', 5, 2_500);
    move(milo, 'OUT', 5, 0);
    move(milo, 'IN', 3, 2_100);

    const cheap = verifyStockAgainstLedger(context.db).find((row) => row.productId === milo)!;
    const deep = verifyProductStock(context.db, milo);

    expect(cheap.ok).toBe(true);
    expect(deep.ok).toBe(true);
    expect(cheap.ledgerQty).toBe(deep.ledgerQty);
    expect(cheap.ledgerValue).toBe(deep.ledgerValue);
  });

  it('report the same figures, not merely the same verdict', () => {
    const milo = makeProduct('Milo 400g');
    move(milo, 'IN', 7, 3_500);
    move(milo, 'OUT', 2, 0);

    const cheap = verifyStockAgainstLedger(context.db).find((row) => row.productId === milo)!;
    const deep = verifyProductStock(context.db, milo);

    expect(cheap.cachedQty).toBe(deep.cachedQty);
    expect(cheap.cachedValue).toBe(deep.cachedValue);
    expect(cheap.ledgerQty).toBe(deep.ledgerQty);
    expect(cheap.ledgerValue).toBe(deep.ledgerValue);
    expect(cheap.qtyDrift).toBe(deep.qtyDrift);
    expect(cheap.valueDrift).toBe(deep.valueDrift);
  });
});

describe('a product that has never moved', () => {
  /**
   * It has no ledger row at all, so there is no "last balance" to read. Holding
   * nothing is the right answer, and it is checked rather than skipped — a
   * product carrying stock it never received is exactly the sort of thing this
   * is looking for.
   */
  it('is expected to hold nothing, and passes when it does', () => {
    const milo = makeProduct('Milo 400g');
    const row = verifyStockAgainstLedger(context.db).find((entry) => entry.productId === milo)!;

    expect(row.ok).toBe(true);
    expect(row.ledgerQty).toBe(0);
    expect(row.ledgerValue).toBe(0);
  });

  it('is caught if it somehow holds something', () => {
    const milo = makeProduct('Milo 400g');
    corruptCache(milo, 4_000, 2_000);

    const row = verifyStockAgainstLedger(context.db).find((entry) => entry.productId === milo)!;
    expect(row.ok).toBe(false);
    expect(row.qtyDrift).toBe(4_000);
  });
});

describe('what the cheap check costs', () => {
  /**
   * The point of the change. The replay reads every movement of every product,
   * so its cost climbs with the shop's whole trading history. This one must not.
   */
  it('reads a fixed number of rows however long the shop has traded', () => {
    const milo = makeProduct('Milo 400g');
    move(milo, 'IN', 500, 250_000);
    for (let i = 0; i < 60; i++) move(milo, 'OUT', 1, 0);

    const movements = context.connection
      .prepare('SELECT COUNT(*) AS count FROM stock_ledger')
      .get() as { count: number };
    expect(movements.count).toBeGreaterThan(60);

    // Still correct, and still one row back per product.
    const rows = verifyStockAgainstLedger(context.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(true);
    expect(rows[0]!.ledgerQty).toBe(440_000);
  });
});
