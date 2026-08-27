import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts } from '@/db/schema';
import { createCategory, createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale, voidSale } from '@/services/sale.service';
import { getTopProductByRevenue } from '@/services/reporting/operations.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * The dashboard's "Top selling product".
 *
 * It is one line on the screen a shop owner opens every morning, which is
 * exactly why it has to be right: nobody cross-checks a headline. The two ways
 * it could quietly lie are naming the wrong product, and naming a product whose
 * only sale was cancelled.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;
let COKE = 0;
let RICE = 0;

const AUGUST = { from: '2026-08-01', to: '2026-08-31' };

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

  const drinks = createCategory(context.db, { name: 'Drinks' }, ACTOR);
  const food = createCategory(context.db, { name: 'Food' }, ACTOR);

  COKE = createProduct(
    context.db,
    { name: 'Coca-Cola 500ml', categoryId: drinks, costPrice: m(300), sellingPrice: m(500), unit: 'pcs' },
    ACTOR,
  );
  RICE = createProduct(
    context.db,
    { name: 'Rice 5kg', categoryId: food, costPrice: m(4_000), sellingPrice: m(6_000), unit: 'bag' },
    ACTOR,
  );

  createStockAdjustment(
    context.db,
    {
      businessDate: '2026-07-31',
      reason: 'OPENING_STOCK',
      items: [
        { productId: COKE, direction: 'IN', qty: u(500), totalCost: m(150_000) },
        { productId: RICE, direction: 'IN', qty: u(100), totalCost: m(400_000) },
      ],
    },
    ACTOR,
  );
});

afterEach(() => {
  context.cleanup();
});

function sale(date: string, productId: number, qty: number, unitPrice: number): number {
  return createSale(
    context.db,
    {
      businessDate: date,
      items: [{ productId, qty: u(qty) }],
      tenders: [{ paymentAccountId: CASH, amount: m(qty * unitPrice) }],
    },
    ACTOR,
  ).saleId;
}

describe('the top selling product', () => {
  it('names the product that took the most money, not the one that moved most', () => {
    // Fifty bottles of Coke is the busiest thing on the shelf and earns
    // GHS 250. Ten bags of rice earn GHS 600. A shop owner asking what sells
    // best is told about the rice.
    sale('2026-08-05', COKE, 50, 500);
    sale('2026-08-06', RICE, 10, 6_000);

    const top = getTopProductByRevenue(context.db, AUGUST);
    expect(top?.productName).toBe('Rice 5kg');
    expect(top?.revenue).toBe(60_000);
    expect(top?.qtySold).toBe(fromUnits(10));
    expect(top?.unit).toBe('bag');
  });

  it('adds up every sale of a product, not just the largest one', () => {
    sale('2026-08-05', RICE, 10, 6_000);
    sale('2026-08-06', COKE, 100, 500);
    sale('2026-08-07', COKE, 60, 500);

    // Coke: 160 × 500 = 80,000, spread over two days. Rice: 60,000 in one.
    const top = getTopProductByRevenue(context.db, AUGUST);
    expect(top?.productName).toBe('Coca-Cola 500ml');
    expect(top?.revenue).toBe(80_000);
    expect(top?.qtySold).toBe(fromUnits(160));
  });

  it('says nothing when nothing was sold', () => {
    expect(getTopProductByRevenue(context.db, AUGUST)).toBeNull();
  });

  it('ignores trading outside the window at either end', () => {
    sale('2026-07-31', RICE, 40, 6_000);
    sale('2026-09-01', RICE, 40, 6_000);
    sale('2026-08-15', COKE, 10, 500);

    const top = getTopProductByRevenue(context.db, AUGUST);
    expect(top?.productName).toBe('Coca-Cola 500ml');
    expect(top?.revenue).toBe(5_000);
  });

  it('does not crown a product whose only sale was voided', () => {
    // The void is a mirror sale carrying negative quantities, so the two net to
    // nothing. A cancelled sale must not leave a product standing on the
    // dashboard as the shop's best seller.
    const rice = sale('2026-08-05', RICE, 10, 6_000);
    sale('2026-08-06', COKE, 10, 500);
    voidSale(context.db, rice, 'Rung up twice', ACTOR, new Date('2026-08-07T10:00:00Z'));

    const top = getTopProductByRevenue(context.db, AUGUST);
    expect(top?.productName).toBe('Coca-Cola 500ml');
  });

  it('says nothing when every sale in the window was voided', () => {
    const rice = sale('2026-08-05', RICE, 10, 6_000);
    voidSale(context.db, rice, 'Rung up twice', ACTOR, new Date('2026-08-07T10:00:00Z'));

    expect(getTopProductByRevenue(context.db, AUGUST)).toBeNull();
  });

  it('counts a void of an earlier sale against the window it lands in', () => {
    // July's rice is voided in August. The reversal is August trading, so
    // August's rice revenue is negative and rice cannot be August's best
    // seller — which is the honest answer: the shop took that money back.
    const july = sale('2026-07-20', RICE, 10, 6_000);
    sale('2026-08-06', COKE, 10, 500);
    voidSale(context.db, july, 'Customer returned everything', ACTOR, new Date('2026-08-07T10:00:00Z'));

    const top = getTopProductByRevenue(context.db, AUGUST);
    expect(top?.productName).toBe('Coca-Cola 500ml');
  });

  it('names the same product every time when two are level', () => {
    // Both take GHS 300 exactly. Whichever wins, it must win consistently: a
    // headline that changes when the page is refreshed is one nobody trusts.
    sale('2026-08-05', COKE, 60, 500);
    sale('2026-08-05', RICE, 5, 6_000);

    const first = getTopProductByRevenue(context.db, AUGUST);
    expect(first?.revenue).toBe(30_000);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(getTopProductByRevenue(context.db, AUGUST)?.productId).toBe(first?.productId);
    }
  });
});
