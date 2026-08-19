import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale } from '@/services/sale.service';
import { createCustomer } from '@/services/customer.service';
import { recordCustomerPayment } from '@/services/customer-payment.service';
import { createCustomerReturn } from '@/services/returns.service';
import { getReceivablesAgeing } from '@/services/reporting/ledger.service';
import { getAccountBalanceByCode } from '@/services/reporting/balances.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * Who owes the shop money, and for how long.
 *
 * This is the report an owner acts on: it decides which customer gets a phone
 * call. Being wrong in either direction is expensive — chasing someone who has
 * already paid costs goodwill, and missing someone who has not costs money.
 *
 * Two things have to be true. "As at a date" has to mean as at that date, not
 * as at today with the old sales filtered out. And a credit note has to reduce
 * what the customer owes, because it did.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH_ACCOUNT = 0;
let CUSTOMER = 0;

function stockedProduct(): number {
  const id = createProduct(
    context.db,
    { name: 'Rice 5kg', costPrice: m(6_000), sellingPrice: m(10_000), unit: 'pcs' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: '2026-01-01',
      reason: 'OPENING_STOCK',
      items: [{ productId: id, direction: 'IN', qty: u(50), totalCost: m(300_000) }],
    },
    ACTOR,
  );
  return id;
}

/** A sale entirely on credit — nothing tendered at the counter. */
function creditSale(businessDate: string, units: number): number {
  const product = stockedProduct();
  return createSale(
    context.db,
    {
      businessDate,
      customerId: CUSTOMER,
      items: [{ productId: product, qty: u(units) }],
      tenders: [],
    },
    ACTOR,
  ).saleId;
}

const owedAt = (asAt: string): number =>
  getReceivablesAgeing(context.db, asAt).find((row) => row.partyId === CUSTOMER)?.total ?? 0;

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  CASH_ACCOUNT = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;
  CUSTOMER = createCustomer(context.db, { name: 'Mensah Provisions' }, ACTOR);
});

afterEach(() => context.cleanup());

describe('"as at" a date in the past', () => {
  it('does not treat a payment made LATER as though it had already arrived', () => {
    creditSale('2026-03-01', 2); // GHS 200.00 on credit

    recordCustomerPayment(
      context.db,
      {
        businessDate: '2026-05-10',
        customerId: CUSTOMER,
        paymentAccountId: CASH_ACCOUNT,
        amount: m(20_000),
      },
      ACTOR,
    );

    // At the end of March the customer still owed the lot. May had not happened.
    expect(owedAt('2026-03-31')).toBe(20_000);
    // By the end of May they owed nothing.
    expect(owedAt('2026-05-31')).toBe(0);
  });

  it('ties to the receivables control account on the date asked about', () => {
    creditSale('2026-03-01', 2);
    recordCustomerPayment(
      context.db,
      {
        businessDate: '2026-05-10',
        customerId: CUSTOMER,
        paymentAccountId: CASH_ACCOUNT,
        amount: m(20_000),
      },
      ACTOR,
    );

    const control = getAccountBalanceByCode(context.db, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, {
      to: '2026-03-31',
    });
    expect(owedAt('2026-03-31')).toBe(control);
  });
});

describe('a credit note', () => {
  it('reduces what the customer owes', () => {
    const saleId = creditSale('2026-03-01', 3); // GHS 300.00 on credit

    // One case came back. Nothing refunded in cash, so it goes to their account.
    createCustomerReturn(
      context.db,
      saleId,
      {
        businessDate: '2026-03-10',
        items: [{ itemId: firstItemOf(saleId), qty: u(1) }],
        refunds: [],
      },
      ACTOR,
    );

    // GHS 300 sold, GHS 100 credited back.
    expect(owedAt('2026-03-31')).toBe(20_000);
  });

  it('keeps the ageing tied to the control account', () => {
    const saleId = creditSale('2026-03-01', 3);
    createCustomerReturn(
      context.db,
      saleId,
      {
        businessDate: '2026-03-10',
        items: [{ itemId: firstItemOf(saleId), qty: u(1) }],
        refunds: [],
      },
      ACTOR,
    );

    const control = getAccountBalanceByCode(context.db, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, {
      to: '2026-03-31',
    });
    expect(owedAt('2026-03-31')).toBe(control);
  });

  it('leaves the buckets adding up to the total', () => {
    const saleId = creditSale('2026-03-01', 3);
    createCustomerReturn(
      context.db,
      saleId,
      {
        businessDate: '2026-03-10',
        items: [{ itemId: firstItemOf(saleId), qty: u(1) }],
        refunds: [],
      },
      ACTOR,
    );

    const row = getReceivablesAgeing(context.db, '2026-06-30').find((r) => r.partyId === CUSTOMER)!;
    const buckets = row.current + row.days1to30 + row.days31to60 + row.days61to90 + row.over90;
    expect(buckets).toBe(row.total);
  });
});

/** The sale line to send back. */
function firstItemOf(saleId: number): number {
  const row = context.connection
    .prepare('SELECT id FROM sale_items WHERE sale_id = ? ORDER BY line_no LIMIT 1')
    .get(saleId) as { id: number };
  return row.id;
}
