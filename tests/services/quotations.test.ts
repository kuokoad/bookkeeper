import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts, products, quotationItems, sales } from '@/db/schema';
import { writeTransaction } from '@/db/transaction';
import { createProduct } from '@/services/catalog.service';
import { recordStockMovement } from '@/services/inventory.service';
import { getTrialBalance } from '@/services/reporting/balances.service';
import { listAuditLogs } from '@/services/audit.service';
import { getSale } from '@/services/sale.service';
import {
  cancelQuotation,
  convertQuotation,
  countQuotations,
  createQuotation,
  getQuotation,
  isExpired,
  listQuotations,
  updateQuotation,
} from '@/services/quotation.service';
import { setGhanaTaxes } from '../helpers/tax';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * A quote is a proposal, not an accounting record.
 *
 * Everything below tests one of two things: that a quote leaves the books
 * entirely alone until it converts, and that when it does convert the customer
 * is charged what they were promised.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-29';
const NEXT_MONTH = '2026-09-28';
const LAST_WEEK = '2026-08-22';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;
let CEMENT = 0;

function stock(productId: number, qtyUnits: number, unitCost: number): void {
  writeTransaction(context.db, (tx) =>
    recordStockMovement(tx, {
      productId,
      direction: 'IN',
      qty: u(qtyUnits),
      totalCost: m(unitCost * qtyUnits),
      movementType: 'PURCHASE',
      sourceType: 'TEST',
      businessDate: TODAY,
      occurredAt: new Date(`${TODAY}T08:00:00Z`),
      userId: 1,
    }),
  );
}

function quoteFor(overrides: Partial<Parameters<typeof createQuotation>[1]> = {}) {
  return createQuotation(
    context.db,
    {
      businessDate: TODAY,
      validUntil: NEXT_MONTH,
      customerName: 'Kofi Mensah',
      lines: [{ productId: CEMENT, qty: u(40) }],
      ...overrides,
    },
    ACTOR,
  );
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
  CEMENT = createProduct(
    context.db,
    { name: 'Cement 50kg', costPrice: m(6_500), sellingPrice: m(8_000), unit: 'bag' },
    ACTOR,
  );
  stock(CEMENT, 200, 6_500);
});

afterEach(() => context.cleanup());

describe('writing a quote', () => {
  it('gives it a number a contractor can quote back', () => {
    expect(quoteFor().quoteNo).toBe('QTE-00001');
    expect(quoteFor().quoteNo).toBe('QTE-00002');
  });

  it('prices it from the product list when no price is offered', () => {
    const quote = getQuotation(context.db, quoteFor().quotationId);
    expect(quote.items[0]!.unitPriceMinor).toBe(8_000);
    expect(quote.totalMinor).toBe(320_000);
  });

  it('takes a negotiated price without needing a permission at this layer', () => {
    const created = quoteFor({ lines: [{ productId: CEMENT, qty: u(40), unitPrice: m(7_500) }] });
    expect(getQuotation(context.db, created.quotationId).totalMinor).toBe(300_000);
  });

  it('snapshots the product name, so a later rename cannot rewrite the offer', () => {
    const created = quoteFor();
    context.db
      .update(products)
      .set({ name: 'Dangote Cement 50kg' })
      .where(eq(products.id, CEMENT))
      .run();

    expect(getQuotation(context.db, created.quotationId).items[0]!.productName).toBe('Cement 50kg');
  });

  it('refuses a quote with nothing on it', () => {
    expect(() => quoteFor({ lines: [] })).toThrow(/at least one item/i);
  });

  it('refuses a quote with nobody to give it to', () => {
    expect(() => quoteFor({ customerName: '   ' })).toThrow(/who the quote is for/i);
  });

  it('refuses to expire before it is issued', () => {
    expect(() => quoteFor({ validUntil: LAST_WEEK })).toThrow(/cannot expire before/i);
  });

  it('records who wrote it and when it runs out', () => {
    const created = quoteFor();
    const summary = listAuditLogs(context.db, { action: 'CREATE' })[0]?.summary ?? '';
    expect(summary).toContain(created.quoteNo);
    expect(summary).toContain('Kofi Mensah');
    expect(summary).toContain(NEXT_MONTH);
  });
});

describe('changing a quote', () => {
  it('replaces its lines, because an offer is not history', () => {
    const created = quoteFor();
    updateQuotation(
      context.db,
      created.quotationId,
      {
        validUntil: NEXT_MONTH,
        customerName: 'Kofi Mensah',
        lines: [{ productId: CEMENT, qty: u(60) }],
      },
      ACTOR,
    );

    const quote = getQuotation(context.db, created.quotationId);
    expect(quote.items).toHaveLength(1);
    expect(quote.items[0]!.qtyMilli).toBe(60_000);
    expect(quote.totalMinor).toBe(480_000);
    // The number does not change: the contractor is holding paper with it on.
    expect(quote.quoteNo).toBe(created.quoteNo);
  });

  it('refuses once the quote has become a sale', () => {
    const created = quoteFor();
    convertQuotation(
      context.db,
      created.quotationId,
      { businessDate: TODAY, tenders: [{ paymentAccountId: CASH, amount: m(320_000) }] },
      ACTOR,
    );

    expect(() =>
      updateQuotation(
        context.db,
        created.quotationId,
        { validUntil: NEXT_MONTH, customerName: 'Kofi', lines: [{ productId: CEMENT, qty: u(1) }] },
        ACTOR,
      ),
    ).toThrow(/already become a sale/i);
  });

  it('refuses once the quote has been cancelled', () => {
    const created = quoteFor();
    cancelQuotation(context.db, created.quotationId, 'Customer went elsewhere', ACTOR);

    expect(() =>
      updateQuotation(
        context.db,
        created.quotationId,
        { validUntil: NEXT_MONTH, customerName: 'Kofi', lines: [{ productId: CEMENT, qty: u(1) }] },
        ACTOR,
      ),
    ).toThrow(/cancelled/i);
  });

  it('will not cancel without a reason', () => {
    const created = quoteFor();
    expect(() => cancelQuotation(context.db, created.quotationId, '  ', ACTOR)).toThrow(/why/i);
  });
});

describe('turning a quote into a sale', () => {
  it('charges what was quoted, even after the shelf price moves', () => {
    const created = quoteFor({ lines: [{ productId: CEMENT, qty: u(40), unitPrice: m(7_500) }] });

    // The shop puts its price up the next morning.
    context.db
      .update(products)
      .set({ sellingPriceMinor: 9_000 })
      .where(eq(products.id, CEMENT))
      .run();

    const converted = convertQuotation(
      context.db,
      created.quotationId,
      { businessDate: TODAY, tenders: [{ paymentAccountId: CASH, amount: m(300_000) }] },
      ACTOR,
    );

    const sale = getSale(context.db, converted.saleId);
    expect(sale.items[0]!.unitPriceMinor).toBe(7_500);
    expect(sale.totalMinor).toBe(300_000);
  });

  /**
   * The property the whole design rests on. A quote's total must equal the total
   * of the sale it becomes, exactly, in minor units — not nearly, and not after
   * rounding. Both come from `calculateSale`, which is what makes it true by
   * construction.
   */
  it('produces a sale whose total is the quoted total, to the pesewa', () => {
    const created = quoteFor({
      lines: [
        { productId: CEMENT, qty: u(37), unitPrice: m(7_333) },
        { productId: CEMENT, qty: u(3), unitPrice: m(8_000), discount: m(1_111) },
      ],
      quoteDiscount: m(2_777),
    });
    const quote = getQuotation(context.db, created.quotationId);

    const converted = convertQuotation(
      context.db,
      created.quotationId,
      { businessDate: TODAY, tenders: [{ paymentAccountId: CASH, amount: quote.totalMinor as Minor }] },
      ACTOR,
    );

    expect(getSale(context.db, converted.saleId).totalMinor).toBe(quote.totalMinor);
  });

  it('closes the quote and links it to the sale, both ways', () => {
    const created = quoteFor();
    const converted = convertQuotation(
      context.db,
      created.quotationId,
      { businessDate: TODAY, tenders: [{ paymentAccountId: CASH, amount: m(320_000) }] },
      ACTOR,
    );

    const quote = getQuotation(context.db, created.quotationId);
    expect(quote.status).toBe('CONVERTED');
    expect(quote.convertedSaleId).toBe(converted.saleId);
    expect(getSale(context.db, converted.saleId).note).toContain(created.quoteNo);
  });

  it('refuses a second conversion', () => {
    const created = quoteFor();
    convertQuotation(
      context.db,
      created.quotationId,
      { businessDate: TODAY, tenders: [{ paymentAccountId: CASH, amount: m(320_000) }] },
      ACTOR,
    );

    expect(() =>
      convertQuotation(
        context.db,
        created.quotationId,
        { businessDate: TODAY, tenders: [{ paymentAccountId: CASH, amount: m(320_000) }] },
        ACTOR,
      ),
    ).toThrow(/already become a sale/i);

    expect(context.db.select().from(sales).all()).toHaveLength(1);
  });

  /**
   * Belt and braces. Converting twice would ship the goods twice off one piece
   * of paper, and both sales would look internally perfect, so the database
   * refuses it too rather than trusting the check above to be reached.
   */
  it('is refused by the database as well as by the service', () => {
    const created = quoteFor();
    const converted = convertQuotation(
      context.db,
      created.quotationId,
      { businessDate: TODAY, tenders: [{ paymentAccountId: CASH, amount: m(320_000) }] },
      ACTOR,
    );
    const second = quoteFor();

    expect(() =>
      context.connection
        .prepare('UPDATE quotations SET status = ?, converted_sale_id = ? WHERE id = ?')
        .run('CONVERTED', converted.saleId, second.quotationId),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it('creates the customer at conversion, when asked', () => {
    const created = quoteFor({ customerName: 'Adom Construction', customerPhone: '024 000 0000' });
    const converted = convertQuotation(
      context.db,
      created.quotationId,
      {
        businessDate: TODAY,
        createCustomer: true,
        termsDays: 30,
        tenders: [{ paymentAccountId: CASH, amount: m(0) }],
      },
      ACTOR,
    );

    const sale = getSale(context.db, converted.saleId);
    expect(sale.customerId).not.toBeNull();
    expect(getQuotation(context.db, created.quotationId).customerId).toBe(sale.customerId);
  });
});

describe('a quote whose promise has run out', () => {
  const expiredQuote = () => quoteFor({ businessDate: LAST_WEEK, validUntil: LAST_WEEK });

  it('is refused, naming the day it was good to', () => {
    const created = expiredQuote();
    expect(() =>
      convertQuotation(
        context.db,
        created.quotationId,
        { businessDate: TODAY, tenders: [{ paymentAccountId: CASH, amount: m(320_000) }] },
        ACTOR,
      ),
    ).toThrow(new RegExp(LAST_WEEK));
  });

  it('converts when the owner says why, and the reason is kept', () => {
    const created = expiredQuote();
    convertQuotation(
      context.db,
      created.quotationId,
      {
        businessDate: TODAY,
        overrideReason: 'Agreed with the customer on the phone',
        tenders: [{ paymentAccountId: CASH, amount: m(320_000) }],
      },
      ACTOR,
    );

    const quote = getQuotation(context.db, created.quotationId);
    expect(quote.status).toBe('CONVERTED');
    expect(quote.overrideReason).toBe('Agreed with the customer on the phone');

    const summary = listAuditLogs(context.db, { action: 'UPDATE' })[0]?.summary ?? '';
    expect(summary).toContain('honoured');
  });

  it('knows itself as expired without a stored status', () => {
    expect(isExpired({ status: 'OPEN', validUntil: LAST_WEEK }, TODAY)).toBe(true);
    expect(isExpired({ status: 'OPEN', validUntil: NEXT_MONTH }, TODAY)).toBe(false);
    expect(isExpired({ status: 'CONVERTED', validUntil: LAST_WEEK }, TODAY)).toBe(false);
  });
});

describe('the quote list', () => {
  it('counts what it lists, from the same conditions', () => {
    quoteFor();
    quoteFor({ customerName: 'Ama Serwaa' });
    const cancelled = quoteFor();
    cancelQuotation(context.db, cancelled.quotationId, 'Changed mind', ACTOR);

    expect(listQuotations(context.db, { status: 'OPEN' })).toHaveLength(2);
    expect(countQuotations(context.db, { status: 'OPEN' })).toBe(2);
    expect(countQuotations(context.db, { status: 'CANCELLED' })).toBe(1);
  });

  it('finds a quote by its number, its customer or the job', () => {
    quoteFor({ customerName: 'Adom Construction', reference: 'Adenta site' });

    expect(countQuotations(context.db, { search: 'adom' })).toBe(1);
    expect(countQuotations(context.db, { search: 'adenta' })).toBe(1);
    expect(countQuotations(context.db, { search: 'QTE-00001' })).toBe(1);
    expect(countQuotations(context.db, { search: 'nothing here' })).toBe(0);
  });

  it('shows the ones that have quietly run out', () => {
    quoteFor();
    quoteFor({ businessDate: LAST_WEEK, validUntil: LAST_WEEK });

    expect(countQuotations(context.db, { expired: true }, TODAY)).toBe(1);
  });

  it('treats an id that matches nothing as an empty result, not an error', () => {
    quoteFor();
    expect(listQuotations(context.db, { customerId: 9_999 })).toEqual([]);
  });
});

describe('a quote changes nothing in the books', () => {
  const count = (table: string): number =>
    (context.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  const snapshot = () => ({
    stock: context.db
      .select({ id: products.id, qty: products.qtyOnHandMilli, value: products.stockValueMinor })
      .from(products)
      .orderBy(asc(products.id))
      .all(),
    entries: count('journal_entries'),
    lines: count('journal_lines'),
    ledger: count('stock_ledger'),
    sales: count('sales'),
    trial: getTrialBalance(context.db),
  });

  /**
   * Written the way `sales-filters.test.ts` asserts that filtering writes
   * nothing: snapshot everything that could move, do the thing, compare. A
   * quote that quietly reserved stock or posted an entry would look exactly
   * like a quote that did not.
   */
  it('leaves stock, the ledger and the trial balance exactly as they were', () => {
    const before = snapshot();

    const created = quoteFor();
    updateQuotation(
      context.db,
      created.quotationId,
      {
        validUntil: NEXT_MONTH,
        customerName: 'Kofi Mensah',
        lines: [{ productId: CEMENT, qty: u(120) }],
      },
      ACTOR,
    );
    getQuotation(context.db, created.quotationId);
    listQuotations(context.db, { status: 'OPEN' });
    cancelQuotation(context.db, created.quotationId, 'Went elsewhere', ACTOR);

    expect(snapshot()).toEqual(before);
  });

  it('does not reserve the stock it quotes', () => {
    quoteFor({ lines: [{ productId: CEMENT, qty: u(200) }] });
    const product = context.db.select().from(products).where(eq(products.id, CEMENT)).get();
    expect(product!.qtyOnHandMilli).toBe(200_000);
  });
});

describe('conversion is all or nothing', () => {
  /**
   * The quote asks for more cement than the shop has. `createSale` refuses, and
   * because that call sits inside this service's own transaction, everything
   * unwinds: no sale, no entry, no stock movement, and the quote still open for
   * somebody to fix.
   */
  it('leaves the quote open and the books untouched when the sale fails', () => {
    const created = quoteFor({ lines: [{ productId: CEMENT, qty: u(500) }] });
    const before = {
      sales: context.db.select().from(sales).all().length,
      entries: (
        context.connection.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as {
          n: number;
        }
      ).n,
      stock: context.db.select().from(products).where(eq(products.id, CEMENT)).get()!
        .qtyOnHandMilli,
    };

    expect(() =>
      convertQuotation(
        context.db,
        created.quotationId,
        { businessDate: TODAY, tenders: [{ paymentAccountId: CASH, amount: m(4_000_000) }] },
        ACTOR,
      ),
    ).toThrow();

    expect(context.db.select().from(sales).all()).toHaveLength(before.sales);
    expect(
      (
        context.connection.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as {
          n: number;
        }
      ).n,
    ).toBe(before.entries);
    expect(
      context.db.select().from(products).where(eq(products.id, CEMENT)).get()!.qtyOnHandMilli,
    ).toBe(before.stock);

    const quote = getQuotation(context.db, created.quotationId);
    expect(quote.status).toBe('OPEN');
    expect(quote.convertedSaleId).toBeNull();
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });

  it('leaves no orphan quote lines behind after a failed edit', () => {
    const created = quoteFor();
    expect(() =>
      updateQuotation(
        context.db,
        created.quotationId,
        { validUntil: NEXT_MONTH, customerName: 'Kofi', lines: [{ productId: 9_999, qty: u(1) }] },
        ACTOR,
      ),
    ).toThrow();

    const items = context.db
      .select()
      .from(quotationItems)
      .where(eq(quotationItems.quotationId, created.quotationId))
      .all();
    expect(items).toHaveLength(1);
    expect(items[0]!.qtyMilli).toBe(40_000);
  });
});

/**
 * The case that earns `quotations.quoteDiscountMinor` its column.
 *
 * Where a shop prices tax-inclusive, the discount it TYPED and the discount
 * stored net of tax are different numbers. Converting from the net one hands
 * the customer a sale costing more than the paper in their hand, and every
 * figure on it looks perfectly ordinary. These run the full Ghanaian stack:
 * NHIL and the GETFund levy on the net, VAT on the sum.
 */
describe('a shop that prices tax-inclusive', () => {
  for (const inclusive of [false, true]) {
    it(`quotes and sells the same total, tax ${inclusive ? 'inclusive' : 'exclusive'}`, () => {
      setGhanaTaxes(context.db, { inclusive });

      const created = quoteFor({
        lines: [
          { productId: CEMENT, qty: u(37), unitPrice: m(7_333) },
          { productId: CEMENT, qty: u(3), unitPrice: m(8_000), discount: m(1_111) },
        ],
        quoteDiscount: m(2_777),
      });
      const quote = getQuotation(context.db, created.quotationId);

      const converted = convertQuotation(
        context.db,
        created.quotationId,
        {
          businessDate: TODAY,
          tenders: [{ paymentAccountId: CASH, amount: quote.totalMinor as Minor }],
        },
        ACTOR,
      );

      const sale = getSale(context.db, converted.saleId);
      expect(sale.totalMinor).toBe(quote.totalMinor);
      expect(sale.taxMinor).toBe(quote.taxMinor);
      expect(sale.discountMinor).toBe(quote.discountMinor);
      expect(getTrialBalance(context.db).balanced).toBe(true);
    });
  }

  it('keeps the typed discount apart from the net one when tax is inclusive', () => {
    setGhanaTaxes(context.db, { inclusive: true });
    const created = quoteFor({ quoteDiscount: m(10_000) });
    const quote = getQuotation(context.db, created.quotationId);

    // The whole reason the column exists: these two are NOT the same number.
    expect(quote.quoteDiscountMinor).toBe(10_000);
    expect(quote.discountMinor).toBeLessThan(10_000);
  });
});
