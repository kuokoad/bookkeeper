import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { auditLogs, paymentAccounts, sales } from '@/db/schema';
import {
  assertPeriodOpen,
  isLockRelaxation,
  isPeriodOpen,
  PeriodLockedError,
} from '@/domain/accounting/period-lock';
import { getLockStatus, setBooksLock } from '@/services/period-lock.service';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale, voidSale } from '@/services/sale.service';
import { createSupplier } from '@/services/supplier.service';
import { createPurchase } from '@/services/purchase.service';
import { recordExpense } from '@/services/cashbook.service';
import { listExpenseCategories } from '@/services/payment-account.service';
import { getTrialBalance } from '@/services/reporting/balances.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;

function makeStockedProduct(name = 'Milo') {
  const id = createProduct(
    context.db,
    { name, costPrice: m(500), sellingPrice: m(1_000) },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: '2026-06-01',
      reason: 'OPENING_STOCK',
      items: [{ productId: id, direction: 'IN', qty: u(100), totalCost: m(50_000) }],
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
  CASH = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;
});

afterEach(() => {
  context.cleanup();
});

describe('the rule itself', () => {
  it('is inclusive of the lock date', () => {
    // "Closed up to 31 July" must close 31 July itself.
    expect(isPeriodOpen('2026-07-31', '2026-07-31')).toBe(false);
    expect(isPeriodOpen('2026-08-01', '2026-07-31')).toBe(true);
    expect(isPeriodOpen('2026-07-30', '2026-07-31')).toBe(false);
  });

  it('allows everything when nothing is locked', () => {
    expect(isPeriodOpen('1999-01-01', null)).toBe(true);
    expect(() => assertPeriodOpen('1999-01-01', null)).not.toThrow();
  });

  it('explains itself in language a shop owner can act on', () => {
    try {
      assertPeriodOpen('2026-07-15', '2026-07-31');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PeriodLockedError);
      const message = (error as PeriodLockedError).userMessage;
      expect(message).toContain('31 Jul 2026');
      expect(message).toContain('15 Jul 2026');
      expect(message).toContain('ask the owner');
    }
  });

  it('recognises moving the lock backward as reopening', () => {
    expect(isLockRelaxation('2026-07-31', '2026-08-31')).toBe(false); // forward
    expect(isLockRelaxation('2026-07-31', '2026-06-30')).toBe(true); // backward
    expect(isLockRelaxation('2026-07-31', null)).toBe(true); // removed
    expect(isLockRelaxation(null, '2026-07-31')).toBe(false); // first lock
  });
});

describe('enforcement', () => {
  beforeEach(() => {
    makeStockedProduct();
    setBooksLock(context.db, '2026-07-31', ACTOR);
  });

  function productId(): number {
    return context.db.select().from(sales).all().length >= 0
      ? (context.connection.prepare('SELECT id FROM products LIMIT 1').get() as { id: number }).id
      : 0;
  }

  it('refuses a sale dated inside the closed period', () => {
    expect(() =>
      createSale(
        context.db,
        {
          businessDate: '2026-07-15',
          items: [{ productId: productId(), qty: u(1) }],
          tenders: [{ paymentAccountId: CASH, amount: m(1_000) }],
        },
        ACTOR,
      ),
    ).toThrow(PeriodLockedError);
  });

  it('allows a sale dated after the lock', () => {
    expect(() =>
      createSale(
        context.db,
        {
          businessDate: '2026-08-01',
          items: [{ productId: productId(), qty: u(1) }],
          tenders: [{ paymentAccountId: CASH, amount: m(1_000) }],
        },
        ACTOR,
      ),
    ).not.toThrow();
  });

  it('refuses a back-dated purchase', () => {
    const supplierId = createSupplier(context.db, { name: 'Depot' }, ACTOR);
    expect(() =>
      createPurchase(
        context.db,
        {
          supplierId,
          businessDate: '2026-07-01',
          items: [{ productId: productId(), qty: u(1), unitCost: m(500) }],
          tenders: [],
        },
        ACTOR,
      ),
    ).toThrow(PeriodLockedError);
  });

  it('refuses a back-dated expense', () => {
    expect(() =>
      recordExpense(
        context.db,
        {
          businessDate: '2026-07-20',
          categoryAccountId: listExpenseCategories(context.db).find((c) => c.name === 'Rent')!.id,
          description: 'Rent',
          amount: m(5_000),
          paymentAccountId: CASH,
        },
        ACTOR,
      ),
    ).toThrow(PeriodLockedError);
  });

  it('refuses a back-dated stock adjustment', () => {
    expect(() =>
      createStockAdjustment(
        context.db,
        {
          businessDate: '2026-07-10',
          reason: 'DAMAGED',
          items: [{ productId: productId(), direction: 'OUT', qty: u(1) }],
        },
        ACTOR,
      ),
    ).toThrow(PeriodLockedError);
  });

  it('leaves nothing behind when a locked transaction is refused', () => {
    const before = context.db.select().from(sales).all().length;
    const trialBefore = getTrialBalance(context.db);

    expect(() =>
      createSale(
        context.db,
        {
          businessDate: '2026-07-15',
          items: [{ productId: productId(), qty: u(5) }],
          tenders: [{ paymentAccountId: CASH, amount: m(5_000) }],
        },
        ACTOR,
      ),
    ).toThrow(PeriodLockedError);

    expect(context.db.select().from(sales).all().length).toBe(before);
    expect(getTrialBalance(context.db).totalDebit).toBe(trialBefore.totalDebit);
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });

  /**
   * The point of the lock is that history cannot be quietly rewritten — NOT
   * that mistakes become uncorrectable. A void posts a current-dated reversal,
   * which stays visible in the books, and must still be allowed.
   */
  it('still allows a locked transaction to be corrected by a dated reversal', () => {
    setBooksLock(context.db, null, ACTOR);

    const sale = createSale(
      context.db,
      {
        businessDate: '2026-07-15',
        items: [{ productId: productId(), qty: u(2) }],
        tenders: [{ paymentAccountId: CASH, amount: m(2_000) }],
      },
      ACTOR,
    );

    setBooksLock(context.db, '2026-07-31', ACTOR);

    // The reversal is dated today, which is after the lock, so it goes through.
    expect(() => voidSale(context.db, sale.saleId, 'Entered in error', ACTOR)).not.toThrow();

    const original = context.db.select().from(sales).where(eq(sales.id, sale.saleId)).get();
    expect(original?.status).toBe('VOIDED');
    // The original record is untouched — its date still says July.
    expect(original?.businessDate).toBe('2026-07-15');
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });
});

describe('managing the lock', () => {
  it('reports what is locked', () => {
    makeStockedProduct();
    expect(getLockStatus(context.db).lockedBefore).toBeNull();

    setBooksLock(context.db, '2026-07-31', ACTOR);

    const status = getLockStatus(context.db);
    expect(status.lockedBefore).toBe('2026-07-31');
    // The opening stock entry from June is inside the locked period.
    expect(status.entriesLocked).toBeGreaterThan(0);
  });

  it('records closing the books in the audit log', () => {
    setBooksLock(context.db, '2026-07-31', ACTOR);

    const entry = context.db
      .select()
      .from(auditLogs)
      .all()
      .find((row) => row.entityType === 'books_lock');

    expect(entry?.action).toBe('SETTINGS_CHANGE');
    expect(entry?.summary).toContain('Closed the books up to 2026-07-31');
    expect(entry?.username).toBe('kwame');
  });

  it('records REOPENING distinctly, because that is the risky direction', () => {
    setBooksLock(context.db, '2026-07-31', ACTOR);
    setBooksLock(context.db, '2026-06-30', ACTOR);

    const entries = context.db
      .select()
      .from(auditLogs)
      .all()
      .filter((row) => row.entityType === 'books_lock');

    const reopening = entries.find((row) => row.summary.includes('REOPENED'));
    expect(reopening).toBeDefined();
    expect(reopening?.summary).toContain('2026-07-31');
    expect(reopening?.summary).toContain('2026-06-30');
    expect(JSON.parse(reopening?.metadata ?? '{}').reopened).toBe(true);
  });

  it('treats removing the lock as a reopening too', () => {
    setBooksLock(context.db, '2026-07-31', ACTOR);
    setBooksLock(context.db, null, ACTOR);

    const removal = context.db
      .select()
      .from(auditLogs)
      .all()
      .filter((row) => row.entityType === 'books_lock')
      .find((row) => row.summary.includes('REOPENED'));

    expect(removal).toBeDefined();
    expect(getLockStatus(context.db).lockedBefore).toBeNull();
  });

  it('does nothing, and logs nothing, when the date is unchanged', () => {
    setBooksLock(context.db, '2026-07-31', ACTOR);
    const before = context.db
      .select()
      .from(auditLogs)
      .all()
      .filter((row) => row.entityType === 'books_lock').length;

    setBooksLock(context.db, '2026-07-31', ACTOR);

    const after = context.db
      .select()
      .from(auditLogs)
      .all()
      .filter((row) => row.entityType === 'books_lock').length;
    expect(after).toBe(before);
  });

  it('rejects a malformed date', () => {
    expect(() => setBooksLock(context.db, '31/07/2026', ACTOR)).toThrow();
  });
});
