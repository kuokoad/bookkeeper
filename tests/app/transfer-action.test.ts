import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { accountTransfers, businessSettings, paymentAccounts } from '@/db/schema';

/**
 * The transfer form, through its action: what the person at the screen is
 * told, and who may record one at all.
 */

const database = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@/db/client', () => ({
  get db() {
    return database.current;
  },
}));
// Modules the signed-in user may NOT act on; empty means everything is allowed.
const denied = vi.hoisted(() => new Set<string>());
vi.mock('@/lib/auth/current-user', async () => {
  const { ForbiddenError } = await import('@/domain/errors');
  return {
    requirePermission: async (module: string, action: string) => {
      if (denied.has(module)) throw new ForbiddenError(`${action} on ${module}`);
      return { id: 1, username: 'kwame' };
    },
  };
});
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));

const { recordTransferAction, voidTransferAction } = await import('@/actions/cashbook.actions');
const { ForbiddenError } = await import('@/domain/errors');

let context: TestDatabase;
let cash = 0;
let bank = 0;

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  database.current = context.db;
  denied.clear();

  const accounts = context.db.select().from(paymentAccounts).all();
  cash = accounts.find((a) => a.kind === 'CASH')!.id;
  bank = accounts.find((a) => a.kind === 'BANK')!.id;
});
afterEach(() => context.cleanup());

function post(fields: Record<string, string | number>) {
  const form = new FormData();
  const values = {
    businessDate: '2026-08-10',
    fromAccountId: cash,
    toAccountId: bank,
    amount: '600.00',
    ...fields,
  };
  for (const [key, value] of Object.entries(values)) form.set(key, String(value));
  return recordTransferAction({}, form);
}

const transfersOnRecord = () => context.db.select().from(accountTransfers).all();

describe('the transfer form', () => {
  it('records the transfer and says so', async () => {
    const state = await post({ reference: 'Slip 4471' });

    expect(state.success).toMatch(/TRF-00001 recorded/);
    const [row] = transfersOnRecord();
    expect(row?.amountMinor).toBe(60_000);
    expect(row?.reference).toBe('Slip 4471');
  });

  it('puts the same-account mistake on the To field, and records nothing', async () => {
    const state = await post({ toAccountId: cash });

    expect(state.fieldErrors?.['toAccountId']).toMatch(/different account/i);
    expect(transfersOnRecord()).toHaveLength(0);
  });

  it('explains a date inside the books lock in words, and records nothing', async () => {
    context.db
      .update(businessSettings)
      .set({ booksLockedBefore: '2026-08-15' })
      .where(eq(businessSettings.id, 1))
      .run();

    const state = await post({ businessDate: '2026-08-12' });

    expect(state.error).toMatch(/books are closed up to 15 Aug 2026/i);
    expect(transfersOnRecord()).toHaveLength(0);
  });

  it('refuses an amount it cannot read', async () => {
    const state = await post({ amount: 'six hundred' });

    expect(state.fieldErrors?.['amount']).toBeDefined();
    expect(transfersOnRecord()).toHaveLength(0);
  });

  it('is refused to someone without the right to record account movements', async () => {
    denied.add('accounts');

    await expect(post({})).rejects.toThrow(ForbiddenError);
    expect(transfersOnRecord()).toHaveLength(0);
  });
});

describe('voiding from the Transfers page', () => {
  /** Record one transfer and return its id. */
  async function recorded(): Promise<number> {
    await post({});
    return transfersOnRecord()[0]!.id;
  }

  function voidIt(id: number, reason: string, returnTo = '') {
    const form = new FormData();
    form.set('reason', reason);
    form.set('returnTo', returnTo);
    return voidTransferAction(id, {}, form);
  }

  it('voids it and goes back to the page the row was on', async () => {
    const id = await recorded();

    await expect(voidIt(id, 'Wrong amount', 'page=2')).rejects.toThrow(
      'REDIRECT /accounts/transfers?page=2&voided=1',
    );
    expect(transfersOnRecord()[0]?.status).toBe('VOIDED');
  });

  it('asks for a reason on the reason box, and leaves the transfer alone', async () => {
    const id = await recorded();

    const state = await voidIt(id, 'no');

    expect(state.fieldErrors?.['reason']).toMatch(/reason/i);
    expect(transfersOnRecord()[0]?.status).toBe('POSTED');
  });

  it('is refused to someone without the right to void, and leaves the transfer alone', async () => {
    const id = await recorded();
    denied.add('accounts');

    await expect(voidIt(id, 'Wrong amount')).rejects.toThrow(ForbiddenError);
    expect(transfersOnRecord()[0]?.status).toBe('POSTED');
  });
});
