import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { auditLogs, paymentAccounts, reconciliations } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale } from '@/services/sale.service';
import { recordOwnerCapital } from '@/services/cashbook.service';
import {
  createReconciliation,
  getReconciliationContext,
  getReconciliationOverview,
  listReconciliations,
  voidReconciliation,
} from '@/services/reconciliation.service';
import { getPaymentAccountBalance } from '@/services/payment-account.service';
import { getAccountBalanceByCode, getTrialBalance } from '@/services/reporting/balances.service';
import { getProfitAndLoss } from '@/services/reporting/financial.service';
import { setBooksLock } from '@/services/period-lock.service';
import { PeriodLockedError } from '@/domain/accounting/period-lock';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import { ConflictError, ValidationError } from '@/domain/errors';

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-17';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;
let MOMO = 0;

/** Put a known amount of real money into an account. */
function fund(accountId: number, amount: number, date = '2026-08-01') {
  recordOwnerCapital(
    context.db,
    { businessDate: date, paymentAccountId: accountId, amount: m(amount) },
    ACTOR,
  );
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  const rows = context.db.select().from(paymentAccounts).all();
  CASH = rows.find((a) => a.kind === 'CASH')!.id;
  MOMO = rows.find((a) => a.kind === 'MOBILE_MONEY')!.id;
});

afterEach(() => {
  context.cleanup();
});

describe('what the books expect', () => {
  it('reports the balance as at the day being counted, not today', () => {
    fund(CASH, 100_000, '2026-08-01');
    fund(CASH, 50_000, '2026-08-10');

    expect(getReconciliationContext(context.db, CASH, '2026-08-05').expected).toBe(100_000);
    expect(getReconciliationContext(context.db, CASH, '2026-08-17').expected).toBe(150_000);
  });

  it('has no previous count to begin with', () => {
    fund(CASH, 100_000);
    expect(getReconciliationContext(context.db, CASH, TODAY).lastReconciliation).toBeNull();
  });

  it('remembers the previous count', () => {
    fund(CASH, 100_000);
    createReconciliation(
      context.db,
      { paymentAccountId: CASH, businessDate: '2026-08-10', actual: m(100_000), adjust: false },
      ACTOR,
    );

    const previous = getReconciliationContext(context.db, CASH, TODAY).lastReconciliation;
    expect(previous?.businessDate).toBe('2026-08-10');
    expect(previous?.actual).toBe(100_000);
    expect(previous?.difference).toBe(0);
  });
});

describe('a count that agrees', () => {
  it('records the count and posts nothing', () => {
    fund(CASH, 245_000);

    const result = createReconciliation(
      context.db,
      { paymentAccountId: CASH, businessDate: TODAY, actual: m(245_000), adjust: true },
      ACTOR,
    );

    expect(result.expected).toBe(245_000);
    expect(result.difference).toBe(0);
    expect(result.adjusted).toBe(false);
    expect(result.journalEntryId).toBeNull();

    // Nothing moved; there was nothing to correct.
    expect(getPaymentAccountBalance(context.db, CASH)).toBe(245_000);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.CASH_OVER_SHORT)).toBe(0);
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });

  it('does not require an explanation when there is no difference', () => {
    fund(CASH, 100_000);
    expect(() =>
      createReconciliation(
        context.db,
        { paymentAccountId: CASH, businessDate: TODAY, actual: m(100_000), adjust: true },
        ACTOR,
      ),
    ).not.toThrow();
  });
});

describe('a shortage', () => {
  it('handles the brief’s worked example: books 2,450 but only 2,400 counted', () => {
    fund(CASH, 245_000);

    const result = createReconciliation(
      context.db,
      {
        paymentAccountId: CASH,
        businessDate: TODAY,
        actual: m(240_000),
        explanation: 'Short after the market run — possibly wrong change given',
        adjust: true,
      },
      ACTOR,
    );

    expect(result.expected).toBe(245_000);
    expect(result.actual).toBe(240_000);
    expect(result.difference).toBe(-5_000); // GHS -50.00
    expect(result.adjusted).toBe(true);

    // The books now agree with the drawer...
    expect(getPaymentAccountBalance(context.db, CASH)).toBe(240_000);
    // ...and the missing money is VISIBLE as a cost, not hidden.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.CASH_OVER_SHORT)).toBe(5_000);
    expect(getTrialBalance(context.db).balanced).toBe(true);

    // It reduces profit, which is the honest treatment.
    const pl = getProfitAndLoss(context.db, { from: '2026-08-01', to: '2026-08-31' });
    expect(pl.expenses.some((line) => line.name === 'Cash Over / Short')).toBe(true);
    expect(pl.totalExpenses).toBe(5_000);
  });

  it('can be recorded WITHOUT adjusting, leaving the money to be looked for', () => {
    fund(CASH, 245_000);

    const result = createReconciliation(
      context.db,
      {
        paymentAccountId: CASH,
        businessDate: TODAY,
        actual: m(240_000),
        explanation: 'Will check the till roll tomorrow',
        adjust: false,
      },
      ACTOR,
    );

    expect(result.difference).toBe(-5_000);
    expect(result.adjusted).toBe(false);
    expect(result.journalEntryId).toBeNull();

    // The books are UNCHANGED — the discrepancy is recorded, not absorbed.
    expect(getPaymentAccountBalance(context.db, CASH)).toBe(245_000);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.CASH_OVER_SHORT)).toBe(0);

    // And it shows as still unresolved.
    const overview = getReconciliationOverview(context.db);
    expect(overview.find((row) => row.paymentAccountId === CASH)?.unresolvedDifference).toBe(-5_000);
  });

  it('refuses a difference with no explanation', () => {
    fund(CASH, 245_000);
    expect(() =>
      createReconciliation(
        context.db,
        { paymentAccountId: CASH, businessDate: TODAY, actual: m(240_000), adjust: true },
        ACTOR,
      ),
    ).toThrow(/explain what you think happened/i);

    // Nothing was written.
    expect(context.db.select().from(reconciliations).all()).toHaveLength(0);
  });
});

describe('a surplus', () => {
  it('increases the account and records a gain', () => {
    fund(MOMO, 100_000);

    const result = createReconciliation(
      context.db,
      {
        paymentAccountId: MOMO,
        businessDate: TODAY,
        actual: m(102_500),
        explanation: 'A MoMo deposit was not recorded at the time',
        adjust: true,
      },
      ACTOR,
    );

    expect(result.difference).toBe(2_500);
    expect(getPaymentAccountBalance(context.db, MOMO)).toBe(102_500);
    // A surplus is a negative cost — it increases profit.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.CASH_OVER_SHORT)).toBe(-2_500);
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });
});

describe('history is never rewritten', () => {
  it('leaves every original transaction exactly as it was', () => {
    const productId = createProduct(
      context.db,
      { name: 'Milo', costPrice: m(500), sellingPrice: m(1_000) },
      ACTOR,
    );
    createStockAdjustment(
      context.db,
      {
        businessDate: '2026-08-01',
        reason: 'OPENING_STOCK',
        items: [{ productId, direction: 'IN', qty: u(100), totalCost: m(50_000) }],
      },
      ACTOR,
    );
    const sale = createSale(
      context.db,
      {
        businessDate: '2026-08-05',
        items: [{ productId, qty: u(10) }],
        tenders: [{ paymentAccountId: CASH, amount: m(10_000) }],
      },
      ACTOR,
    );

    const before = context.connection
      .prepare('SELECT total_minor, cogs_minor FROM sales WHERE id = ?')
      .get(sale.saleId);

    createReconciliation(
      context.db,
      {
        paymentAccountId: CASH,
        businessDate: TODAY,
        actual: m(9_500),
        explanation: 'Fifty pesewas short',
        adjust: true,
      },
      ACTOR,
    );

    const after = context.connection
      .prepare('SELECT total_minor, cogs_minor FROM sales WHERE id = ?')
      .get(sale.saleId);

    // The sale is byte-for-byte what it was. The correction is a NEW entry.
    expect(after).toEqual(before);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.CASH_OVER_SHORT)).toBe(500);
  });

  it('keeps the snapshot of what the books said at the time', () => {
    fund(CASH, 100_000);
    const result = createReconciliation(
      context.db,
      {
        paymentAccountId: CASH,
        businessDate: TODAY,
        actual: m(95_000),
        explanation: 'Short',
        adjust: false,
      },
      ACTOR,
    );

    // More money arrives afterwards.
    fund(CASH, 50_000, TODAY);

    // The count still records what was expected WHEN IT WAS TAKEN.
    const record = context.db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.id, result.reconciliationId))
      .get();
    expect(record?.expectedMinor).toBe(100_000);
    expect(record?.actualMinor).toBe(95_000);
    expect(record?.differenceMinor).toBe(-5_000);
  });
});

describe('voiding a count', () => {
  it('reverses the adjustment and keeps the record', () => {
    fund(CASH, 245_000);
    const result = createReconciliation(
      context.db,
      {
        paymentAccountId: CASH,
        businessDate: TODAY,
        actual: m(240_000),
        explanation: 'Miscounted',
        adjust: true,
      },
      ACTOR,
    );

    expect(getPaymentAccountBalance(context.db, CASH)).toBe(240_000);

    voidReconciliation(context.db, result.reconciliationId, 'The float was in the other drawer', ACTOR);

    // The books go back to what they said before.
    expect(getPaymentAccountBalance(context.db, CASH)).toBe(245_000);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.CASH_OVER_SHORT)).toBe(0);
    expect(getTrialBalance(context.db).balanced).toBe(true);

    // But the count itself is still on record.
    const record = context.db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.id, result.reconciliationId))
      .get();
    expect(record?.status).toBe('VOIDED');
    expect(record?.actualMinor).toBe(240_000);
    expect(record?.voidReason).toBe('The float was in the other drawer');
  });

  it('refuses to void twice or without a reason', () => {
    fund(CASH, 100_000);
    const result = createReconciliation(
      context.db,
      { paymentAccountId: CASH, businessDate: TODAY, actual: m(100_000), adjust: true },
      ACTOR,
    );

    expect(() => voidReconciliation(context.db, result.reconciliationId, 'x', ACTOR)).toThrow(
      ValidationError,
    );
    voidReconciliation(context.db, result.reconciliationId, 'Wrong account', ACTOR);
    expect(() => voidReconciliation(context.db, result.reconciliationId, 'Again', ACTOR)).toThrow(
      ConflictError,
    );
  });
});

describe('interaction with the books lock', () => {
  it('refuses an adjusting count dated inside a closed period', () => {
    fund(CASH, 100_000, '2026-07-01');
    setBooksLock(context.db, '2026-07-31', ACTOR);

    expect(() =>
      createReconciliation(
        context.db,
        {
          paymentAccountId: CASH,
          businessDate: '2026-07-15',
          actual: m(95_000),
          explanation: 'Short',
          adjust: true,
        },
        ACTOR,
      ),
    ).toThrow(PeriodLockedError);

    // Nothing partial survived.
    expect(context.db.select().from(reconciliations).all()).toHaveLength(0);
  });

  it('allows counting an open period after the lock', () => {
    fund(CASH, 100_000, '2026-07-01');
    setBooksLock(context.db, '2026-07-31', ACTOR);

    expect(() =>
      createReconciliation(
        context.db,
        {
          paymentAccountId: CASH,
          businessDate: '2026-08-05',
          actual: m(95_000),
          explanation: 'Short',
          adjust: true,
        },
        ACTOR,
      ),
    ).not.toThrow();
  });
});

describe('overview and history', () => {
  it('summarises every account', () => {
    fund(CASH, 100_000);
    fund(MOMO, 50_000);

    createReconciliation(
      context.db,
      { paymentAccountId: CASH, businessDate: TODAY, actual: m(100_000), adjust: true },
      ACTOR,
    );

    const overview = getReconciliationOverview(context.db);
    const cash = overview.find((row) => row.paymentAccountId === CASH);
    const momo = overview.find((row) => row.paymentAccountId === MOMO);

    expect(cash?.lastCountedOn).toBe(TODAY);
    expect(cash?.lastDifference).toBe(0);
    expect(cash?.countsRecorded).toBe(1);

    // Never counted.
    expect(momo?.lastCountedOn).toBeNull();
    expect(momo?.countsRecorded).toBe(0);
    expect(momo?.currentBalance).toBe(50_000);
  });

  it('lists counts newest first', () => {
    fund(CASH, 100_000, '2026-08-01');

    createReconciliation(
      context.db,
      { paymentAccountId: CASH, businessDate: '2026-08-10', actual: m(100_000), adjust: true },
      ACTOR,
    );
    createReconciliation(
      context.db,
      { paymentAccountId: CASH, businessDate: '2026-08-15', actual: m(100_000), adjust: true },
      ACTOR,
    );

    const list = listReconciliations(context.db, CASH);
    expect(list).toHaveLength(2);
    expect(list[0]?.businessDate).toBe('2026-08-15');
  });

  it('records the count in the audit log', () => {
    fund(CASH, 245_000);
    createReconciliation(
      context.db,
      {
        paymentAccountId: CASH,
        businessDate: TODAY,
        actual: m(240_000),
        explanation: 'Short by fifty',
        adjust: true,
      },
      ACTOR,
    );

    const entry = context.db
      .select()
      .from(auditLogs)
      .all()
      .find((row) => row.action === 'RECONCILE');

    expect(entry).toBeDefined();
    expect(entry?.summary).toContain('short');
    expect(entry?.username).toBe('kwame');
    const metadata = JSON.parse(entry?.metadata ?? '{}');
    expect(metadata.expectedMinor).toBe(245_000);
    expect(metadata.actualMinor).toBe(240_000);
    expect(metadata.adjusted).toBe(true);
  });
});
