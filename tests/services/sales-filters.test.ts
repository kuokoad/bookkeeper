import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { monthOf } from '../helpers/clock';
import { toBusinessDate } from '@/lib/format';
import { categories, paymentAccounts, products } from '@/db/schema';
import { createCategory, createProduct } from '@/services/catalog.service';
import { createCustomer } from '@/services/customer.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import {
  countSales,
  createSale,
  getFilteredSalesSummary,
  listSales,
  voidSale,
} from '@/services/sale.service';
import { recordCustomerPayment } from '@/services/customer-payment.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import { eq } from 'drizzle-orm';

/**
 * Filtering sales, end to end.
 *
 * Two properties are asserted over and over here, because they are the two that
 * make a filtered page trustworthy:
 *
 *   1. The FILTER narrows the rows in SQL, before any page limit — so "credit
 *      sales" means every credit sale, not the credit sales among the first
 *      page of results.
 *   2. The TOTALS above the table are computed from the same clause as the
 *      table. Filtered rows over unfiltered totals is the specific way a
 *      bookkeeping page misleads its owner.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const STAFF = { id: 2, username: 'ama' };

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;
let MOMO = 0;
let DRINKS = 0;
let FOOD = 0;
let COKE = 0;
let RICE = 0;
let KOFI = 0;
let AMA = 0;

function stocked(name: string, categoryId: number, price: number, date: string): number {
  const id = createProduct(
    context.db,
    { name, categoryId, costPrice: m(500), sellingPrice: m(price), unit: 'pcs' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: date,
      reason: 'OPENING_STOCK',
      items: [{ productId: id, direction: 'IN', qty: u(500), totalCost: m(250_000) }],
    },
    ACTOR,
  );
  return id;
}

beforeEach(() => {
  context = createTestDatabase();
  const insertUser = context.connection.prepare(
    'INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)',
  );
  insertUser.run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  insertUser.run(2, 'ama', 'Ama', 'STAFF', 'scrypt$1$2$3$a$b');

  const accounts = context.db.select().from(paymentAccounts).all();
  CASH = accounts.find((account) => account.kind === 'CASH')!.id;
  MOMO = accounts.find((account) => account.kind === 'MOBILE_MONEY')!.id;

  DRINKS = createCategory(context.db, { name: 'Drinks' }, ACTOR);
  FOOD = createCategory(context.db, { name: 'Food' }, ACTOR);

  COKE = stocked('Coca-Cola 500ml', DRINKS, 500, '2026-07-31');
  RICE = stocked('Rice 5kg', FOOD, 6_000, '2026-07-31');

  KOFI = createCustomer(context.db, { name: 'Kofi Mensah', phone: '0244000111' }, ACTOR);
  AMA = createCustomer(context.db, { name: 'Ama Serwaa', phone: '0201234567' }, ACTOR);
});

afterEach(() => {
  context.cleanup();
});

/** A cash sale of Coca-Cola, on the given day. */
function cokeSale(date: string, quantity: number, actor = ACTOR): number {
  return createSale(
    context.db,
    {
      businessDate: date,
      items: [{ productId: COKE, qty: u(quantity) }],
      tenders: [{ paymentAccountId: CASH, amount: m(500 * quantity) }],
    },
    actor,
  ).saleId;
}

/** A credit sale of rice to a named customer. Nothing tendered. */
function riceCreditSale(date: string, customerId: number, quantity: number): number {
  return createSale(
    context.db,
    {
      businessDate: date,
      customerId,
      items: [{ productId: RICE, qty: u(quantity) }],
      tenders: [],
    },
    ACTOR,
  ).saleId;
}

describe('the date filter', () => {
  it('includes sales on the last day of the range, however late they were rung up', () => {
    cokeSale('2026-08-01', 1);
    // Two on the closing day, one of them stamped late in the evening.
    cokeSale('2026-08-15', 1);
    createSale(
      context.db,
      {
        businessDate: '2026-08-15',
        items: [{ productId: COKE, qty: u(3) }],
        tenders: [{ paymentAccountId: CASH, amount: m(1_500) }],
        occurredAt: new Date('2026-08-15T23:47:00'),
      },
      ACTOR,
    );
    cokeSale('2026-08-16', 1);

    const filters = { from: '2026-08-01', to: '2026-08-15' };
    expect(countSales(context.db, filters)).toBe(3);
    expect(getFilteredSalesSummary(context.db, filters).revenue).toBe(500 + 500 + 1_500);
  });

  it('excludes a sale one day outside the range at either end', () => {
    cokeSale('2026-07-31', 1);
    cokeSale('2026-08-01', 1);
    cokeSale('2026-08-31', 1);
    cokeSale('2026-09-01', 1);

    expect(countSales(context.db, { from: '2026-08-01', to: '2026-08-31' })).toBe(2);
  });
});

describe('the customer filter', () => {
  it('narrows to one customer and totals only their sales', () => {
    riceCreditSale('2026-08-02', KOFI, 1);
    riceCreditSale('2026-08-03', KOFI, 2);
    riceCreditSale('2026-08-04', AMA, 1);
    cokeSale('2026-08-05', 1); // walk-in

    const filters = { from: '2026-08-01', to: '2026-08-31', customerId: KOFI };
    expect(countSales(context.db, filters)).toBe(2);
    expect(listSales(context.db, filters).every((row) => row.customerId === KOFI)).toBe(true);
    expect(getFilteredSalesSummary(context.db, filters).revenue).toBe(18_000);
  });
});

describe('the product and category filters', () => {
  it('finds sales containing a product', () => {
    cokeSale('2026-08-02', 2);
    riceCreditSale('2026-08-03', KOFI, 1);

    const range = { from: '2026-08-01', to: '2026-08-31' };
    expect(countSales(context.db, { ...range, productId: COKE })).toBe(1);
    expect(countSales(context.db, { ...range, productId: RICE })).toBe(1);
  });

  it('finds a mixed sale under either of its products', () => {
    createSale(
      context.db,
      {
        businessDate: '2026-08-02',
        items: [
          { productId: COKE, qty: u(2) },
          { productId: RICE, qty: u(1) },
        ],
        tenders: [{ paymentAccountId: CASH, amount: m(7_000) }],
      },
      ACTOR,
    );

    const range = { from: '2026-08-01', to: '2026-08-31' };
    expect(countSales(context.db, { ...range, productId: COKE })).toBe(1);
    expect(countSales(context.db, { ...range, productId: RICE })).toBe(1);
    // And exactly once each — the EXISTS must not multiply the sale by its lines.
    expect(listSales(context.db, { ...range, productId: COKE })).toHaveLength(1);
  });

  it('narrows by category', () => {
    cokeSale('2026-08-02', 1);
    cokeSale('2026-08-03', 1);
    riceCreditSale('2026-08-04', KOFI, 1);

    const range = { from: '2026-08-01', to: '2026-08-31' };
    expect(countSales(context.db, { ...range, categoryId: DRINKS })).toBe(2);
    expect(countSales(context.db, { ...range, categoryId: FOOD })).toBe(1);
  });
});

describe('the payment filters', () => {
  it('separates cash from mobile money', () => {
    cokeSale('2026-08-02', 1);
    createSale(
      context.db,
      {
        businessDate: '2026-08-03',
        items: [{ productId: COKE, qty: u(4) }],
        tenders: [{ paymentAccountId: MOMO, amount: m(2_000) }],
      },
      ACTOR,
    );

    const range = { from: '2026-08-01', to: '2026-08-31' };
    expect(countSales(context.db, { ...range, paymentKind: 'CASH' })).toBe(1);
    expect(countSales(context.db, { ...range, paymentKind: 'MOBILE_MONEY' })).toBe(1);
    expect(countSales(context.db, { ...range, paymentAccountId: MOMO })).toBe(1);
  });

  it('finds a split-tender sale under both methods, once each', () => {
    createSale(
      context.db,
      {
        businessDate: '2026-08-02',
        items: [{ productId: RICE, qty: u(1) }],
        tenders: [
          { paymentAccountId: CASH, amount: m(2_000) },
          { paymentAccountId: MOMO, amount: m(4_000) },
        ],
      },
      ACTOR,
    );

    const range = { from: '2026-08-01', to: '2026-08-31' };
    expect(listSales(context.db, { ...range, paymentKind: 'CASH' })).toHaveLength(1);
    expect(listSales(context.db, { ...range, paymentKind: 'MOBILE_MONEY' })).toHaveLength(1);
  });

  it('tells settled sales from ones still owing', () => {
    cokeSale('2026-08-02', 1); // paid at the till
    riceCreditSale('2026-08-03', KOFI, 1); // owing

    const range = { from: '2026-08-01', to: '2026-08-31' };
    expect(countSales(context.db, { ...range, paymentState: 'unpaid' })).toBe(1);
    expect(countSales(context.db, { ...range, paymentState: 'paid' })).toBe(1);
  });

  it('moves a credit sale to settled once the customer pays', () => {
    const saleId = riceCreditSale('2026-08-03', KOFI, 1);
    const range = { from: '2026-08-01', to: '2026-08-31' };
    expect(countSales(context.db, { ...range, paymentState: 'unpaid' })).toBe(1);

    recordCustomerPayment(
      context.db,
      {
        customerId: KOFI,
        businessDate: '2026-08-10',
        paymentAccountId: CASH,
        amount: m(6_000),
        allocations: [{ saleId, amount: m(6_000) }],
      },
      ACTOR,
    );

    expect(countSales(context.db, { ...range, paymentState: 'unpaid' })).toBe(0);
    expect(countSales(context.db, { ...range, paymentState: 'paid' })).toBe(1);
  });

  /**
   * The bug this whole exercise started from.
   *
   * "Unpaid only" used to fetch a page of sales and drop the settled ones in
   * JavaScript, so the answer was "the unpaid sales among the most recent
   * hundred" — which is not the question, and gets wronger the more the shop
   * sells. Here the one credit sale is the OLDEST of many, so a filter applied
   * after a small page limit cannot find it.
   */
  it('finds a credit sale that sits past the page limit', () => {
    const owing = riceCreditSale('2026-08-01', KOFI, 1);
    for (let day = 2; day <= 20; day++) {
      cokeSale(`2026-08-${String(day).padStart(2, '0')}`, 1);
    }

    const filters = { from: '2026-08-01', to: '2026-08-31', paymentState: 'unpaid' as const };
    expect(countSales(context.db, filters)).toBe(1);
    // Even asking for only the first five rows, the answer is the right sale.
    expect(listSales(context.db, { ...filters, limit: 5 })[0]?.id).toBe(owing);
  });
});

describe('the staff filter', () => {
  it('narrows to who rang the sale up', () => {
    cokeSale('2026-08-02', 1, ACTOR);
    cokeSale('2026-08-03', 1, STAFF);
    cokeSale('2026-08-04', 1, STAFF);

    const range = { from: '2026-08-01', to: '2026-08-31' };
    expect(countSales(context.db, { ...range, staffId: ACTOR.id })).toBe(1);
    expect(countSales(context.db, { ...range, staffId: STAFF.id })).toBe(2);
  });
});

describe('the search box', () => {
  it('finds a sale by receipt number, customer name, phone, product name and SKU', () => {
    const saleId = riceCreditSale('2026-08-03', KOFI, 1);
    const receipt = listSales(context.db, { from: '2026-08-01', to: '2026-08-31' }).find(
      (row) => row.id === saleId,
    )!.receiptNo;

    context.db
      .update(products)
      .set({ sku: 'RICE-5KG' })
      .where(eq(products.id, RICE))
      .run();

    const range = { from: '2026-08-01', to: '2026-08-31' };
    for (const term of [receipt, 'kofi', '0244', 'rice', 'RICE-5KG']) {
      expect(listSales(context.db, { ...range, search: term }).map((row) => row.id)).toContain(
        saleId,
      );
    }
  });

  it('is case-insensitive and matches part of a word', () => {
    riceCreditSale('2026-08-03', AMA, 1);
    const range = { from: '2026-08-01', to: '2026-08-31' };
    expect(countSales(context.db, { ...range, search: 'SERWAA' })).toBe(1);
    expect(countSales(context.db, { ...range, search: 'erw' })).toBe(1);
  });

  it('finds nothing for a term nobody used, rather than everything', () => {
    cokeSale('2026-08-02', 1);
    expect(countSales(context.db, { from: '2026-08-01', to: '2026-08-31', search: 'zzz' })).toBe(0);
  });
});

describe('the amount filter', () => {
  it('narrows to a band of sale totals', () => {
    cokeSale('2026-08-02', 1); // 5.00
    cokeSale('2026-08-03', 20); // 100.00
    riceCreditSale('2026-08-04', KOFI, 10); // 600.00

    const range = { from: '2026-08-01', to: '2026-08-31' };
    expect(countSales(context.db, { ...range, minAmount: m(10_000) })).toBe(2);
    expect(countSales(context.db, { ...range, maxAmount: m(10_000) })).toBe(2);
    expect(countSales(context.db, { ...range, minAmount: m(9_000), maxAmount: m(11_000) })).toBe(1);
  });
});

describe('filters combined', () => {
  /**
   * The example from the brief: a date range AND a category AND a payment
   * method AND a search term. The result must satisfy all four.
   */
  it('satisfies every condition at once', () => {
    // The one that should match: August, Drinks, cash, Coca-Cola.
    const wanted = cokeSale('2026-08-10', 2);

    // Right product and month, wrong payment method.
    createSale(
      context.db,
      {
        businessDate: '2026-08-11',
        items: [{ productId: COKE, qty: u(2) }],
        tenders: [{ paymentAccountId: MOMO, amount: m(1_000) }],
      },
      ACTOR,
    );
    // Right month and method, wrong category.
    createSale(
      context.db,
      {
        businessDate: '2026-08-12',
        items: [{ productId: RICE, qty: u(1) }],
        tenders: [{ paymentAccountId: CASH, amount: m(6_000) }],
      },
      ACTOR,
    );
    // Right everything, wrong month.
    cokeSale('2026-09-01', 2);

    const filters = {
      from: '2026-08-01',
      to: '2026-08-31',
      categoryId: DRINKS,
      paymentKind: 'CASH' as const,
      search: 'Coca',
    };

    const rows = listSales(context.db, filters);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(wanted);
    expect(countSales(context.db, filters)).toBe(1);
    expect(getFilteredSalesSummary(context.db, filters).revenue).toBe(1_000);
  });
});

describe('filtered totals', () => {
  /**
   * The requirement that matters most on a bookkeeping page: the figures above
   * the table describe THAT table. Filtered rows under unfiltered totals is a
   * page that lies.
   */
  it('totals exactly the sales the filter selects', () => {
    cokeSale('2026-08-05', 10); // 50.00, cash, drinks
    cokeSale('2026-08-06', 4); // 20.00, cash, drinks
    riceCreditSale('2026-08-07', KOFI, 5); // 300.00, credit, food
    cokeSale('2026-08-20', 10); // outside the first fortnight

    const filters = { from: '2026-08-01', to: '2026-08-15', paymentKind: 'CASH' as const };
    const summary = getFilteredSalesSummary(context.db, filters);
    const rows = listSales(context.db, filters);

    expect(summary.count).toBe(2);
    expect(rows).toHaveLength(2);
    // Revenue, quantity and cost all agree with the rows on screen.
    expect(summary.revenue).toBe(rows.reduce((total, row) => total + row.totalMinor, 0));
    expect(summary.cogs).toBe(rows.reduce((total, row) => total + row.cogsMinor, 0));
    expect(summary.grossProfit).toBe(summary.revenue - summary.cogs);
    expect(summary.quantity).toBe(fromUnits(14));
  });

  it('does not multiply a sale by its number of lines', () => {
    createSale(
      context.db,
      {
        businessDate: '2026-08-02',
        items: [
          { productId: COKE, qty: u(2) },
          { productId: RICE, qty: u(1) },
        ],
        tenders: [{ paymentAccountId: CASH, amount: m(7_000) }],
      },
      ACTOR,
    );

    const summary = getFilteredSalesSummary(context.db, { from: '2026-08-01', to: '2026-08-31' });
    expect(summary.revenue).toBe(7_000);
    expect(summary.count).toBe(1);
    expect(summary.quantity).toBe(fromUnits(3));
  });

  it('counts corrections out of the sale count but keeps their money in the totals', () => {
    /*
      Today, not a literal August day: the correction document is dated from
      the clock, so a sale pinned to a fixed month stops sharing a period with
      its own mirror as soon as the month turns. The beforeEach creates no
      sales, so this window holds exactly the pair below whatever month the
      suite runs in.
    */
    const today = toBusinessDate();
    const saleId = cokeSale(today, 10);
    voidSale(context.db, saleId, 'Rang it up twice', ACTOR);

    const summary = getFilteredSalesSummary(context.db, monthOf(today));
    // One sale was rung up; the mirror document is a correction, not a customer.
    expect(summary.count).toBe(1);
    // And the pair nets to nothing, so the period shows no takings.
    expect(summary.revenue).toBe(0);
  });

  it('reports nothing rather than throwing when a filter matches no sales', () => {
    cokeSale('2026-08-02', 1);

    const filters = { from: '2026-01-01', to: '2026-01-31' };
    expect(countSales(context.db, filters)).toBe(0);
    expect(listSales(context.db, filters)).toEqual([]);

    const summary = getFilteredSalesSummary(context.db, filters);
    expect(summary).toMatchObject({
      count: 0,
      revenue: 0,
      cogs: 0,
      grossProfit: 0,
      quantity: 0,
      discount: 0,
      outstanding: 0,
    });
  });
});

describe('pagination', () => {
  it('pages through the filtered set without repeating or losing a row', () => {
    for (let day = 1; day <= 25; day++) {
      cokeSale(`2026-08-${String(day).padStart(2, '0')}`, 1);
    }
    // Noise the filter must exclude, on the same days.
    for (let day = 1; day <= 25; day++) {
      riceCreditSale(`2026-08-${String(day).padStart(2, '0')}`, KOFI, 1);
    }

    const filters = { from: '2026-08-01', to: '2026-08-31', categoryId: DRINKS };
    expect(countSales(context.db, filters)).toBe(25);

    const seen = new Set<number>();
    for (let page = 0; page < 3; page++) {
      for (const row of listSales(context.db, { ...filters, limit: 10, offset: page * 10 })) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
    }
    expect(seen.size).toBe(25);
  });

  it('returns nothing for a page past the end rather than wrapping round', () => {
    cokeSale('2026-08-02', 1);
    const filters = { from: '2026-08-01', to: '2026-08-31' };
    expect(listSales(context.db, { ...filters, limit: 10, offset: 100 })).toEqual([]);
  });

  it('leaves the count and the totals unchanged whichever page is asked for', () => {
    for (let day = 1; day <= 12; day++) {
      cokeSale(`2026-08-${String(day).padStart(2, '0')}`, 1);
    }

    const filters = { from: '2026-08-01', to: '2026-08-31' };
    const total = countSales(context.db, filters);
    const summary = getFilteredSalesSummary(context.db, filters);

    listSales(context.db, { ...filters, limit: 5, offset: 5 });

    expect(countSales(context.db, filters)).toBe(total);
    expect(getFilteredSalesSummary(context.db, filters)).toEqual(summary);
  });
});

describe('sorting', () => {
  it('sorts by amount in both directions, and pages consistently', () => {
    cokeSale('2026-08-02', 1); // 5.00
    cokeSale('2026-08-03', 20); // 100.00
    cokeSale('2026-08-04', 6); // 30.00

    const filters = { from: '2026-08-01', to: '2026-08-31', sort: 'amount' as const };
    const descending = listSales(context.db, { ...filters, direction: 'desc' });
    const ascending = listSales(context.db, { ...filters, direction: 'asc' });

    expect(descending.map((row) => row.totalMinor)).toEqual([10_000, 3_000, 500]);
    expect(ascending.map((row) => row.totalMinor)).toEqual([500, 3_000, 10_000]);
  });

  it('sorts with a filter applied rather than sorting the whole table', () => {
    cokeSale('2026-08-02', 20); // drinks, 100.00
    riceCreditSale('2026-08-03', KOFI, 100); // food, 6000.00 — biggest overall

    const rows = listSales(context.db, {
      from: '2026-08-01',
      to: '2026-08-31',
      categoryId: DRINKS,
      sort: 'amount',
      direction: 'desc',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.totalMinor).toBe(10_000);
  });
});

describe('filtering is read-only', () => {
  /**
   * Filtering must never touch stock, balances or the accounts. Asserted here
   * rather than assumed, because a query that accidentally wrote would look
   * exactly like a query that did not.
   */
  it('changes no stock and no balances, whatever is asked for', () => {
    cokeSale('2026-08-02', 5);
    riceCreditSale('2026-08-03', KOFI, 2);

    const snapshot = () => ({
      stock: context.db
        .select({ id: products.id, qty: products.qtyOnHandMilli, value: products.stockValueMinor })
        .from(products)
        .all(),
      saleCount: context.connection.prepare('SELECT COUNT(*) AS n FROM sales').get() as {
        n: number;
      },
      entries: context.connection.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as {
        n: number;
      },
      lines: context.connection.prepare('SELECT COUNT(*) AS n FROM journal_lines').get() as {
        n: number;
      },
      ledger: context.connection.prepare('SELECT COUNT(*) AS n FROM stock_ledger').get() as {
        n: number;
      },
    });

    const before = snapshot();

    const range = { from: '2026-08-01', to: '2026-08-31' };
    listSales(context.db, { ...range, categoryId: DRINKS, paymentState: 'unpaid', search: 'rice' });
    countSales(context.db, { ...range, customerId: KOFI, minAmount: m(1) });
    getFilteredSalesSummary(context.db, { ...range, paymentKind: 'MOBILE_MONEY' });
    listSales(context.db, { ...range, sort: 'profit', direction: 'asc', limit: 1, offset: 3 });

    expect(snapshot()).toEqual(before);
  });
});

describe('invalid filter values', () => {
  it('treats an id that matches nothing as an empty result, not an error', () => {
    cokeSale('2026-08-02', 1);
    const range = { from: '2026-08-01', to: '2026-08-31' };

    expect(countSales(context.db, { ...range, customerId: 99_999 })).toBe(0);
    expect(countSales(context.db, { ...range, productId: 99_999 })).toBe(0);
    expect(countSales(context.db, { ...range, categoryId: 99_999 })).toBe(0);
    expect(countSales(context.db, { ...range, staffId: 99_999 })).toBe(0);
  });

  it('survives a search term full of SQL punctuation', () => {
    cokeSale('2026-08-02', 1);
    const range = { from: '2026-08-01', to: '2026-08-31' };

    for (const term of ["'; DROP TABLE sales; --", '100%', '_', "O'Brien", '\\']) {
      expect(() => listSales(context.db, { ...range, search: term })).not.toThrow();
    }
    // And the table is still there.
    expect(countSales(context.db, range)).toBe(1);
    expect(context.db.select().from(categories).all().length).toBeGreaterThan(0);
  });

  it('returns nothing for a range that ends before it starts', () => {
    cokeSale('2026-08-02', 1);
    expect(countSales(context.db, { from: '2026-08-31', to: '2026-08-01' })).toBe(0);
  });
});
