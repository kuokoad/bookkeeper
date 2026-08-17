import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import {
  countJournalEntries,
  getPaymentAccountBalances,
  getTrialBalance,
} from '@/services/reporting/balances.service';
import { getStockSummary, listProducts } from '@/services/catalog.service';
import { getSalesSummary } from '@/services/sale.service';
import { getTotalReceivables } from '@/services/customer.service';
import { getTotalPayables } from '@/services/supplier.service';
import { getExpensesTotal, getIncomesTotal } from '@/services/cashbook.service';
import { getCurrentUser } from '@/lib/auth/current-user';
import { add, subtract } from '@/domain/money';
import { money, toBusinessDate } from '@/lib/format';
import { Alert } from '@/components/ui/alert';
import { Stat } from '@/components/ui/page';

export const metadata: Metadata = { title: 'Dashboard' };

// Balances are derived from the ledger on every request; never cache them.
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await getCurrentUser();
  const paymentAccounts = getPaymentAccountBalances(db);
  const trialBalance = getTrialBalance(db);
  const entryCount = countJournalEntries(db);
  const stock = getStockSummary(db);
  const lowStockItems = listProducts(db, { lowStockOnly: true });

  const today = toBusinessDate();
  const monthStart = `${today.slice(0, 7)}-01`;
  const todaySales = getSalesSummary(db, today, today);
  const monthSales = getSalesSummary(db, monthStart, today);
  const receivables = getTotalReceivables(db);
  const payables = getTotalPayables(db);

  const todayExpenses = getExpensesTotal(db, today, today);
  const monthExpenses = getExpensesTotal(db, monthStart, today);
  const monthOtherIncome = getIncomesTotal(db, monthStart, today);

  // Net profit: gross profit on sales, plus other income, less running costs.
  const monthNet = subtract(add(monthSales.grossProfit, monthOtherIncome), monthExpenses);

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-content">
          Good day{user ? `, ${user.displayName.split(' ')[0]}` : ''}
        </h1>
        <p className="mt-1 text-sm text-content-muted">
          Here is where your money stands right now.
        </p>
      </header>

      {!trialBalance.balanced && (
        <Alert tone="danger" title="The books do not balance">
          Total debits ({money(trialBalance.totalDebit)}) do not equal total credits (
          {money(trialBalance.totalCredit)}). Difference: {money(trialBalance.difference)}. This
          should never happen — please report it before recording anything else.
        </Alert>
      )}

      <section aria-labelledby="balances-heading">
        <h2 id="balances-heading" className="mb-3 text-sm font-semibold text-content">
          Money accounts
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {paymentAccounts.map((account) => (
            <div
              key={account.id}
              className="rounded-xl border border-line bg-surface-raised p-4"
            >
              <p className="text-sm text-content-muted">{account.name}</p>
              <p className="tabular mt-1 text-xl font-semibold text-content">
                {money(account.balance)}
              </p>
              <p className="mt-1 text-xs text-content-subtle">
                Ledger account {account.glCode}
                {account.provider ? ` · ${account.provider}` : ''}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="trading-heading">
        <h2 id="trading-heading" className="mb-3 text-sm font-semibold text-content">
          Trading
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Today's sales"
            value={money(todaySales.total)}
            hint={`${todaySales.count} sale${todaySales.count === 1 ? '' : 's'}`}
          />
          <Stat
            label="Today's profit"
            value={money(todaySales.grossProfit)}
            hint="Revenue less cost of goods"
            tone={todaySales.grossProfit < 0 ? 'danger' : 'default'}
          />
          <Stat label="This month" value={money(monthSales.total)} hint={`${monthSales.count} sales`} />
          <Stat
            label="Month profit"
            value={money(monthNet)}
            hint="After expenses and other income"
            tone={monthNet < 0 ? 'danger' : 'default'}
          />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Spent today" value={money(todayExpenses)} />
          <Stat label="Spent this month" value={money(monthExpenses)} />
          <Stat label="Other income (month)" value={money(monthOtherIncome)} />
          <Stat
            label="You owe suppliers"
            value={money(payables)}
            tone={payables > 0 ? 'warning' : 'default'}
          />
        </div>
        {receivables > 0 && (
          <p className="mt-3 text-sm text-content-muted">
            Customers owe you{' '}
            <Link href="/customers?owing=1" className="font-medium text-accent hover:underline">
              {money(receivables)}
            </Link>
            .
          </p>
        )}
      </section>

      <section aria-labelledby="stock-heading">
        <h2 id="stock-heading" className="mb-3 text-sm font-semibold text-content">
          Stock
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Stock value"
            value={money(stock.totalStockValue)}
            hint="At weighted average cost"
          />
          <Stat label="Products" value={String(stock.productCount)} />
          <Stat
            label="Low stock"
            value={String(stock.lowStockCount)}
            tone={stock.lowStockCount > 0 ? 'warning' : 'default'}
            hint={stock.lowStockCount > 0 ? 'Time to reorder' : 'Nothing running low'}
          />
          <Stat
            label="Out of stock"
            value={String(stock.outOfStockCount)}
            tone={stock.outOfStockCount > 0 ? 'danger' : 'default'}
          />
        </div>
        {lowStockItems.length > 0 && (
          <p className="mt-3 text-sm text-content-muted">
            Running low:{' '}
            {lowStockItems.slice(0, 5).map((item, index) => (
              <span key={item.id}>
                {index > 0 && ', '}
                <Link href={`/inventory?product=${item.id}`} className="text-accent hover:underline">
                  {item.name}
                </Link>
              </span>
            ))}
            {lowStockItems.length > 5 && ` and ${lowStockItems.length - 5} more`}.{' '}
            <Link href="/products?low=1" className="text-accent hover:underline">
              See all
            </Link>
          </p>
        )}
      </section>

      <section aria-labelledby="integrity-heading">
        <h2 id="integrity-heading" className="mb-3 text-sm font-semibold text-content">
          Books check
        </h2>
        <div className="rounded-xl border border-line bg-surface-raised p-4">
          <dl className="grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-sm text-content-muted">Total debits</dt>
              <dd className="tabular mt-0.5 text-lg font-semibold text-content">
                {money(trialBalance.totalDebit)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-content-muted">Total credits</dt>
              <dd className="tabular mt-0.5 text-lg font-semibold text-content">
                {money(trialBalance.totalCredit)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-content-muted">Status</dt>
              <dd
                className={`mt-0.5 text-lg font-semibold ${
                  trialBalance.balanced ? 'text-success' : 'text-danger'
                }`}
              >
                {trialBalance.balanced ? 'Balanced' : 'Out of balance'}
              </dd>
            </div>
          </dl>
          <p className="mt-4 border-t border-line pt-3 text-xs text-content-subtle">
            {entryCount === 0
              ? 'No transactions recorded yet, so every figure above is genuinely zero — not a placeholder.'
              : `Derived from ${entryCount} journal ${entryCount === 1 ? 'entry' : 'entries'}. Every figure traces back to a real transaction.`}
          </p>
        </div>
      </section>

      <section aria-labelledby="progress-heading">
        <h2 id="progress-heading" className="mb-3 text-sm font-semibold text-content">
          Build progress
        </h2>
        <div className="rounded-xl border border-line bg-surface-raised p-4 text-sm">
          <p className="text-content-muted">
            <strong className="font-medium text-content">Stages 1 and 2 are complete</strong>:
            database and migrations, the double-entry ledger, sign-in and permissions, the audit
            trail, and now products, categories, the stock ledger and stock adjustments.
          </p>
          <p className="mt-2 text-content-muted">
            Sales, purchases, customers, suppliers and reports arrive in later stages. Menu items
            marked &ldquo;Soon&rdquo; are not yet built — they are shown so the shape of the
            finished app is visible, and they do nothing rather than pretending to work.
          </p>
        </div>
      </section>
    </div>
  );
}
