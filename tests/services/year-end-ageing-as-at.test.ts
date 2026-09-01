import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getYearEndPack } from '@/services/reporting/year-end.service';
import { getReceivablesAgeing } from '@/services/reporting/ledger.service';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale } from '@/services/sale.service';
import { createCustomer } from '@/services/customer.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * How overdue a debt is, in a pack for a year that has not finished.
 *
 * Every statement in the year-end pack is struck at the year end, and rightly
 * so. Ageing is the exception, because it is not a position — it is the gap
 * between the due date and now, and "now" in a provisional pack was 31 December
 * of a year still four months away.
 *
 * The effect was that every debt in the shop landed in "Over 90 days", the only
 * bucket the pack prints. An accountant reading a draft prepared on 1 September
 * was told the whole receivables book was long overdue, while the Who owes you
 * screen said "Nothing long overdue" about the same money on the same day.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
});

afterEach(() => {
  context.cleanup();
});

/** An unpaid credit sale, so there is a debt to age. */
function creditSale(businessDate: string): void {
  const product = createProduct(
    context.db,
    { name: 'Cement 50kg', costPrice: m(8_000), sellingPrice: m(9_600), unit: 'bag' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate,
      reason: 'OPENING_STOCK',
      items: [{ productId: product, direction: 'IN', qty: u(100), totalCost: m(800_000) }],
    },
    ACTOR,
  );
  const customer = createCustomer(context.db, { name: 'Adom Construction Ltd' }, ACTOR);
  createSale(
    context.db,
    {
      businessDate,
      customerId: customer,
      items: [{ productId: product, qty: u(10) }],
      tenders: [],
    },
    ACTOR,
  );
}

describe('the year-end pack ages debts from the day it is prepared', () => {
  /**
   * The financial year in the test database runs to 31 December, and the test
   * clock is inside it, so this pack is provisional by construction.
   */
  it('does not age a provisional pack to a date in the future', () => {
    creditSale('2026-08-20');

    const pack = getYearEndPack(context.db, 2026);

    expect(pack.isProvisional).toBe(true);
    // The day the pack was prepared, not 31 December.
    expect(pack.ageingAsAt < pack.year.end).toBe(true);
  });

  /**
   * The heart of it. Aged to the year end, a sale made in August is more than
   * 90 days behind by 31 December and the pack's only bucket swallows the lot.
   * Aged to the day it is prepared, the same debt is nowhere near that.
   */
  it('does not report a recent debt as more than 90 days overdue', () => {
    creditSale('2026-08-20');

    const pack = getYearEndPack(context.db, 2026);
    const owed = pack.receivables[0];

    expect(owed).toBeDefined();
    expect(owed!.total).toBe(96_000);
    expect(owed!.over90).toBe(0);

    // What the year end would have said about the very same debt.
    const agedToYearEnd = getReceivablesAgeing(context.db, pack.year.end)[0];
    expect(agedToYearEnd!.over90).toBe(96_000);
  });

  it('agrees with the Who owes you screen, which ages to the same day', () => {
    creditSale('2026-08-20');

    const pack = getYearEndPack(context.db, 2026);
    const screen = getReceivablesAgeing(context.db, pack.ageingAsAt);

    expect(pack.receivables).toEqual(screen);
  });

  /**
   * A finished year is untouched: `today` is past the year end, so the pack
   * ages to the year end exactly as final accounts should.
   */
  it('ages a finished year to the year end, not to today', () => {
    creditSale('2020-08-20');

    const pack = getYearEndPack(context.db, 2020);

    expect(pack.isProvisional).toBe(false);
    expect(pack.ageingAsAt).toBe(pack.year.end);
  });
});
