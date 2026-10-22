import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { setGhanaTaxes } from '../helpers/tax';
import { businessSettings, paymentAccounts, units } from '@/db/schema';
import { isDomainError } from '@/domain/errors';
import { parseMoney, ZERO, type Minor } from '@/domain/money';
import { parsePositiveQty, QTY_DECIMALS } from '@/domain/quantity';
import { readPurchase } from '@/app/(app)/purchases/new/read-purchase';
import { createProduct } from '@/services/catalog.service';
import { createPurchase } from '@/services/purchase.service';
import { createSupplier } from '@/services/supplier.service';
import { getTaxProfile } from '@/services/tax.service';
import { createUnit } from '@/services/units.service';

/**
 * The new-purchase form and `createPurchase` agree.
 *
 * `read-purchase.ts` reads the form with the server's own parsers and rules so
 * it can show a figure only when Save would store exactly that figure, and
 * refuse before Save whatever Save would refuse. That promise lasts only as
 * long as the two stay in step, and the rendered tests cannot see the server:
 * they mock the action. A purchase that came to 0.00 slipped through exactly
 * that gap, passing the form and failing in the journal.
 *
 * So each entry below goes through both: the form's reading, and the action's
 * parsing followed by the real `createPurchase` on a throwaway database. They
 * must agree on whether it saves, and on the total when it does.
 *
 * One difference is deliberate and left out: the action silently drops a
 * payment of zero or less, and the form refuses a negative one instead, since
 * a payment the screen showed and the books never got is the worse outcome.
 */

const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-17';

interface Entry {
  qty: string;
  cost: string;
  discount?: string;
  /** In cartons of 24 pcs. */
  alt?: boolean;
}

interface Case {
  name: string;
  lines: Entry[];
  invoiceDiscount?: string;
  pay?: string;
  date?: string;
  lockedBefore?: string;
  ghanaTaxes?: boolean;
}

let context: TestDatabase;
let productId = 0;
let supplierId = 0;
let cash = 0;

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  createUnit(context.db, { symbol: 'pc', name: 'Piece', decimalPlaces: 0 }, ACTOR);
  // A carton allows one decimal place, so half a carton is fine and a tenth is
  // not: 2.4 pieces is not a whole number of them.
  createUnit(context.db, { symbol: 'carton', name: 'Carton', decimalPlaces: 1 }, ACTOR);
  productId = createProduct(
    context.db,
    {
      name: 'Bath soap',
      unit: 'pc',
      altUnit: 'carton',
      altFactor: parsePositiveQty('24'),
      costPrice: parseMoney('3.00'),
      sellingPrice: parseMoney('4.00'),
    },
    ACTOR,
  );
  supplierId = createSupplier(context.db, { name: 'Kofi Wholesale' }, ACTOR);
  cash = context.db.select().from(paymentAccounts).all()[0]!.id;
});

afterEach(() => context.cleanup());

/** What the form would show and allow, from the same data the page gives it. */
function screenReads(c: Case) {
  const decimals = new Map(
    context.db
      .select({ symbol: units.symbol, decimalPlaces: units.decimalPlaces })
      .from(units)
      .all()
      .map((unit) => [unit.symbol, unit.decimalPlaces]),
  );
  return readPurchase({
    rows: c.lines.map((line) => ({
      productId: String(productId),
      qty: line.qty,
      alt: line.alt ?? false,
      unitCost: line.cost,
      discount: line.discount ?? '',
    })),
    products: [
      {
        id: productId,
        unit: 'pc',
        altUnit: 'carton',
        altFactorMilli: 24_000,
        unitDecimals: decimals.get('pc') ?? QTY_DECIMALS,
        altUnitDecimals: decimals.get('carton') ?? QTY_DECIMALS,
      },
    ],
    invoiceDiscount: c.invoiceDiscount ?? '',
    payAmount: c.pay ?? '',
    canPay: true,
    taxComponents: getTaxProfile(context.db).components,
    businessDate: c.date ?? TODAY,
    lockedBefore: c.lockedBefore ?? null,
  });
}

/** What Save stores, parsed the way `createPurchaseAction` parses the basket. Null when refused. */
function serverStores(c: Case): Minor | null {
  try {
    const items = c.lines.map((line) => ({
      productId,
      qty: parsePositiveQty(line.qty),
      unitCost: parseMoney(line.cost),
      ...(line.discount ? { discount: parseMoney(line.discount) } : {}),
      ...(line.alt ? { alt: true } : {}),
    }));
    const paid = c.pay ? parseMoney(c.pay) : ZERO;
    return createPurchase(
      context.db,
      {
        supplierId,
        businessDate: c.date ?? TODAY,
        items,
        invoiceDiscount: c.invoiceDiscount ? parseMoney(c.invoiceDiscount) : ZERO,
        tenders: paid > 0 ? [{ paymentAccountId: cash, amount: paid }] : [],
      },
      ACTOR,
    ).total;
  } catch (error) {
    if (isDomainError(error)) return null;
    throw error;
  }
}

const CASES: Case[] = [
  { name: 'a plain line', lines: [{ qty: '2', cost: '3.00' }] },
  { name: 'a line discount', lines: [{ qty: '2', cost: '3.00', discount: '1.50' }] },
  { name: 'a line discount larger than the line', lines: [{ qty: '2', cost: '3.00', discount: '7.00' }] },
  { name: 'a negative line discount', lines: [{ qty: '2', cost: '3.00', discount: '-1.00' }] },
  { name: 'a discount of the whole line, alone', lines: [{ qty: '2', cost: '3.00', discount: '6.00' }] },
  { name: 'free goods alone', lines: [{ qty: '2', cost: '0' }] },
  { name: 'free goods beside paid ones', lines: [{ qty: '2', cost: '0' }, { qty: '1', cost: '3.00' }] },
  { name: 'a zero quantity', lines: [{ qty: '0', cost: '3.00' }] },
  { name: 'a quantity finer than the unit', lines: [{ qty: '1.5', cost: '3.00' }] },
  { name: 'half a carton', lines: [{ qty: '0.5', cost: '72.00', alt: true }] },
  { name: 'a tenth of a carton, which is 2.4 pieces', lines: [{ qty: '0.1', cost: '72.00', alt: true }] },
  { name: 'too many places for a carton', lines: [{ qty: '1.25', cost: '72.00', alt: true }] },
  { name: 'a comma as a decimal point', lines: [{ qty: '2', cost: '2,50' }] },
  { name: 'proper thousands grouping', lines: [{ qty: '2', cost: '1,250.00' }] },
  { name: 'an invoice discount', lines: [{ qty: '2', cost: '3.00' }], invoiceDiscount: '1.00' },
  { name: 'an invoice discount larger than the lines', lines: [{ qty: '2', cost: '3.00' }], invoiceDiscount: '6.01' },
  { name: 'an invoice discount of the whole purchase', lines: [{ qty: '2', cost: '3.00' }], invoiceDiscount: '6.00' },
  { name: 'paying all of it', lines: [{ qty: '2', cost: '3.00' }], pay: '6.00' },
  { name: 'paying more than the total', lines: [{ qty: '2', cost: '3.00' }], pay: '6.01' },
  { name: 'the Ghana taxes', lines: [{ qty: '10', cost: '86.00' }], ghanaTaxes: true },
  { name: 'paying all of it with tax on top', lines: [{ qty: '10', cost: '86.00' }], pay: '1032.00', ghanaTaxes: true },
  { name: 'a date inside the books lock', lines: [{ qty: '2', cost: '3.00' }], lockedBefore: '2026-08-31' },
  { name: 'the day after the books lock', lines: [{ qty: '2', cost: '3.00' }], date: '2026-09-01', lockedBefore: '2026-08-31' },
];

describe('the new-purchase form and Save agree', () => {
  it.each(CASES)('$name', (c) => {
    if (c.ghanaTaxes) setGhanaTaxes(context.db);
    if (c.lockedBefore) {
      context.db
        .update(businessSettings)
        .set({ booksLockedBefore: c.lockedBefore })
        .where(eq(businessSettings.id, 1))
        .run();
    }

    const reading = screenReads(c);
    const stored = serverStores(c);

    expect(reading.acceptable).toBe(stored !== null);
    if (stored !== null) expect(reading.total).toBe(stored);
  });

  it('covers both answers, so it can catch a disagreement either way', () => {
    // A table where every case saved, or every case was refused, would agree
    // with a form that allowed everything, or nothing.
    const outcomes = new Set(
      CASES.map((c) => {
        if (c.ghanaTaxes) setGhanaTaxes(context.db);
        return screenReads(c).acceptable;
      }),
    );
    expect(outcomes).toEqual(new Set([true, false]));
  });
});
