import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { businessSettings, paymentAccounts, sales } from '@/db/schema';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale } from '@/services/sale.service';
import { createCustomer } from '@/services/customer.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-17';
const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;
let productId = 0;

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  CASH = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;

  productId = createProduct(
    context.db,
    { name: 'Rice', costPrice: m(1_400), sellingPrice: m(1_900), unit: 'kg' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: TODAY,
      reason: 'OPENING_STOCK',
      items: [{ productId, direction: 'IN', qty: u(500), totalCost: m(700_000) }],
    },
    ACTOR,
  );
});

afterEach(() => context.cleanup());

/** A sale of 500, paid `paid`, on `date`. */
function sell(date: string, paid: number, customerId?: number, termsDays?: number) {
  return createSale(
    context.db,
    {
      businessDate: date,
      ...(customerId !== undefined ? { customerId } : {}),
      ...(termsDays !== undefined ? { termsDays } : {}),
      items: [{ productId, unitPrice: m(50_000), qty: u(1) }],
      tenders: paid > 0 ? [{ paymentAccountId: CASH, amount: m(paid) }] : [],
      // ACTOR is an owner, who may depart from the shop's prices.
      allowPriceOverride: true,
    },
    ACTOR,
  );
}

const saleRow = (id: number) => context.db.select().from(sales).where(eq(sales.id, id)).get()!;

describe('when a sale becomes an invoice', () => {
  it('gives a credit sale an invoice number and a due date', () => {
    const customerId = createCustomer(context.db, { name: 'Ama Serwaa' }, ACTOR);
    const sale = sell(TODAY, 20_000, customerId);

    const row = saleRow(sale.saleId);
    expect(row.invoiceNo).toMatch(/^INV-\d{5}$/);
    expect(row.termsDays).toBe(30);
    expect(row.dueDate).toBe('2026-09-16');
  });

  it('gives a sale paid in full NO invoice', () => {
    const customerId = createCustomer(context.db, { name: 'Ama Serwaa' }, ACTOR);
    const sale = sell(TODAY, 50_000, customerId);

    // Issuing invoice numbers for cash sales would leave gaps in the sequence
    // that read as missing documents.
    const row = saleRow(sale.saleId);
    expect(row.invoiceNo).toBeNull();
    expect(row.dueDate).toBeNull();
    expect(row.termsDays).toBeNull();
  });

  it('gives a walk-in credit-free sale no invoice either', () => {
    const sale = sell(TODAY, 50_000);
    expect(saleRow(sale.saleId).invoiceNo).toBeNull();
  });

  it('numbers invoices in their own sequence, not the receipt one', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    sell(TODAY, 50_000, customerId); // cash — takes a receipt number only
    const first = sell(TODAY, 0, customerId);
    sell(TODAY, 50_000, customerId); // cash again
    const second = sell(TODAY, 0, customerId);

    // The two invoices are consecutive despite the cash sales between them.
    expect(saleRow(first.saleId).invoiceNo).toBe('INV-00001');
    expect(saleRow(second.saleId).invoiceNo).toBe('INV-00002');
  });
});

describe('payment terms', () => {
  it('takes the shop default', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    expect(saleRow(sell(TODAY, 0, customerId).saleId).dueDate).toBe('2026-09-16');
  });

  it('can be overridden on the sale', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    expect(saleRow(sell(TODAY, 0, customerId, 7).saleId).dueDate).toBe('2026-08-24');
  });

  it('due on receipt means the same day', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    expect(saleRow(sell(TODAY, 0, customerId, 0).saleId).dueDate).toBe(TODAY);
  });

  it('follows a changed shop default for NEW invoices only', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    const before = sell(TODAY, 0, customerId);

    context.db
      .update(businessSettings)
      .set({ defaultTermsDays: 7 })
      .where(eq(businessSettings.id, 1))
      .run();

    const after = sell(TODAY, 0, customerId);

    // The terms are snapshotted onto the sale, so an invoice already in a
    // customer's hands cannot have its due date moved under them.
    expect(saleRow(before.saleId).dueDate).toBe('2026-09-16');
    expect(saleRow(after.saleId).dueDate).toBe('2026-08-24');
  });

  it('crosses a month end correctly', () => {
    const customerId = createCustomer(context.db, { name: 'Ama' }, ACTOR);
    // 30 days from 31 January 2026 is 2 March: January has 31 days and
    // February 28 in a common year.
    expect(saleRow(sell('2026-01-31', 0, customerId).saleId).dueDate).toBe('2026-03-02');
  });
});
