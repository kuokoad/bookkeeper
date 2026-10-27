import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import {
  auditLogs,
  businessSettings,
  journalEntries,
  paymentAccounts,
  productBatches,
  sales,
} from '@/db/schema';
import { writeTransaction } from '@/db/transaction';
import { createProduct } from '@/services/catalog.service';
import { recordStockMovement } from '@/services/inventory.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { minor } from '@/domain/money';
import { fromUnits } from '@/domain/quantity';
import type { PermissionMap } from '@/lib/auth/permissions';

/**
 * Recording a sale on an earlier day, through the till's own action.
 *
 * A backdated sale leaves the books in perfect order, so nothing downstream
 * would ever notice one that should not have been allowed. These go through
 * the action rather than the service because the action is where the right is
 * read and where "today" comes from: the server's clock, never the browser's.
 */

const database = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@/db/client', () => ({
  get db() {
    return database.current;
  },
}));

/** Who is at the till. Swapped per test. */
const signedIn = vi.hoisted(() => ({
  current: { role: 'OWNER', permissions: {} } as { role: string; permissions: PermissionMap },
}));
vi.mock('@/lib/auth/current-user', () => ({
  requirePermission: async () => ({ id: 1, username: 'kwame', ...signedIn.current }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { createSaleAction } = await import('@/actions/sale.actions');

const TODAY = '2026-08-16';
const ACTOR = { id: 1, username: 'kwame' };

/** A shop assistant: may ring sales up, may not set prices or backdate. */
const CASHIER = {
  role: 'STAFF',
  permissions: { sales: { canView: true, canCreate: true, canEdit: false, canVoid: false } },
};
/** A staff member trusted with `sales:edit` — the shop's manager. */
const MANAGER = {
  role: 'STAFF',
  permissions: { sales: { canView: true, canCreate: true, canEdit: true, canVoid: false } },
};

let context: TestDatabase;
let cash = 0;
let milo = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 7, 16, 10, 30));

  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  database.current = context.db;
  signedIn.current = { role: 'OWNER', permissions: {} };

  cash = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;
  milo = createProduct(
    context.db,
    { name: 'Milo 400g', costPrice: minor(500), sellingPrice: minor(800), unit: 'pcs' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: '2026-08-01',
      reason: 'OPENING_STOCK',
      items: [{ productId: milo, direction: 'IN', qty: fromUnits(10), totalCost: minor(5_000) }],
    },
    ACTOR,
  );
});

afterEach(() => {
  context.cleanup();
  vi.useRealTimers();
});

let carts = 0;

/**
 * One Milo, paid in cash. `businessDate` is the day somebody picked on the
 * till; leave it out for a sale nobody re-dated, which is how the till sends
 * every ordinary sale.
 */
function sellOn(businessDate?: string, productId = milo) {
  const form = new FormData();
  form.set(
    'cart',
    JSON.stringify({
      clientRef: `test-cart-${carts++}`,
      ...(businessDate !== undefined ? { businessDate } : {}),
      customerId: null,
      items: [{ productId, qty: '1', unitPrice: '8.00' }],
      tenders: [{ paymentAccountId: cash, amount: '8.00' }],
    }),
  );
  return createSaleAction({}, form);
}

const salesOnRecord = () => context.db.select().from(sales).all();

describe('a sale dated today', () => {
  it('goes through for a cashier', async () => {
    signedIn.current = CASHIER;

    const state = await sellOn(TODAY);

    expect(state.error).toBeUndefined();
    expect(salesOnRecord().map((sale) => sale.businessDate)).toEqual([TODAY]);
  });
});

describe('a sale dated on an earlier day', () => {
  it('is refused for a cashier, and nothing is recorded', async () => {
    signedIn.current = CASHIER;

    const state = await sellOn('2026-08-14');

    expect(state.error).toMatch(/only an owner or manager/i);
    expect(salesOnRecord()).toHaveLength(0);
  });

  it('lands on the chosen day in the books when a manager records it', async () => {
    signedIn.current = MANAGER;

    const state = await sellOn('2026-08-14');

    expect(state.error).toBeUndefined();
    const [sale] = salesOnRecord();
    expect(sale?.businessDate).toBe('2026-08-14');
    expect(sale?.totalMinor).toBe(800);

    // The money is in the period the sale happened in, not the one it was typed in.
    const entry = context.db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, sale!.journalEntryId!))
      .get();
    expect(entry?.entryDate).toBe('2026-08-14');
  });

  it('goes through for the owner', async () => {
    const state = await sellOn('2026-08-14');

    expect(state.error).toBeUndefined();
    expect(salesOnRecord().map((sale) => sale.businessDate)).toEqual(['2026-08-14']);
  });

  it('is refused inside the books lock, even for the owner', async () => {
    context.db
      .update(businessSettings)
      .set({ booksLockedBefore: '2026-08-14' })
      .where(eq(businessSettings.id, 1))
      .run();

    const onLockDay = await sellOn('2026-08-14');
    expect(onLockDay.error).toMatch(/books are closed/i);
    expect(salesOnRecord()).toHaveLength(0);

    // The day after the lock is open.
    const dayAfter = await sellOn('2026-08-15');
    expect(dayAfter.error).toBeUndefined();
    expect(salesOnRecord().map((sale) => sale.businessDate)).toEqual(['2026-08-15']);
  });
});

describe('a sale dated in the future', () => {
  it('is refused, even for the owner', async () => {
    const state = await sellOn('2026-08-17');

    expect(state.error).toMatch(/future/i);
    expect(salesOnRecord()).toHaveLength(0);
  });
});

describe('a till left open overnight', () => {
  // The till page was loaded yesterday and never reloaded. It sends no date
  // for an ordinary sale, so the server's day is the one that counts.
  it('records a cashier’s sale on the day it is rung up', async () => {
    signedIn.current = CASHIER;
    vi.setSystemTime(new Date(2026, 7, 17, 8, 15));

    const state = await sellOn();

    expect(state.error).toBeUndefined();
    expect(salesOnRecord().map((sale) => sale.businessDate)).toEqual(['2026-08-17']);
  });

  it('records an owner’s sale on the day it is rung up, not the day the page opened', async () => {
    vi.setSystemTime(new Date(2026, 7, 17, 8, 15));

    await sellOn();

    expect(salesOnRecord().map((sale) => sale.businessDate)).toEqual(['2026-08-17']);
  });
});

describe('backdating and expired stock', () => {
  /** A product whose only stock is a crate that expired yesterday. */
  function expiredCrate(): number {
    const id = createProduct(
      context.db,
      { name: 'Fresh Milk 1L', costPrice: minor(500), sellingPrice: minor(800), unit: 'pcs' },
      ACTOR,
    );
    writeTransaction(context.db, (tx) =>
      recordStockMovement(tx, {
        productId: id,
        direction: 'IN',
        qty: fromUnits(5),
        totalCost: minor(2_500),
        movementType: 'PURCHASE',
        sourceType: 'TEST',
        businessDate: '2026-08-01',
        occurredAt: new Date(2026, 7, 1, 8, 0),
        batch: { kind: 'NEW', expiryDate: '2026-08-15' },
      }),
    );
    return id;
  }

  it('still stops a manager without the right to sell expired stock', async () => {
    const milk = expiredCrate();
    signedIn.current = MANAGER;

    // Dated before the crate expired, it would look like good stock.
    const state = await sellOn('2026-08-14', milk);

    expect(state.expired).toBeDefined();
    expect(state.expired?.mayOverride).toBe(false);
    expect(salesOnRecord()).toHaveLength(0);
  });
});

describe('the audit trail', () => {
  it('says when a sale was put on an earlier day', async () => {
    await sellOn('2026-08-14');

    const [sale] = salesOnRecord();
    const entry = context.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, String(sale!.id)))
      .all()
      .find((row) => row.entityType === 'sale' && row.action === 'CREATE');
    expect(entry?.summary).toMatch(/dated 14 Aug 2026/);
    expect(JSON.parse(String(entry?.metadata)).businessDate).toBe('2026-08-14');
  });

  it('says nothing extra about an ordinary sale', async () => {
    await sellOn();

    const [sale] = salesOnRecord();
    const entry = context.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, String(sale!.id)))
      .all()
      .find((row) => row.entityType === 'sale' && row.action === 'CREATE');
    expect(entry?.summary).not.toMatch(/dated/);
  });
});

describe('backdating and later deliveries', () => {
  it('takes stock that was on the shelf that day, not a delivery that came after', async () => {
    // 10 Milo arrived on 1 August (beforeEach). Five more, dated, arrive on
    // the 15th and expire first, so an ordinary pick would reach for them.
    writeTransaction(context.db, (tx) =>
      recordStockMovement(tx, {
        productId: milo,
        direction: 'IN',
        qty: fromUnits(5),
        totalCost: minor(2_500),
        movementType: 'PURCHASE',
        sourceType: 'TEST',
        businessDate: '2026-08-15',
        occurredAt: new Date(2026, 7, 15, 8, 0),
        batch: { kind: 'NEW', expiryDate: '2026-12-31' },
      }),
    );

    await sellOn('2026-08-14');

    const later = context.db
      .select()
      .from(productBatches)
      .all()
      .find((batch) => batch.productId === milo && batch.receivedDate === '2026-08-15');
    expect(later?.qtyMilli).toBe(5_000);
  });
});
