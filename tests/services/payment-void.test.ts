import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import {
  customerPaymentAllocations,
  paymentAccounts,
  supplierPaymentAllocations,
} from '@/db/schema';
import { createProduct } from '@/services/catalog.service';
import { createCustomer, getCustomerBalance, getTotalReceivables } from '@/services/customer.service';
import { createSupplier, getSupplierBalance, getTotalPayables } from '@/services/supplier.service';
import { createPurchase, getPurchaseOutstanding } from '@/services/purchase.service';
import { createSale, getSaleOutstanding } from '@/services/sale.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { recordCustomerPayment, voidCustomerPayment } from '@/services/customer-payment.service';
import { recordSupplierPayment, voidSupplierPayment } from '@/services/supplier-payment.service';
import { getAccountBalanceByCode, getTrialBalance } from '@/services/reporting/balances.service';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * Voiding a payment, and what it must NOT throw away.
 *
 * The rule this application is built on is that history is corrected by a
 * reversing entry, never by deleting. Voiding a payment was the one place that
 * broke it: the allocation rows — the record of which sales a payment had
 * settled — were deleted outright, so that the sales would become outstanding
 * again.
 *
 * They already do. Every reader of those rows joins back to the payment and
 * counts only `status = 'POSTED'`, so marking the payment voided is what frees
 * the sales. The delete freed nothing and destroyed the answer to "what did
 * this payment actually pay for?" — which is the question somebody asks months
 * later, when a customer disputes a receipt.
 *
 * These tests hold both halves at once: the balances must behave exactly as
 * they did when the rows were deleted, AND the rows must still be there.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const DAY = '2026-08-10';
const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;

function stockedProduct(): number {
  const id = createProduct(
    context.db,
    { name: 'Rice 5kg', costPrice: m(1_000), sellingPrice: m(2_000), unit: 'bag' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: DAY,
      reason: 'OPENING_STOCK',
      items: [{ productId: id, direction: 'IN', qty: u(100), totalCost: m(100_000) }],
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
  CASH = context.db
    .select()
    .from(paymentAccounts)
    .all()
    .find((account) => account.kind === 'CASH')!.id;
});

afterEach(() => context.cleanup());

describe('voiding a customer payment', () => {
  it('puts the sale back to outstanding', () => {
    const product = stockedProduct();
    const customer = createCustomer(context.db, { name: 'Ama', creditLimit: null }, ACTOR);
    const sale = createSale(
      context.db,
      { businessDate: DAY, customerId: customer, items: [{ productId: product, qty: u(4) }], tenders: [] },
      ACTOR,
    );

    const payment = recordCustomerPayment(
      context.db,
      { customerId: customer, businessDate: DAY, paymentAccountId: CASH, amount: m(3_000) },
      ACTOR,
    );
    expect(getSaleOutstanding(context.db, sale.saleId)).toBe(5_000);
    expect(getCustomerBalance(context.db, customer)).toBe(5_000);

    voidCustomerPayment(context.db, payment.paymentId, 'Paid by mistake', ACTOR);

    expect(getSaleOutstanding(context.db, sale.saleId)).toBe(8_000);
    expect(getCustomerBalance(context.db, customer)).toBe(8_000);
  });

  it('KEEPS the record of what that payment settled', () => {
    const product = stockedProduct();
    const customer = createCustomer(context.db, { name: 'Ama', creditLimit: null }, ACTOR);
    const sale = createSale(
      context.db,
      { businessDate: DAY, customerId: customer, items: [{ productId: product, qty: u(4) }], tenders: [] },
      ACTOR,
    );
    const payment = recordCustomerPayment(
      context.db,
      { customerId: customer, businessDate: DAY, paymentAccountId: CASH, amount: m(3_000) },
      ACTOR,
    );

    voidCustomerPayment(context.db, payment.paymentId, 'Paid by mistake', ACTOR);

    const allocations = context.db
      .select()
      .from(customerPaymentAllocations)
      .where(eq(customerPaymentAllocations.paymentId, payment.paymentId))
      .all();

    expect(allocations, 'the allocation history must survive the void').toHaveLength(1);
    expect(allocations[0]!.saleId).toBe(sale.saleId);
    expect(allocations[0]!.amountMinor).toBe(3_000);
  });

  it('leaves the receivables control account and the subledger agreeing', () => {
    const product = stockedProduct();
    const customer = createCustomer(context.db, { name: 'Ama', creditLimit: null }, ACTOR);
    createSale(
      context.db,
      { businessDate: DAY, customerId: customer, items: [{ productId: product, qty: u(4) }], tenders: [] },
      ACTOR,
    );
    const payment = recordCustomerPayment(
      context.db,
      { customerId: customer, businessDate: DAY, paymentAccountId: CASH, amount: m(3_000) },
      ACTOR,
    );
    voidCustomerPayment(context.db, payment.paymentId, 'Paid by mistake', ACTOR);

    expect(getTotalReceivables(context.db)).toBe(
      getAccountBalanceByCode(context.db, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE),
    );
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });

  it('does not let a voided payment be counted twice if the customer pays again', () => {
    const product = stockedProduct();
    const customer = createCustomer(context.db, { name: 'Ama', creditLimit: null }, ACTOR);
    const sale = createSale(
      context.db,
      { businessDate: DAY, customerId: customer, items: [{ productId: product, qty: u(4) }], tenders: [] },
      ACTOR,
    );

    const wrong = recordCustomerPayment(
      context.db,
      { customerId: customer, businessDate: DAY, paymentAccountId: CASH, amount: m(3_000) },
      ACTOR,
    );
    voidCustomerPayment(context.db, wrong.paymentId, 'Wrong amount', ACTOR);

    // The corrected payment. The stale allocations must not reduce this.
    recordCustomerPayment(
      context.db,
      { customerId: customer, businessDate: DAY, paymentAccountId: CASH, amount: m(8_000) },
      ACTOR,
    );

    expect(getSaleOutstanding(context.db, sale.saleId)).toBe(0);
    expect(getCustomerBalance(context.db, customer)).toBe(0);
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });
});

describe('voiding a supplier payment', () => {
  it('puts the purchase back to outstanding and keeps the record', () => {
    const product = createProduct(
      context.db,
      { name: 'Rice 5kg', costPrice: m(1_000), sellingPrice: m(2_000), unit: 'bag' },
      ACTOR,
    );
    const supplier = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    const purchase = createPurchase(
      context.db,
      {
        businessDate: DAY,
        supplierId: supplier,
        items: [{ productId: product, qty: u(10), unitCost: m(1_000) }],
        tenders: [],
      },
      ACTOR,
    );

    const payment = recordSupplierPayment(
      context.db,
      { supplierId: supplier, businessDate: DAY, paymentAccountId: CASH, amount: m(4_000) },
      ACTOR,
    );
    expect(getPurchaseOutstanding(context.db, purchase.purchaseId)).toBe(6_000);

    voidSupplierPayment(context.db, payment.paymentId, 'Paid the wrong supplier', ACTOR);

    expect(getPurchaseOutstanding(context.db, purchase.purchaseId)).toBe(10_000);
    expect(getSupplierBalance(context.db, supplier)).toBe(10_000);

    const allocations = context.db
      .select()
      .from(supplierPaymentAllocations)
      .where(eq(supplierPaymentAllocations.paymentId, payment.paymentId))
      .all();
    expect(allocations, 'the allocation history must survive the void').toHaveLength(1);
    expect(allocations[0]!.purchaseId).toBe(purchase.purchaseId);
    expect(allocations[0]!.amountMinor).toBe(4_000);

    expect(getTotalPayables(context.db)).toBe(
      getAccountBalanceByCode(context.db, ACCOUNT_CODES.ACCOUNTS_PAYABLE),
    );
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });
});
