import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, accountIdFor, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts } from '@/db/schema';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale, listSales } from '@/services/sale.service';
import { createSupplier } from '@/services/supplier.service';
import { createPurchase, listPurchases } from '@/services/purchase.service';
import { getAccountStatement } from '@/services/payment-account.service';
import { postJournalEntry } from '@/services/journal.service';
import { credit, debit } from '@/domain/accounting/journal';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * Lists run in the order the shop traded, not the order rows were written.
 *
 * Every one of these tables carries a trading date the user set and a write
 * timestamp defaulting to now, and each of these lists sorted on the second
 * while showing and filtering on the first. It never shows up in ordinary
 * data — key things in as they happen and the two orders agree — so each test
 * below writes rows deliberately out of sequence, the way a real shop does
 * every time it converts an old quote, books in a late delivery, or keys in
 * Saturday's takings on Monday.
 *
 * The account statement is the one with money at stake rather than just dates:
 * its running balance is a window function, and accumulating it in write order
 * printed a balance beside each row that included trading which had not
 * happened yet.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH_ACCOUNT = 0;

function stockedProduct(name: string): number {
  const id = createProduct(
    context.db,
    { name, costPrice: m(5_000), sellingPrice: m(10_000), unit: 'pcs' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: '2026-06-01',
      reason: 'OPENING_STOCK',
      items: [{ productId: id, direction: 'IN', qty: u(500), totalCost: m(2_500_000) }],
    },
    ACTOR,
  );
  return id;
}

/** Sold on `businessDate`, but rung into the system at `writtenAt`. */
function sale(productId: number, businessDate: string, writtenAt: Date): void {
  createSale(
    context.db,
    {
      businessDate,
      occurredAt: writtenAt,
      items: [{ productId, qty: u(1) }],
      tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(10_000) }],
    },
    ACTOR,
  );
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  CASH_ACCOUNT = context.db
    .select()
    .from(paymentAccounts)
    .all()
    .find((a) => a.kind === 'CASH')!.id;
});

afterEach(() => {
  context.cleanup();
});

describe('the sales list', () => {
  /**
   * The reported failure. RCP-00008 was a quotation converted last and dated
   * the 1st, and it sat above a sale made on the 30th — in both directions,
   * because the list was really ordered by receipt number wearing a date column.
   */
  it('puts a sale where its trading date belongs, not where it was keyed in', () => {
    const product = stockedProduct('Cement 50kg');

    sale(product, '2026-08-30', new Date('2026-08-31T13:19:01'));
    sale(product, '2026-07-21', new Date('2026-08-31T13:19:02'));
    sale(product, '2026-08-01', new Date('2026-08-31T13:19:03'));

    const newestFirst = listSales(context.db).map((row) => row.businessDate);
    expect(newestFirst).toEqual(['2026-08-30', '2026-08-01', '2026-07-21']);

    const oldestFirst = listSales(context.db, { sort: 'date', direction: 'asc' }).map(
      (row) => row.businessDate,
    );
    expect(oldestFirst).toEqual(['2026-07-21', '2026-08-01', '2026-08-30']);
  });
});

describe('the purchases list', () => {
  /**
   * Never reported, because the demo shop's deliveries happen to have been
   * written in date order. One delivery booked in late is all it takes, and the
   * code was identical to the sales list's.
   */
  it('puts a delivery where its date belongs, not where it was booked in', () => {
    const product = stockedProduct('Iron rod 12mm');
    const supplier = createSupplier(context.db, { name: 'Tema Steel Works' }, ACTOR);

    const line = (businessDate: string, writtenAt: Date): void => {
      createPurchase(
        context.db,
        {
          businessDate,
          occurredAt: writtenAt,
          supplierId: supplier,
          items: [{ productId: product, qty: u(10), unitCost: m(5_000) }],
          tenders: [],
        },
        ACTOR,
      );
    };

    line('2026-08-22', new Date('2026-08-31T13:19:01'));
    line('2026-06-18', new Date('2026-08-31T13:19:02'));
    line('2026-07-16', new Date('2026-08-31T13:19:03'));

    const dates = listPurchases(context.db).map((row) => row.businessDate);
    expect(dates).toEqual(['2026-08-22', '2026-07-16', '2026-06-18']);
  });
});

describe('an account statement', () => {
  const account = (code: string) => accountIdFor(context.db, code);

  /** A balanced cash entry on a trading day, written at a chosen moment. */
  function cashIn(entryDate: string, writtenAt: Date, amount: number): void {
    postJournalEntry(
      context.db,
      {
        entryDate,
        occurredAt: writtenAt,
        memo: 'test entry',
        sourceType: 'OPENING_BALANCE',
        isOpening: true,
        lines: [
          debit(account('1001'), minor(amount)),
          credit(account(ACCOUNT_CODES.OWNERS_CAPITAL), minor(amount)),
        ],
      },
      null,
    );
  }

  /**
   * The one that moves a figure rather than a date.
   *
   * Three deposits, written in an order unrelated to their trading dates. The
   * running balance has to climb 100, 300, 600 in trading order. Accumulated by
   * the write timestamp, the 8 August row was shown carrying the 20 August
   * money — a balance the account had not reached on the day the row claims.
   */
  it('accumulates the running balance in trading order', () => {
    cashIn('2026-08-20', new Date('2026-08-31T13:19:01'), 300_00);
    cashIn('2026-08-08', new Date('2026-08-31T13:19:02'), 200_00);
    cashIn('2026-08-02', new Date('2026-08-31T13:19:03'), 100_00);

    const statement = getAccountStatement(context.db, CASH_ACCOUNT);

    // Newest first, so the balances count back down the account.
    expect(statement.movements.map((row) => row.entryDate)).toEqual([
      '2026-08-20',
      '2026-08-08',
      '2026-08-02',
    ]);
    expect(statement.movements.map((row) => row.runningBalance)).toEqual([600_00, 300_00, 100_00]);
  });

  /**
   * The invariant that has to survive whatever the ordering does: the last row
   * on the page reaches the closing figure in the summary, and opening plus
   * what moved equals closing.
   */
  it('reconciles opening plus movement to closing', () => {
    cashIn('2026-08-20', new Date('2026-08-31T13:19:01'), 300_00);
    cashIn('2026-08-08', new Date('2026-08-31T13:19:02'), 200_00);
    cashIn('2026-08-02', new Date('2026-08-31T13:19:03'), 100_00);

    const statement = getAccountStatement(context.db, CASH_ACCOUNT);

    expect(statement.opening + statement.moneyIn - statement.moneyOut).toBe(statement.closing);
    expect(statement.movements[0]!.runningBalance).toBe(statement.closing);
  });
});
