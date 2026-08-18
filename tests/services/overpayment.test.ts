import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { businessSettings, paymentAccounts } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale } from '@/services/sale.service';
import {
  createCustomer,
  getCustomerBalance,
  getTotalReceivables,
} from '@/services/customer.service';
import { recordCustomerPayment } from '@/services/customer-payment.service';
import { getAccountBalanceByCode, getTrialBalance } from '@/services/reporting/balances.service';
import { getBalanceSheet } from '@/services/reporting/financial.service';
import { getReceivablesSplit } from '@/services/reporting/subledger-split';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import { ValidationError } from '@/domain/errors';

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-16';
const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH_ACCOUNT = 0;
let productCounter = 0;

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  CASH_ACCOUNT = context.db
    .select()
    .from(paymentAccounts)
    .all()
    .find((account) => account.kind === 'CASH')!.id;
  productCounter = 0;
});

afterEach(() => context.cleanup());

function allowOverpayment(allow: boolean) {
  context.db
    .update(businessSettings)
    .set({ allowOverpayment: allow })
    .where(eq(businessSettings.id, 1))
    .run();
}

/** A credit sale of 500 that leaves 300 owed. */
function sellOnCredit(customerId: number): void {
  productCounter += 1;
  const productId = createProduct(
    context.db,
    {
      name: `Rice ${productCounter}`,
      costPrice: m(1_400),
      sellingPrice: m(1_900),
      unit: 'kg',
    },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: TODAY,
      reason: 'OPENING_STOCK',
      items: [{ productId, direction: 'IN', qty: u(100), totalCost: m(140_000) }],
    },
    ACTOR,
  );
  createSale(
    context.db,
    {
      businessDate: TODAY,
      customerId,
      items: [{ productId, unitPrice: m(50_000), qty: u(1) }],
      tenders: [{ paymentAccountId: CASH_ACCOUNT, amount: m(20_000) }],
    },
    ACTOR,
  );
}

const pay = (customerId: number, amount: number) =>
  recordCustomerPayment(
    context.db,
    { customerId, businessDate: TODAY, paymentAccountId: CASH_ACCOUNT, amount: m(amount) },
    ACTOR,
  );

/** The invariants that must survive any payment, over or not. */
function assertBooksHealthy(label: string) {
  expect(getTrialBalance(context.db).balanced, `${label}: trial balance`).toBe(true);
  expect(getTotalReceivables(context.db), `${label}: A/R subledger vs control`).toBe(
    getAccountBalanceByCode(context.db, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE),
  );
  expect(getBalanceSheet(context.db, TODAY).balances, `${label}: balance sheet`).toBe(true);
}

describe('when overpayment is off (the default)', () => {
  it('refuses more than is owed', () => {
    const customerId = createCustomer(context.db, { name: 'Ama Serwaa' }, ACTOR);
    sellOnCredit(customerId);

    expect(() => pay(customerId, 40_000)).toThrow(ValidationError);
    expect(getCustomerBalance(context.db, customerId)).toBe(30_000);
  });

  it('says how to allow it, rather than only refusing', () => {
    const customerId = createCustomer(context.db, { name: 'Ama Serwaa' }, ACTOR);
    sellOnCredit(customerId);
    expect(() => pay(customerId, 40_000)).toThrow(/Settings/);
  });

  it('still accepts payment of exactly what is owed', () => {
    const customerId = createCustomer(context.db, { name: 'Ama Serwaa' }, ACTOR);
    sellOnCredit(customerId);

    pay(customerId, 30_000);
    expect(getCustomerBalance(context.db, customerId)).toBe(0);
    assertBooksHealthy('exact payment');
  });
});

describe('when overpayment is on', () => {
  it('accepts more than is owed and leaves the customer in credit', () => {
    allowOverpayment(true);
    const customerId = createCustomer(context.db, { name: 'Ama Serwaa' }, ACTOR);
    sellOnCredit(customerId);

    pay(customerId, 50_000); // 20,000 more than the 30,000 owed

    // A negative balance IS the customer being in credit.
    expect(getCustomerBalance(context.db, customerId)).toBe(-20_000);
    assertBooksHealthy('overpayment');
  });

  it('applies the credit against the next sale', () => {
    allowOverpayment(true);
    const customerId = createCustomer(context.db, { name: 'Ama Serwaa' }, ACTOR);
    sellOnCredit(customerId);
    pay(customerId, 50_000);

    sellOnCredit(customerId);
    expect(getCustomerBalance(context.db, customerId)).toBe(10_000);
    assertBooksHealthy('credit applied');
  });

  it('takes an advance from a customer who owes nothing at all', () => {
    allowOverpayment(true);
    const customerId = createCustomer(context.db, { name: 'Kofi Mensah' }, ACTOR);

    pay(customerId, 15_000);
    expect(getCustomerBalance(context.db, customerId)).toBe(-15_000);
    assertBooksHealthy('advance');
  });
});

describe('a customer in credit on the balance sheet', () => {
  it('is reported as a liability, not netted inside receivables', () => {
    allowOverpayment(true);
    const owing = createCustomer(context.db, { name: 'Owes Money' }, ACTOR);
    const credited = createCustomer(context.db, { name: 'In Credit' }, ACTOR);

    sellOnCredit(owing);
    sellOnCredit(credited);
    pay(credited, 50_000);

    const sheet = getBalanceSheet(context.db, TODAY);

    // Netting these would report 10,000 owed and no liability at all,
    // understating both what customers owe and what is held for them.
    expect(sheet.receivables).toBe(30_000);
    expect(sheet.customerCredits).toBe(20_000);
    expect(sheet.balances).toBe(true);
  });

  it('still sums to the control account, so nothing is invented', () => {
    allowOverpayment(true);
    const owing = createCustomer(context.db, { name: 'Owes Money' }, ACTOR);
    const credited = createCustomer(context.db, { name: 'In Credit' }, ACTOR);
    sellOnCredit(owing);
    sellOnCredit(credited);
    pay(credited, 50_000);

    const split = getReceivablesSplit(context.db);
    expect(split.net).toBe(getAccountBalanceByCode(context.db, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE));
    expect(split.owed - split.inCredit).toBe(split.net);
    expect(split.creditCount).toBe(1);
  });

  it('reports nothing extra when nobody is in credit', () => {
    const customerId = createCustomer(context.db, { name: 'Ama Serwaa' }, ACTOR);
    sellOnCredit(customerId);

    const sheet = getBalanceSheet(context.db, TODAY);
    expect(sheet.customerCredits).toBe(0);
    expect(sheet.receivables).toBe(30_000);
  });
});
