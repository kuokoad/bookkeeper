import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { journalEntries, paymentAccounts, sales, stockLedger } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createProduct, getProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale } from '@/services/sale.service';
import { createCustomer } from '@/services/customer.service';
import { getAccountBalanceByCode } from '@/services/reporting/balances.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * A sale submitted twice must be recorded once.
 *
 * This is the duplicate nothing else in the application can catch. Each copy is
 * internally perfect — its own receipt number, its own stock movement, its own
 * balanced journal entry — so the trial balance, the inventory reconciliation
 * and every report agree with each other while the shop's books say it sold
 * twice as much as it did. Only the till knows the two requests were one cart.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-16';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH_ACCOUNT = 0;
let PRODUCT = 0;

/** One Milo at 8.00, paid in cash, under the given cart reference. */
function sell(clientRef: string | undefined, options: { tendered?: number; qty?: number } = {}) {
  return createSale(
    context.db,
    {
      businessDate: TODAY,
      items: [{ productId: PRODUCT, qty: u(options.qty ?? 1) }],
      tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(options.tendered ?? 800) }],
      ...(clientRef !== undefined ? { clientRef } : {}),
    },
    ACTOR,
  );
}

const countSales = () => context.db.select().from(sales).all().length;
const countMovements = () => context.db.select().from(stockLedger).all().length;
const countEntries = () => context.db.select().from(journalEntries).all().length;

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');

  CASH_ACCOUNT = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;

  PRODUCT = createProduct(
    context.db,
    { name: 'Milo 400g', costPrice: m(500), sellingPrice: m(800), unit: 'pcs' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: TODAY,
      reason: 'OPENING_STOCK',
      items: [{ productId: PRODUCT, direction: 'IN', qty: u(10), totalCost: m(5_000) }],
    },
    ACTOR,
  );
});

afterEach(() => context.cleanup());

describe('the same cart submitted twice', () => {
  it('records one sale, not two', () => {
    const before = countSales();
    sell('cart-abc-123');
    sell('cart-abc-123');
    expect(countSales()).toBe(before + 1);
  });

  it('returns the same receipt both times', () => {
    const first = sell('cart-abc-123');
    const second = sell('cart-abc-123');

    expect(second.saleId).toBe(first.saleId);
    expect(second.receiptNo).toBe(first.receiptNo);
    expect(second.total).toBe(first.total);
    expect(second.cogs).toBe(first.cogs);
    expect(second.outstanding).toBe(first.outstanding);
    expect(second.journalEntryId).toBe(first.journalEntryId);
  });

  it('takes the stock off the shelf once', () => {
    const movementsBefore = countMovements();
    sell('cart-abc-123');
    const onHand = getProduct(context.db, PRODUCT).qtyOnHand;

    sell('cart-abc-123');

    expect(getProduct(context.db, PRODUCT).qtyOnHand).toBe(onHand);
    expect(countMovements()).toBe(movementsBefore + 1);
  });

  it('posts one journal entry, so the books are not doubled', () => {
    const entriesBefore = countEntries();
    sell('cart-abc-123');
    sell('cart-abc-123');

    expect(countEntries()).toBe(entriesBefore + 1);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.SALES_REVENUE)).toBe(800);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.COST_OF_GOODS_SOLD)).toBe(500);
    expect(getAccountBalanceByCode(context.db, '1001')).toBe(800);
  });

  it('does not burn a second receipt number', () => {
    const first = sell('cart-abc-123');
    sell('cart-abc-123');
    const next = sell('cart-def-456');

    // The next real sale takes the very next number; the retry consumed nothing.
    expect(next.receiptNo).not.toBe(first.receiptNo);
    expect(countSales()).toBe(2);
  });

  it('still reports the change the cashier owes the customer', () => {
    // Change is not a fact of the sale — the shop kept nothing — so it is not
    // stored. A replay must still answer it, from the tender it was given.
    const first = sell('cart-abc-123', { tendered: 2_000 });
    const second = sell('cart-abc-123', { tendered: 2_000 });

    expect(first.change).toBe(1_200);
    expect(second.change).toBe(1_200);
  });
});

describe('different carts', () => {
  it('are two sales, as they should be', () => {
    const first = sell('cart-abc-123');
    const second = sell('cart-def-456');

    expect(second.saleId).not.toBe(first.saleId);
    expect(countSales()).toBe(2);
    expect(getProduct(context.db, PRODUCT).qtyOnHand).toBe(8_000);
  });

  it('are still two sales when the carts are identical in every other way', () => {
    // A customer buying the same thing twice in a minute is an ordinary event
    // and must not be mistaken for a retry.
    sell('cart-one');
    sell('cart-two');
    expect(countSales()).toBe(2);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.SALES_REVENUE)).toBe(1_600);
  });
});

describe('a sale with no cart reference', () => {
  /**
   * Seeds, imports and most of this suite post without one. They must keep
   * working, and each call must create a real sale — SQLite allows many NULLs
   * in a unique index, which is what makes that possible.
   */
  it('is created every time, as before', () => {
    sell(undefined);
    sell(undefined);
    expect(countSales()).toBe(2);
  });
});

describe('the replay of a credit sale', () => {
  it('reports what is still owed, not what was owed at the counter', () => {
    const customerId = createCustomer(context.db, { name: 'Ama Serwaa' }, ACTOR);

    const first = createSale(
      context.db,
      {
        businessDate: TODAY,
        customerId,
        items: [{ productId: PRODUCT, qty: u(1) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(300) }],
        clientRef: 'cart-credit-1',
      },
      ACTOR,
    );

    expect(first.outstanding).toBe(500);

    const replay = createSale(
      context.db,
      {
        businessDate: TODAY,
        customerId,
        items: [{ productId: PRODUCT, qty: u(1) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(300) }],
        clientRef: 'cart-credit-1',
      },
      ACTOR,
    );

    expect(replay.saleId).toBe(first.saleId);
    expect(replay.outstanding).toBe(500);
    expect(countSales()).toBe(1);
  });
});

describe('the database enforces it, not just the service', () => {
  /**
   * The check in `createSale` turns a retry into a useful answer. The unique
   * index is what makes the rule true regardless of which code path ran — a
   * future caller that skipped the check would be refused by the database
   * rather than quietly creating the duplicate this whole change is about.
   */
  it('refuses a second sale carrying a reference already used', () => {
    const first = sell('cart-abc-123');

    expect(() =>
      context.connection
        .prepare(
          `INSERT INTO sales (receipt_no, business_date, occurred_at, subtotal_minor,
                              discount_minor, tax_minor, total_minor, client_ref)
           VALUES ('R-FORGED', ?, ?, 800, 0, 0, 800, 'cart-abc-123')`,
        )
        .run(TODAY, Date.now()),
    ).toThrow(/UNIQUE/i);

    expect(countSales()).toBe(1);
    expect(first.receiptNo).not.toBe('R-FORGED');
  });
});
