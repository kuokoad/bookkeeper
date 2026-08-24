import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { journalEntries, paymentAccounts, sales, stockLedger } from '@/db/schema';
import { createProduct, getProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale } from '@/services/sale.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import { ForbiddenError } from '@/domain/errors';

/**
 * Selling below the shop's own prices is a separate right from ringing a sale up.
 *
 * This is the one way stock can leave a shop cheaply while the books stay in
 * perfect order: the sale genuinely happened at the price charged, so the trial
 * balance, the inventory reconciliation and every other integrity check in this
 * suite will pass. Nothing else can catch it, which is why it is checked here.
 *
 * A price and a discount are the same lever — list price with the line
 * discounted in full comes to the same nothing — so both are covered.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-16';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH_ACCOUNT = 0;
let PRODUCT = 0;

/** Milo, cost 5.00, sells for 8.00, ten on the shelf. */
function stockedProduct(): number {
  const id = createProduct(
    context.db,
    { name: 'Milo 400g', costPrice: m(500), sellingPrice: m(800), unit: 'pcs' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: TODAY,
      reason: 'OPENING_STOCK',
      items: [{ productId: id, direction: 'IN', qty: u(10), totalCost: m(5_000) }],
    },
    ACTOR,
  );
  return id;
}

/** A cart of one Milo, paid in cash, with whatever concession is being tried. */
function sell(overrides: {
  unitPrice?: Minor;
  discount?: Minor;
  invoiceDiscount?: Minor;
  allowPriceOverride?: boolean;
}) {
  const { allowPriceOverride, invoiceDiscount, ...line } = overrides;
  return createSale(
    context.db,
    {
      businessDate: TODAY,
      items: [{ productId: PRODUCT, qty: u(1), ...line }],
      tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(800) }],
      ...(invoiceDiscount !== undefined ? { invoiceDiscount } : {}),
      ...(allowPriceOverride !== undefined ? { allowPriceOverride } : {}),
    },
    ACTOR,
  );
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');

  CASH_ACCOUNT = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;
  PRODUCT = stockedProduct();
});

afterEach(() => context.cleanup());

describe('a till without the right to change prices', () => {
  it('sells happily at the shop price', () => {
    const sale = sell({});
    expect(sale.total).toBe(800);
  });

  it('sells at the shop price when the till sends it explicitly', () => {
    // The POS posts a price for every line, so sending one is normal and must
    // not itself look like an override.
    const sale = sell({ unitPrice: m(800) });
    expect(sale.total).toBe(800);
  });

  it('REFUSES a price below the shop price', () => {
    expect(() => sell({ unitPrice: m(1) })).toThrow(ForbiddenError);
  });

  it('REFUSES a price above the shop price', () => {
    // Overcharging a customer is not a lesser wrong than undercharging the shop.
    expect(() => sell({ unitPrice: m(5_000) })).toThrow(ForbiddenError);
  });

  it('REFUSES a line discount', () => {
    expect(() => sell({ discount: m(700) })).toThrow(ForbiddenError);
  });

  it('REFUSES a discount on the whole sale', () => {
    expect(() => sell({ invoiceDiscount: m(700) })).toThrow(ForbiddenError);
  });

  it('REFUSES the full-discount route to a free sale', () => {
    // The bypass that makes gating the price alone pointless: leave the price
    // alone and take all of it off again.
    expect(() => sell({ discount: m(800) })).toThrow(ForbiddenError);
  });

  it('allows a zero discount, which is what an empty box means', () => {
    expect(() => sell({ discount: m(0) })).not.toThrow();
  });

  it('says what to do about it, rather than just "not permitted"', () => {
    try {
      sell({ unitPrice: m(1) });
      expect.unreachable('the sale should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
      const message = (error as ForbiddenError).userMessage;
      expect(message).toContain('supervisor');
      // The price they should have charged, so the cashier can just ring it up.
      expect(message).toContain('8.00');
    }
  });
});

describe('the refusal leaves nothing behind', () => {
  /**
   * The check runs inside the same transaction as the sale, so a refusal must
   * roll back everything — not merely decline to post the journal entry. A
   * stock movement surviving a refused sale would be the worst of both.
   */
  it('writes no sale, no stock movement and no journal entry', () => {
    const ledgerBefore = context.db.select().from(stockLedger).all().length;
    const entriesBefore = context.db.select().from(journalEntries).all().length;
    const onHandBefore = getProduct(context.db, PRODUCT).qtyOnHand;

    expect(() => sell({ unitPrice: m(1) })).toThrow(ForbiddenError);

    expect(context.db.select().from(sales).all()).toHaveLength(0);
    expect(context.db.select().from(stockLedger).all()).toHaveLength(ledgerBefore);
    expect(context.db.select().from(journalEntries).all()).toHaveLength(entriesBefore);
    expect(getProduct(context.db, PRODUCT).qtyOnHand).toBe(onHandBefore);
  });

  it('does not consume a receipt number', () => {
    expect(() => sell({ discount: m(500) })).toThrow(ForbiddenError);
    const sale = sell({});
    expect(sale.receiptNo).toContain('1');
    expect(context.db.select().from(sales).all()).toHaveLength(1);
  });
});

describe('a till that DOES hold the right', () => {
  it('may sell below the shop price', () => {
    const sale = sell({ unitPrice: m(600), allowPriceOverride: true });
    expect(sale.total).toBe(600);
  });

  it('may give a line discount', () => {
    const sale = sell({ discount: m(200), allowPriceOverride: true });
    expect(sale.total).toBe(600);
  });

  it('may discount the whole sale', () => {
    const sale = sell({ invoiceDiscount: m(200), allowPriceOverride: true });
    expect(sale.total).toBe(600);
  });

  it('still cannot sell at a negative price', () => {
    // The permission widens who may set a price, not what a price may be.
    expect(() => sell({ unitPrice: m(-100), allowPriceOverride: true })).toThrow();
  });

  it('still cannot discount more than the line is worth', () => {
    expect(() => sell({ discount: m(900), allowPriceOverride: true })).toThrow();
  });
});

describe('the default', () => {
  /**
   * A caller that forgets the flag must get the SAFE behaviour, not the
   * permissive one. Any future path into `createSale` is refused by default and
   * has to ask for the right explicitly.
   */
  it('is to refuse, when the flag is not passed at all', () => {
    expect(() => sell({ unitPrice: m(1) })).toThrow(ForbiddenError);
  });

  it('is to refuse, when the flag is explicitly false', () => {
    expect(() => sell({ unitPrice: m(1), allowPriceOverride: false })).toThrow(ForbiddenError);
  });
});
