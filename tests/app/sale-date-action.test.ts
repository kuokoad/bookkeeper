import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { businessSettings, journalEntries, paymentAccounts, sales } from '@/db/schema';
import { createProduct } from '@/services/catalog.service';
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

/** One Milo, paid in cash, dated `businessDate`. */
function sellOn(businessDate: string) {
  const form = new FormData();
  form.set(
    'cart',
    JSON.stringify({
      clientRef: `test-cart-${carts++}`,
      businessDate,
      customerId: null,
      items: [{ productId: milo, qty: '1', unitPrice: '8.00' }],
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
