import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { auditLogs, paymentAccounts } from '@/db/schema';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale } from '@/services/sale.service';
import { createCustomer } from '@/services/customer.service';
import { createSupplier } from '@/services/supplier.service';
import { createPurchase } from '@/services/purchase.service';
import { recordCustomerPayment } from '@/services/customer-payment.service';
import { recordSupplierPayment } from '@/services/supplier-payment.service';
import { createReconciliation } from '@/services/reconciliation.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * What the audit log says money was.
 *
 * Every amount in this table used to be interpolated straight from its stored
 * value, which is an integer number of pesewas: a GHS 6,000.00 supplier payment
 * read "paid 600000", and a GHS 3.50 till shortage read "short by 350". Off by
 * a hundred, with no currency and no decimal point, in the one record the
 * application promises never to change.
 *
 * That is the worst place in the shop for a wrong figure. Nobody cross-checks
 * an audit line against the ledger — it is read precisely when somebody is
 * trying to settle what happened, and a hundredfold error there is believable
 * enough to be acted on.
 *
 * These tests read the summaries a real day of trading writes and assert the
 * shop's own money format. Asserting the exact string is the point: a formatter
 * that silently reverted to raw units would still be "a string containing
 * digits", and only the literal catches it.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-16';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH_ACCOUNT = 0;

/** The summary of the newest audit row of this kind. */
function latestSummary(entityType: string): string {
  const rows = context.db.select().from(auditLogs).all();
  const match = rows.filter((row) => row.entityType === entityType).at(-1);
  if (!match) throw new Error(`No audit row written for ${entityType}`);
  return match.summary;
}

function stockedProduct(): number {
  const id = createProduct(
    context.db,
    { name: 'Cement 50kg', costPrice: m(8_000), sellingPrice: m(9_600), unit: 'bag' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: TODAY,
      reason: 'OPENING_STOCK',
      items: [{ productId: id, direction: 'IN', qty: u(500), totalCost: m(4_000_000) }],
    },
    ACTOR,
  );
  return id;
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  CASH_ACCOUNT = context.db
    .select()
    .from(paymentAccounts)
    .all()
    .find((a) => a.kind === 'CASH')!.id;
});

afterEach(() => {
  context.cleanup();
});

describe('money in the audit log', () => {
  it('records a sale total as money, not as pesewas', () => {
    const product = stockedProduct();
    createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: product, qty: u(100) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(960_000) }],
      },
      ACTOR,
    );

    // GHS 9,600.00 — not "960000".
    expect(latestSummary('sale')).toContain('total GHS 9,600.00');
    expect(latestSummary('sale')).not.toMatch(/total \d+$/);
  });

  it('records a supplier payment as money, not as pesewas', () => {
    const supplier = createSupplier(context.db, { name: 'Tema Steel Works' }, ACTOR);
    const product = stockedProduct();
    createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId: supplier,
        items: [{ productId: product, qty: u(600), unitCost: m(8_900) }],
        tenders: [],
      },
      ACTOR,
    );

    recordSupplierPayment(
      context.db,
      {
        businessDate: TODAY,
        supplierId: supplier,
        paymentAccountId: CASH_ACCOUNT,
        amount: m(600_000),
      },
      ACTOR,
    );

    // The figure from the report: "paid 600000" was GHS 6,000.00.
    expect(latestSummary('supplier_payment')).toContain('paid GHS 6,000.00 to Tema Steel Works');
  });

  it('records a purchase total as money, not as pesewas', () => {
    const supplier = createSupplier(context.db, { name: 'Ghacem Depot, Tema' }, ACTOR);
    const product = stockedProduct();
    createPurchase(
      context.db,
      {
        businessDate: TODAY,
        supplierId: supplier,
        items: [{ productId: product, qty: u(600), unitCost: m(8_900) }],
        tenders: [],
      },
      ACTOR,
    );

    expect(latestSummary('purchase')).toContain('total GHS 53,400.00');
  });

  it('records a customer payment as money, not as pesewas', () => {
    const customer = createCustomer(context.db, { name: 'Adom Construction Ltd' }, ACTOR);
    const product = stockedProduct();
    createSale(
      context.db,
      {
        businessDate: TODAY,
        customerId: customer,
        items: [{ productId: product, qty: u(100) }],
        tenders: [],
      },
      ACTOR,
    );

    recordCustomerPayment(
      context.db,
      {
        businessDate: TODAY,
        customerId: customer,
        paymentAccountId: CASH_ACCOUNT,
        amount: m(200_000),
      },
      ACTOR,
    );

    expect(latestSummary('customer_payment')).toContain(
      'received GHS 2,000.00 from Adom Construction Ltd',
    );
  });

  it('records a till shortage as money, so GHS 3.50 is not written as 350', () => {
    const product = stockedProduct();
    createSale(
      context.db,
      {
        businessDate: TODAY,
        items: [{ productId: product, qty: u(100) }],
        tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(960_000) }],
      },
      ACTOR,
    );

    createReconciliation(
      context.db,
      {
        businessDate: TODAY,
        paymentAccountId: CASH_ACCOUNT,
        actual: m(959_650),
        explanation: 'Likely wrong change during the evening rush',
        adjust: true,
      },
      ACTOR,
    );

    expect(latestSummary('reconciliation')).toContain('short by GHS 3.50');
    expect(latestSummary('reconciliation')).not.toContain('by 350');
  });
});
