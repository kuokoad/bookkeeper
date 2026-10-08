import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts, sales } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { minor, sum } from '@/domain/money';
import { fromUnits } from '@/domain/quantity';
import { addDays } from '@/domain/business-date';
import { money, toBusinessDate } from '@/lib/format';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { createSale } from '@/services/sale.service';
import {
  createCustomer,
  getTotalReceivables,
} from '@/services/customer.service';
import { recordCustomerPayment } from '@/services/customer-payment.service';
import { getReceivablesAgeing } from '@/services/reporting/ledger.service';
import { getProfitAndLoss } from '@/services/reporting/financial.service';
import {
  getExpensesByDay,
  getExpensesTotal,
  recordExpense,
  voidExpense,
} from '@/services/cashbook.service';
import { listExpenseCategories } from '@/services/payment-account.service';
import { createReconciliation } from '@/services/reconciliation.service';
import { summariseAgeing } from '@/lib/dashboard';
import type { Db } from '@/db/types';
import type { Principal } from '@/lib/auth/permissions';

const state = vi.hoisted(() => ({
  db: undefined as Db | undefined,
  user: null as Principal | null,
}));
vi.mock('@/db/client', () => ({
  get db() {
    return state.db;
  },
}));
vi.mock('@/lib/auth/current-user', () => ({
  getCurrentUser: async () => state.user,
}));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
import DashboardPage from '@/app/(app)/dashboard/page';

let context: TestDatabase;
let cash: number;
let momo: number;
let product: number;
const actor = { id: 1, username: 'owner' };
const today = toBusinessDate();
const period = { from: `${today.slice(0, 7)}-01`, to: today };
const owner: Principal = {
  ...actor,
  displayName: 'Owner',
  role: 'OWNER',
  permissions: {},
};
const html = async (params = {}) =>
  renderToStaticMarkup(
    await DashboardPage({ searchParams: Promise.resolve(params) }),
  );

beforeEach(() => {
  context = createTestDatabase();
  state.db = context.db;
  state.user = owner;
  context.connection
    .prepare(
      'INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)',
    )
    .run(1, 'owner', 'Owner', 'OWNER', 'scrypt$1$2$3$a$b');
  const accounts = context.db.select().from(paymentAccounts).all();
  cash = accounts.find((row) => row.kind === 'CASH')!.id;
  momo = accounts.find((row) => row.kind === 'MOBILE_MONEY')!.id;
  product = createProduct(
    context.db,
    {
      name: 'Dashboard rice',
      costPrice: minor(500),
      sellingPrice: minor(1000),
      unit: 'pcs',
    },
    actor,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: period.from,
      reason: 'OPENING_STOCK',
      items: [
        {
          productId: product,
          direction: 'IN',
          qty: fromUnits(100),
          totalCost: minor(50000),
        },
      ],
    },
    actor,
  );
});
afterEach(() => {
  context.cleanup();
  state.db = undefined;
});

describe('dashboard financial regression', () => {
  it('renders authoritative P&L including shrinkage and adjusted cash differences', async () => {
    createSale(
      context.db,
      {
        businessDate: today,
        items: [{ productId: product, qty: fromUnits(10) }],
        tenders: [{ paymentAccountId: cash, amount: minor(10000) }],
      },
      actor,
    );
    recordExpense(
      context.db,
      {
        businessDate: today,
        categoryAccountId: listExpenseCategories(context.db)[0]!.id,
        paymentAccountId: cash,
        amount: minor(200),
        description: 'Dashboard expense',
      },
      actor,
    );
    createStockAdjustment(
      context.db,
      {
        businessDate: today,
        reason: 'DAMAGED',
        items: [{ productId: product, direction: 'OUT', qty: fromUnits(2) }],
      },
      actor,
    );
    createReconciliation(
      context.db,
      {
        businessDate: today,
        paymentAccountId: cash,
        actual: minor(9700),
        adjust: true,
        explanation: 'Test cash short',
      },
      actor,
    );
    const pl = getProfitAndLoss(context.db, period);
    expect(pl.netProfit).toBe(3700); // 5000 gross - 200 cashbook - 1000 shrinkage - 100 cash short
    const markup = await html();
    const profitCard = markup
      .split('>Net Profit</a>')[1]!
      .split('</section>')[0]!;
    expect(profitCard).toContain(money(pl.netProfit));
    expect(markup).toContain(
      `/reports/profit-and-loss?period=custom&amp;from=${period.from}&amp;to=${period.to}`,
    );
  });
  it('assigns invoices to exactly one bucket, including all overdue boundaries', () => {
    const customerId = createCustomer(
      context.db,
      { name: 'Ageing customer' },
      actor,
    );
    for (const days of [-1, 0, 1, 30, 31, 60, 61, 90, 91]) {
      const sale = createSale(
        context.db,
        {
          businessDate: today,
          customerId,
          items: [{ productId: product, qty: fromUnits(1) }],
          tenders: [],
        },
        actor,
      );
      context.db
        .update(sales)
        .set({ dueDate: addDays(today, -days) })
        .where(eq(sales.id, sale.saleId))
        .run();
    }
    const rows = getReceivablesAgeing(context.db, today);
    expect(rows[0]).toMatchObject({
      current: 2000,
      days1to30: 2000,
      days31to60: 2000,
      days61to90: 2000,
      over90: 1000,
      total: 9000,
    });
    const result = summariseAgeing(rows, getTotalReceivables(context.db));
    expect(result).toMatchObject({
      overdue: 7000,
      notYetDue: 2000,
      unaged: 0,
      reconciles: true,
    });
    expect(result.overdue + result.notYetDue).toBe(
      getTotalReceivables(context.db),
    );
  });
  it('exposes unallocated payments rather than silently assigning due dates', async () => {
    const customerId = createCustomer(
      context.db,
      { name: 'Credit customer' },
      actor,
    );
    context.connection
      .prepare(
        'UPDATE business_settings SET allow_overpayment = 1 WHERE id = 1',
      )
      .run();
    recordCustomerPayment(
      context.db,
      {
        businessDate: today,
        customerId,
        paymentAccountId: cash,
        amount: minor(500),
      },
      actor,
    );
    const result = summariseAgeing(
      getReceivablesAgeing(context.db, today),
      getTotalReceivables(context.db),
    );
    expect(result.overdue + result.notYetDue + result.unaged).toBe(-500);
    expect(result.unaged).toBe(-500);
    expect(await html()).toContain('Outside invoice ageing');
  });
  it('expense trend matches total, includes boundaries and excludes voids', () => {
    const categoryAccountId = listExpenseCategories(context.db)[0]!.id;
    const from = '2026-03-01',
      to = '2026-03-31';
    for (const businessDate of ['2026-02-28', from, to, '2026-04-01']) {
      recordExpense(
        context.db,
        {
          businessDate,
          categoryAccountId,
          paymentAccountId: cash,
          amount: minor(100),
          description: 'Boundary expense',
        },
        actor,
      );
    }
    const voided = recordExpense(
      context.db,
      {
        businessDate: from,
        categoryAccountId,
        paymentAccountId: cash,
        amount: minor(999),
        description: 'Voided expense',
      },
      actor,
    );
    voidExpense(context.db, voided.id, 'Test correction', actor);
    const rows = getExpensesByDay(context.db, from, to);
    expect(rows.map((row) => row.businessDate)).toEqual([from, to]);
    expect(sum(rows.map((row) => row.total))).toBe(
      getExpensesTotal(context.db, from, to),
    );
    expect(getExpensesTotal(context.db, from, to)).toBe(200);
  });
  it('shows opposing reconciliation discrepancies and distinguishes negative balances', async () => {
    for (const [paymentAccountId, actual] of [
      [cash, 100],
      [momo, -100],
    ]) {
      createReconciliation(
        context.db,
        {
          businessDate: today,
          paymentAccountId: paymentAccountId!,
          actual: minor(actual!),
          adjust: false,
          explanation: 'Unresolved test count',
        },
        actor,
      );
    }
    const markup = await html();
    expect(markup.match(/unresolved count difference/g)).toHaveLength(2);
    expect(markup).toContain('GHS 1.00 unresolved count difference');
    expect(markup).toContain('GHS -1.00 unresolved count difference');
    expect(markup).toContain('No count recorded; reconciliation not verified.');
  });
});

describe('dashboard server permissions', () => {
  it('accounts-only access exposes Books Check without report-only links', async () => {
    state.user = {
      ...owner,
      role: 'STAFF',
      permissions: { accounts: { canView: true, canCreate: false, canEdit: false, canVoid: false } },
    };
    const markup = await html();
    expect(markup).toContain('href="/accounting"');
    expect(markup).not.toContain('/reports/');
    expect(markup).not.toContain('Supplier payables');
    expect(markup).not.toContain('Account reconciliation');
  });
  it('negative ledger balances do not become confirmed reconciliation errors', async () => {
    recordExpense(context.db, {
      businessDate: today,
      categoryAccountId: listExpenseCategories(context.db)[0]!.id,
      paymentAccountId: cash,
      amount: minor(100),
      description: 'Negative balance test',
    }, actor);
    const markup = await html();
    expect(markup).toContain('Negative ledger balance.');
    expect(markup).toContain('not a confirmed reconciliation error');
    expect(markup).not.toContain('unresolved count difference');
  });
  it('dashboard reads do not change journal lines or inventory', async () => {
    const lines = context.connection.prepare('SELECT * FROM journal_lines ORDER BY id').all();
    const stock = context.connection.prepare('SELECT * FROM stock_ledger ORDER BY id').all();
    await html();
    expect(context.connection.prepare('SELECT * FROM journal_lines ORDER BY id').all()).toEqual(lines);
    expect(context.connection.prepare('SELECT * FROM stock_ledger ORDER BY id').all()).toEqual(stock);
  });
  it('does not read denied financial data or render denied actions and links', async () => {
    state.user = { ...owner, role: 'STAFF', permissions: {} };
    // A database which throws on access proves gating happens before queries.
    state.db = new Proxy({} as Db, {
      get() {
        throw new Error('denied data read');
      },
    });
    const markup = await html();
    expect(markup).toContain('No dashboard summaries available');
    expect(markup).not.toContain('Net Profit</a>');
    expect(markup).not.toContain('New Sale');
  });
  it('customer-view access does not expose supplier balances or create actions', async () => {
    state.user = {
      ...owner,
      role: 'STAFF',
      permissions: {
        customers: {
          canView: true,
          canCreate: false,
          canEdit: false,
          canVoid: false,
        },
      },
    };
    const markup = await html();
    expect(markup).toContain('Customer receivables');
    expect(markup).not.toContain('Supplier payables');
    expect(markup).not.toContain('Receive Payment');
    expect(markup).not.toContain('/accounting');
  });
  it('preserves independent period links on the rendered dashboard', async () => {
    const markup = await html({ sales: 'week', spend: 'quarter' });
    expect(markup).toContain('/dashboard?sales=month&amp;spend=quarter');
    expect(markup).toContain('/dashboard?sales=week&amp;spend=month');
  });
  it('redirects unauthenticated users before any database reads', async () => {
    state.user = null;
    await expect(html()).rejects.toThrow('redirect:/login');
  });
  it('propagates data read failures instead of rendering zero balances', async () => {
    state.db = new Proxy({} as Db, {
      get() {
        throw new Error('database unavailable');
      },
    });
    await expect(html()).rejects.toThrow('database unavailable');
  });
});
