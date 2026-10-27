import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts, sales } from '@/db/schema';
import { createProduct } from '@/services/catalog.service';
import { createQuotation } from '@/services/quotation.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { minor } from '@/domain/money';
import { fromUnits } from '@/domain/quantity';

/**
 * Turning a quote into a sale records the sale on the day it happens.
 *
 * The convert form used to carry the date in a hidden field, and the action
 * took whatever arrived — so anyone allowed to convert a quote could edit that
 * field and put a sale on last week, or next month, without the right the till
 * asks for. The server's day is now the only one used.
 */

const database = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@/db/client', () => ({
  get db() {
    return database.current;
  },
}));
vi.mock('@/lib/auth/current-user', () => ({
  requirePermission: async () => ({ id: 1, username: 'kwame' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));

const { convertQuotationAction } = await import('@/actions/quotation.actions');

const ACTOR = { id: 1, username: 'kwame' };
let context: TestDatabase;
let cash = 0;
let quotationId = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 7, 16, 10, 30));

  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  database.current = context.db;

  cash = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;
  const cement = createProduct(
    context.db,
    { name: 'Cement 50kg', costPrice: minor(6_000), sellingPrice: minor(8_000), unit: 'bag' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: '2026-08-01',
      reason: 'OPENING_STOCK',
      items: [{ productId: cement, direction: 'IN', qty: fromUnits(10), totalCost: minor(60_000) }],
    },
    ACTOR,
  );
  quotationId = createQuotation(
    context.db,
    {
      businessDate: '2026-08-10',
      validUntil: '2026-09-10',
      customerName: 'Kofi Mensah',
      lines: [{ productId: cement, qty: fromUnits(1) }],
    },
    ACTOR,
  ).quotationId;
});

afterEach(() => {
  context.cleanup();
  vi.useRealTimers();
});

function convert(businessDate: string) {
  const form = new FormData();
  form.set('quotationId', String(quotationId));
  form.set('businessDate', businessDate);
  form.set('tenders', JSON.stringify([{ paymentAccountId: cash, amount: '80.00' }]));
  return convertQuotationAction({}, form);
}

describe('converting a quote', () => {
  it('records the sale today, whatever date the form carried', async () => {
    await expect(convert('2026-08-02')).rejects.toThrow(/REDIRECT \/sales\//);

    expect(context.db.select().from(sales).all().map((sale) => sale.businessDate)).toEqual([
      '2026-08-16',
    ]);
  });

  it('cannot put a sale on a day that has not happened yet', async () => {
    await expect(convert('2026-09-01')).rejects.toThrow(/REDIRECT \/sales\//);

    expect(context.db.select().from(sales).all().map((sale) => sale.businessDate)).toEqual([
      '2026-08-16',
    ]);
  });
});
