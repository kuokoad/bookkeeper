import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { getStockLedger } from '@/services/inventory.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * What day the stock ledger says a movement happened.
 *
 * Every row carries two dates. `businessDate` is the day the stock moved;
 * `occurredAt` is the instant the row was written, and defaults to now. They
 * agree when a delivery is booked in as it lands and part company whenever it
 * is not — a Saturday's takings keyed in on Monday, a quotation converted today
 * for the day it was agreed, a whole shop's history written by a seed in one
 * second.
 *
 * The list filtered on `businessDate` and then printed `occurredAt`, so asking
 * for June returned June's movements and stamped every one of them with the day
 * the database happened to be written. Nothing was stored wrongly and no figure
 * moved: the CSV export of the same rows had the right dates all along, which
 * is the tell — the screen and the file disagreed about the same query.
 *
 * These tests write movements whose two dates differ on purpose, which is the
 * only condition under which the bug is visible at all. Seeded and same-day
 * data hides it completely.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

/** Written at `writtenAt`, but traded on `businessDate`. */
function movement(productId: number, businessDate: string, writtenAt: Date, qty: number): void {
  createStockAdjustment(
    context.db,
    {
      businessDate,
      occurredAt: writtenAt,
      reason: 'OPENING_STOCK',
      items: [{ productId, direction: 'IN', qty: u(qty), totalCost: m(qty * 100) }],
    },
    ACTOR,
  );
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
});

afterEach(() => {
  context.cleanup();
});

describe('the date on a stock movement', () => {
  it('is the day the stock moved, not the day the row was written', () => {
    const product = createProduct(
      context.db,
      { name: 'Cement 50kg', costPrice: m(100), sellingPrice: m(150), unit: 'bag' },
      ACTOR,
    );

    // Keyed in on 31 August; the cement actually arrived on 18 June.
    const keyedIn = new Date('2026-08-31T13:19:00');
    movement(product, '2026-06-18', keyedIn, 600);

    const [row] = getStockLedger(context.db);

    expect(row!.businessDate).toBe('2026-06-18');
    // occurredAt is still the truth about when it was typed. Both are kept;
    // the bug was showing the second one where the first belongs.
    expect(row!.occurredAt.getTime()).toBe(keyedIn.getTime());
  });

  /**
   * The failure exactly as it was reported: filter to a range, and every row
   * that comes back is dated outside it. The chip said June, the rows said
   * August, and both were drawn from the same query.
   */
  it('never returns a row dated outside the range that selected it', () => {
    const product = createProduct(
      context.db,
      { name: 'Iron rod 12mm', costPrice: m(100), sellingPrice: m(150), unit: 'length' },
      ACTOR,
    );

    const keyedIn = new Date('2026-08-31T13:19:00');
    movement(product, '2026-06-18', keyedIn, 100);
    movement(product, '2026-07-16', keyedIn, 200);
    movement(product, '2026-08-22', keyedIn, 300);

    const rows = getStockLedger(context.db, { from: '2026-06-01', to: '2026-07-31' });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.businessDate >= '2026-06-01').toBe(true);
      expect(row.businessDate <= '2026-07-31').toBe(true);
    }
  });

  /**
   * Ordering has to follow the same column, or a backdated movement sits at the
   * top of the page under a date from weeks earlier. Sorting on `occurredAt`
   * put it wherever it was written; on a seed that writes everything in one
   * second, that is insertion order wearing a date column.
   */
  it('lists the newest trading day first, wherever the row was written', () => {
    const product = createProduct(
      context.db,
      { name: 'PVC pipe 4in', costPrice: m(100), sellingPrice: m(150), unit: 'length' },
      ACTOR,
    );

    // Written in an order that has nothing to do with when trade happened: the
    // 1 August movement is keyed in last, the way a converted quote is.
    movement(product, '2026-08-30', new Date('2026-08-31T13:19:01'), 10);
    movement(product, '2026-07-21', new Date('2026-08-31T13:19:02'), 20);
    movement(product, '2026-08-01', new Date('2026-08-31T13:19:03'), 30);

    const dates = getStockLedger(context.db).map((row) => row.businessDate);

    expect(dates).toEqual(['2026-08-30', '2026-08-01', '2026-07-21']);
  });

  /**
   * Two movements on the same day still read in the order the weighted average
   * was applied, because that is the order the balance each row carries was
   * calculated in. Insertion order, not the clock: these three share an
   * `occurredAt` to the millisecond, so only the id separates them.
   */
  it('keeps same-day movements in the order the cost chain was built', () => {
    const product = createProduct(
      context.db,
      { name: 'Binding wire', costPrice: m(100), sellingPrice: m(150), unit: 'roll' },
      ACTOR,
    );

    const sameInstant = new Date('2026-08-31T13:19:00');
    movement(product, '2026-08-12', sameInstant, 10);
    movement(product, '2026-08-12', sameInstant, 20);
    movement(product, '2026-08-12', sameInstant, 30);

    const balances = getStockLedger(context.db).map((row) => row.balanceQty);

    // Newest first, so the balances count down the chain: 60, then 30, then 10.
    expect(balances).toEqual([60_000, 30_000, 10_000]);
  });
});
