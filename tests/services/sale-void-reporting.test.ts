import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts, sales } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale, getSalesSummary, listSales, voidSale } from '@/services/sale.service';
import { getProfitAndLoss } from '@/services/reporting/financial.service';
import { getAccountBalanceByCode } from '@/services/reporting/balances.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * What a voided sale does to the day's takings.
 *
 * Voiding writes a mirror document dated TODAY rather than reaching back into
 * a finished day — that is the whole point of correcting by reversal. The
 * ledger therefore says the sale earned money when it happened and gave it back
 * when it was corrected, and the sales figures the owner reads have to say the
 * same thing. A sales report that disagrees with the Profit & Loss is a report
 * nobody can act on.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const SALE_DAY = '2026-08-10';
const VOID_DAY = '2026-08-17';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH_ACCOUNT = 0;

function stockedProduct(): number {
  const id = createProduct(
    context.db,
    { name: 'Rice 5kg', costPrice: m(6_000), sellingPrice: m(10_000), unit: 'pcs' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: SALE_DAY,
      reason: 'OPENING_STOCK',
      items: [{ productId: id, direction: 'IN', qty: u(20), totalCost: m(120_000) }],
    },
    ACTOR,
  );
  return id;
}

/** Sell two at GHS 100.00, then void it a week later. */
function sellThenVoid(): { saleId: number } {
  const product = stockedProduct();
  const created = createSale(
    context.db,
    {
      businessDate: SALE_DAY,
      items: [{ productId: product, qty: u(2) }],
      tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(20_000) }],
    },
    ACTOR,
  );

  vi.setSystemTime(new Date(`${VOID_DAY}T10:00:00`));
  voidSale(context.db, created.saleId, 'Rang up against the wrong customer', ACTOR);

  return { saleId: created.saleId };
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  CASH_ACCOUNT = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;
  vi.setSystemTime(new Date(`${SALE_DAY}T10:00:00`));
});

afterEach(() => {
  vi.useRealTimers();
  context.cleanup();
});

describe('the reversing document', () => {
  it('is marked as a VOID, not filed as an ordinary sale', () => {
    sellThenVoid();

    const mirror = context.db.select().from(sales).all().find((row) => row.voidsSaleId !== null)!;
    // Without this a correction is indistinguishable from a customer bringing
    // goods back, and from a sale — three different things in the books.
    expect(mirror.kind).toBe('VOID');
  });
});

describe('the takings the owner reads', () => {
  it('agrees with the Profit & Loss on the day of the sale', () => {
    sellThenVoid();

    const summary = getSalesSummary(context.db, SALE_DAY, SALE_DAY);
    const pnl = getProfitAndLoss(context.db, { from: SALE_DAY, to: SALE_DAY });

    expect(summary.total).toBe(pnl.netSales);
  });

  it('agrees with the Profit & Loss on the day of the void', () => {
    sellThenVoid();

    const summary = getSalesSummary(context.db, VOID_DAY, VOID_DAY);
    const pnl = getProfitAndLoss(context.db, { from: VOID_DAY, to: VOID_DAY });

    expect(summary.total).toBe(pnl.netSales);
  });

  it('nets to nothing across both days, like the ledger does', () => {
    sellThenVoid();

    const both = getSalesSummary(context.db, SALE_DAY, VOID_DAY);
    expect(both.total).toBe(0);
    expect(both.grossProfit).toBe(0);
    // And the revenue account itself is back where it started.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.SALES_REVENUE)).toBe(0);
  });

  it('does not count the correction as another sale made', () => {
    sellThenVoid();

    // One sale was rung up and later undone. Counting the reversal as a second
    // sale would tell the owner the shop served two customers.
    expect(getSalesSummary(context.db, SALE_DAY, VOID_DAY).count).toBe(1);
    // And on the day of the correction, nobody bought anything.
    expect(getSalesSummary(context.db, VOID_DAY, VOID_DAY).count).toBe(0);
  });
});

describe('an ordinary sale, untouched', () => {
  it('still counts once, at its full value', () => {
    const product = stockedProduct();
    createSale(
      context.db,
      {
        businessDate: SALE_DAY,
        items: [{ productId: product, qty: u(2) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(20_000) }],
      },
      ACTOR,
    );

    const summary = getSalesSummary(context.db, SALE_DAY, SALE_DAY);
    expect(summary.count).toBe(1);
    expect(summary.total).toBe(20_000);
    expect(summary.grossProfit).toBe(8_000);
  });

  it('is still listed', () => {
    const product = stockedProduct();
    createSale(
      context.db,
      {
        businessDate: SALE_DAY,
        items: [{ productId: product, qty: u(1) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(10_000) }],
      },
      ACTOR,
    );

    expect(listSales(context.db, {}).length).toBeGreaterThan(0);
  });
});

describe('the operations reports', () => {
  /**
   * `operations.service` states plainly that its money figures tie back to the
   * Profit & Loss for the same period. A void must not be able to falsify that
   * claim, or the sales report and the accounts tell the owner two different
   * stories about the same week.
   */
  it('sales-by-day ties back to the Profit & Loss on EACH day', async () => {
    const { getSalesByDay } = await import('@/services/reporting/operations.service');
    sellThenVoid();

    // Checked per day, not over the whole span: dropping both halves of a void
    // nets to zero across a span containing both, so a span-wide check passes
    // while each individual day is wrong.
    for (const day of [SALE_DAY, VOID_DAY]) {
      const rows = getSalesByDay(context.db, { from: day, to: day });
      const reported = rows.reduce((running, row) => running + row.total, 0);
      const pnl = getProfitAndLoss(context.db, { from: day, to: day });

      expect(reported, `takings on ${day}`).toBe(pnl.netSales);
    }
  });

  it('money-taken-by-method nets out too', async () => {
    const { getSalesByPaymentMethod } = await import('@/services/reporting/operations.service');
    sellThenVoid();

    const methods = getSalesByPaymentMethod(context.db, { from: SALE_DAY, to: VOID_DAY });
    const received = methods.reduce((running, method) => running + method.received, 0);

    // The cash went into the till and came back out of it.
    expect(received).toBe(0);
  });
});
