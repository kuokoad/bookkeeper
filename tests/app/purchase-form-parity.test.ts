import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { setGhanaTaxes } from '../helpers/tax';
import { businessSettings, paymentAccounts, purchasePayments, purchases } from '@/db/schema';
import type { Db } from '@/db/types';
import { parsePositiveQty } from '@/domain/quantity';
import { parseMoney } from '@/domain/money';
import { loadEntryProducts } from '@/app/(app)/purchases/new/entry-products';
import { purchaseBasket, readPurchase } from '@/app/(app)/purchases/new/read-purchase';
import { createProduct } from '@/services/catalog.service';
import { createSupplier } from '@/services/supplier.service';
import { getTaxProfile } from '@/services/tax.service';
import { createUnit } from '@/services/units.service';

/**
 * The new-purchase form and Save agree.
 *
 * `read-purchase.ts` reads the form with the server's own parsers and rules so
 * it can show a figure only when Save would store exactly that figure, and
 * refuse before Save whatever Save would refuse. That promise lasts only as
 * long as the two stay in step, and the rendered tests cannot see the server:
 * they mock the action. A purchase that came to 0.00 slipped through exactly
 * that gap, passing the form and failing in the journal.
 *
 * So each entry below goes through both: the form's reading, with products
 * loaded exactly as the page loads them, and the real `createPurchaseAction`
 * on a throwaway database, given the basket the form's own `purchaseBasket`
 * builds. They must
 * agree on whether it saves, and when it does, on the subtotal, the total and
 * what is still owed.
 *
 * One difference is deliberate and left out: the action silently drops a
 * payment of less than zero, and the form refuses it instead, since a payment
 * the screen showed and the books never got is the worse outcome.
 */

const database = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@/db/client', () => ({
  get db() {
    return database.current;
  },
}));
vi.mock('@/lib/auth/current-user', () => ({
  requirePermission: async () => ({ id: 1, username: 'kwame' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { createPurchaseAction } = await import('@/actions/purchase.actions');

const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-17';

type ProductKey = 'soap' | 'cartage';

interface Entry {
  product?: ProductKey;
  qty: string;
  cost: string;
  discount?: string;
  /** In cartons of 24 pieces. */
  alt?: boolean;
}

interface Case {
  name: string;
  lines: Entry[];
  invoiceDiscount?: string;
  pay?: string;
  reference?: string;
  invoiceNo?: string;
  date?: string;
  lockedBefore?: string;
  ghanaTaxes?: boolean;
}

let context: TestDatabase;
const productIds: Record<ProductKey, number> = { soap: 0, cartage: 0 };
let supplierId = 0;
let cash = 0;

beforeEach(() => {
  context = createTestDatabase();
  database.current = context.db;
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  createUnit(context.db, { symbol: 'pc', name: 'Piece', decimalPlaces: 0 }, ACTOR);
  // A carton allows one decimal place, so half a carton is fine and a tenth is
  // not: 2.4 pieces is not a whole number of them.
  createUnit(context.db, { symbol: 'carton', name: 'Carton', decimalPlaces: 1 }, ACTOR);
  createUnit(context.db, { symbol: 'trip', name: 'Trip', decimalPlaces: 0 }, ACTOR);
  productIds.soap = createProduct(
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
  // A service: bought, never stocked, so it takes the other road through Save.
  productIds.cartage = createProduct(
    context.db,
    {
      name: 'Cartage to site',
      unit: 'trip',
      costPrice: parseMoney('50.00'),
      sellingPrice: parseMoney('0.00'),
      trackInventory: false,
    },
    ACTOR,
  );
  supplierId = createSupplier(context.db, { name: 'Kofi Wholesale' }, ACTOR);
  cash = context.db.select().from(paymentAccounts).all()[0]!.id;
});

afterEach(() => context.cleanup());

const productOf = (line: Entry) => String(productIds[line.product ?? 'soap']);

/** What the form would show and allow, from the data the page gives it. */
function screenReads(c: Case) {
  return readPurchase({
    rows: rowsFor(c),
    products: loadEntryProducts(context.db),
    invoiceDiscount: c.invoiceDiscount ?? '',
    payAmount: c.pay ?? '',
    canPay: true,
    taxComponents: getTaxProfile(context.db).components,
    businessDate: c.date ?? TODAY,
    lockedBefore: c.lockedBefore ?? null,
    invoiceNo: c.invoiceNo ?? '',
    reference: c.reference ?? '',
  });
}

/** The rows as the form holds them. */
function rowsFor(c: Case) {
  return c.lines.map((line) => ({
    productId: productOf(line),
    qty: line.qty,
    alt: line.alt ?? false,
    unitCost: line.cost,
    discount: line.discount ?? '',
    expiryDate: '',
  }));
}

/** What Save stored, through the real action. Null when it refused. */
async function saveStores(c: Case) {
  const formData = new FormData();
  formData.set(
    'basket',
    purchaseBasket({
      supplierId: String(supplierId),
      businessDate: c.date ?? TODAY,
      invoiceNo: c.invoiceNo ?? '',
      note: '',
      invoiceDiscount: c.invoiceDiscount ?? '',
      rows: rowsFor(c),
      lines: screenReads(c).lines,
      payAccountId: String(cash),
      payAmount: c.pay ?? '',
      reference: c.reference ?? '',
    }),
  );
  const result = await createPurchaseAction({}, formData);
  if (result.purchaseId === undefined) return null;

  const db = context.db as Db;
  const row = db.select().from(purchases).where(eq(purchases.id, result.purchaseId)).get()!;
  const paid = db
    .select()
    .from(purchasePayments)
    .where(eq(purchasePayments.purchaseId, result.purchaseId))
    .all()
    .reduce((total, payment) => total + payment.amountMinor, 0);
  return { subtotal: row.subtotalMinor, total: row.totalMinor, outstanding: row.totalMinor - paid };
}

const CASES: Case[] = [
  { name: 'a plain line', lines: [{ qty: '2', cost: '3.00' }] },
  { name: 'a line discount', lines: [{ qty: '2', cost: '3.00', discount: '1.50' }] },
  { name: 'a line discount larger than the line', lines: [{ qty: '2', cost: '3.00', discount: '7.00' }] },
  { name: 'a negative line discount', lines: [{ qty: '2', cost: '3.00', discount: '-1.00' }] },
  { name: 'a discount of the whole line, alone', lines: [{ qty: '2', cost: '3.00', discount: '6.00' }] },
  { name: 'free goods alone', lines: [{ qty: '2', cost: '0' }] },
  { name: 'free goods beside paid ones', lines: [{ qty: '2', cost: '0' }, { qty: '1', cost: '3.00' }] },
  { name: 'an empty cost box', lines: [{ qty: '2', cost: '' }] },
  { name: 'a zero quantity', lines: [{ qty: '0', cost: '3.00' }] },
  { name: 'a quantity finer than the unit', lines: [{ qty: '1.5', cost: '3.00' }] },
  { name: 'half a carton', lines: [{ qty: '0.5', cost: '72.00', alt: true }] },
  { name: 'a tenth of a carton, which is 2.4 pieces', lines: [{ qty: '0.1', cost: '72.00', alt: true }] },
  { name: 'too many places for a carton', lines: [{ qty: '1.25', cost: '72.00', alt: true }] },
  { name: 'a comma as a decimal point', lines: [{ qty: '2', cost: '2,50' }] },
  { name: 'proper thousands grouping', lines: [{ qty: '2', cost: '1,250.00' }] },
  { name: 'a service bought on its own', lines: [{ product: 'cartage', qty: '1', cost: '50.00' }] },
  { name: 'a free service beside paid goods', lines: [{ product: 'cartage', qty: '1', cost: '0' }, { qty: '2', cost: '3.00' }] },
  { name: 'an invoice discount', lines: [{ qty: '2', cost: '3.00' }], invoiceDiscount: '1.00' },
  { name: 'an invoice discount larger than the lines', lines: [{ qty: '2', cost: '3.00' }], invoiceDiscount: '6.01' },
  { name: 'an invoice discount of the whole purchase', lines: [{ qty: '2', cost: '3.00' }], invoiceDiscount: '6.00' },
  { name: 'part paid', lines: [{ qty: '2', cost: '3.00' }], pay: '2.00' },
  { name: 'paying all of it', lines: [{ qty: '2', cost: '3.00' }], pay: '6.00' },
  { name: 'paying more than the total', lines: [{ qty: '2', cost: '3.00' }], pay: '6.01' },
  { name: 'the Ghana taxes', lines: [{ qty: '10', cost: '86.00' }], ghanaTaxes: true },
  { name: 'paying all of it with tax on top', lines: [{ qty: '10', cost: '86.00' }], pay: '1032.00', ghanaTaxes: true },
  { name: 'taxed, then discounted to nothing', lines: [{ qty: '2', cost: '3.00' }], invoiceDiscount: '6.00', ghanaTaxes: true },
  { name: 'a date that does not exist', lines: [{ qty: '2', cost: '3.00' }], date: '2026-02-30' },
  { name: 'a date inside the books lock', lines: [{ qty: '2', cost: '3.00' }], lockedBefore: '2026-08-31' },
  { name: 'the lock date itself', lines: [{ qty: '2', cost: '3.00' }], date: '2026-08-31', lockedBefore: '2026-08-31' },
  { name: 'the day after the books lock', lines: [{ qty: '2', cost: '3.00' }], date: '2026-09-01', lockedBefore: '2026-08-31' },
  { name: 'an invoice number at the limit', lines: [{ qty: '2', cost: '3.00' }], invoiceNo: 'N'.repeat(60) },
  { name: 'an invoice number over the limit', lines: [{ qty: '2', cost: '3.00' }], invoiceNo: 'N'.repeat(61) },
  { name: 'a reference over the limit', lines: [{ qty: '2', cost: '3.00' }], pay: '1.00', reference: 'R'.repeat(81) },
];

function arrange(c: Case) {
  if (c.ghanaTaxes) setGhanaTaxes(context.db);
  if (c.lockedBefore) {
    context.db
      .update(businessSettings)
      .set({ booksLockedBefore: c.lockedBefore })
      .where(eq(businessSettings.id, 1))
      .run();
  }
}

describe('the new-purchase form and Save agree', () => {
  it.each(CASES)('$name', async (c) => {
    arrange(c);

    const reading = screenReads(c);
    const stored = await saveStores(c);

    expect(reading.acceptable).toBe(stored !== null);
    if (stored !== null) {
      expect(reading.subtotal).toBe(stored.subtotal);
      expect(reading.total).toBe(stored.total);
      expect(reading.outstanding).toBe(stored.outstanding);
    }
  });

  it('covers both answers, so it can catch a disagreement either way', () => {
    // A table where every case saved, or every case was refused, would agree
    // with a form that allowed everything, or nothing.
    const outcomes = new Set(
      CASES.map((c) => {
        arrange(c);
        return screenReads(c).acceptable;
      }),
    );
    expect(outcomes).toEqual(new Set([true, false]));
  });
});
