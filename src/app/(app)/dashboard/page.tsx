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
import { getSalesByDay } from '@/services/reporting/operations.service';
import { getMoneyByMonth } from '@/services/reporting/money-trend';
import { getReceivablesAgeing } from '@/services/reporting/ledger.service';
import { getTotalReceivables } from '@/services/customer.service';
import { getTotalPayables } from '@/services/supplier.service';
import { getExpensesByCategory, getExpensesTotal, getIncomesTotal } from '@/services/cashbook.service';
import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { add, subtract, sum, type Minor } from '@/domain/money';
import { money, toBusinessDate } from '@/lib/format';
import { Alert } from '@/components/ui/alert';
import { Donut, PairedBars, SplitBar, TrendLine } from '@/components/ui/chart';
import { Clock } from '@/components/shared/clock';
import { formatClockDate, formatClockTime } from '@/lib/clock-format';

export const metadata: Metadata = { title: 'Dashboard' };

// Balances are derived from the ledger on every request; never cache them.
export const dynamic = 'force-dynamic';

/**
 * The screen the owner opens most.
 *
 * Laid out as cards, each answering one question with a headline figure and a
 * picture beneath it. The figures are text — a chart is never the only way a
 * number is available, because a shape cannot be read aloud, printed reliably,
 * or checked against a receipt.
 *
 * Nothing here computes money. Every amount arrives already totalled by a
 * service; the charts receive values for scale and a label already formatted.
 */

const RANGES = {
  week: { days: 7, label: 'Last 7 days' },
  month: { days: 30, label: 'Last 30 days' },
  quarter: { days: 90, label: 'Last 90 days' },
} as const;

type RangeKey = keyof typeof RANGES;

/** `days` before `date`, on the business calendar. */
function daysBefore(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day - days));
  return shifted.toISOString().slice(0, 10);
}

function Card({
  title,
  control,
  children,
}: {
  title: string;
  control?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col rounded-xl border border-line bg-surface-raised p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
          {title}
        </h2>
        {control}
      </div>
      {children}
    </section>
  );
}

/** The big number a card exists to show. */
function Headline({ value, note, tone }: { value: string; note: string; tone?: 'danger' }) {
  return (
    <div className="mb-3">
      <p
        className={`tabular text-2xl font-semibold ${tone === 'danger' ? 'text-danger' : 'text-content'}`}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-content-muted">{note}</p>
    </div>
  );
}

/** Period links. Plain anchors: the page is server-rendered, so no client JS. */
function RangePicker({ param, current }: { param: string; current: RangeKey }) {
  return (
    <div className="flex gap-1 text-[11px]">
      {(Object.keys(RANGES) as RangeKey[]).map((key) => (
        <Link
          key={key}
          href={`/dashboard?${param}=${key}`}
          scroll={false}
          aria-current={key === current ? 'true' : undefined}
          className={
            key === current
              ? 'rounded bg-accent-soft px-1.5 py-0.5 font-medium text-content'
              : 'rounded px-1.5 py-0.5 text-content-muted transition-colors hover:text-content'
          }
        >
          {key === 'week' ? '7d' : key === 'month' ? '30d' : '90d'}
        </Link>
      ))}
    </div>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ sales?: string; spend?: string }>;
}) {
  const params = await searchParams;
  const salesRange: RangeKey = params.sales === 'week' || params.sales === 'quarter' ? params.sales : 'month';
  const spendRange: RangeKey = params.spend === 'week' || params.spend === 'quarter' ? params.spend : 'month';

  const user = await getCurrentUser();
  if (!user) redirect('/login');

  /**
   * Each card is shown only to somebody allowed to see what is in it.
   *
   * The dashboard was the one screen that asked nobody's permission: a till
   * assistant given `sales` alone opened it and was shown the shop's cash
   * position, its debts, its margins and its ledger totals. Hiding a card in
   * the markup would not be enough either — the figures would still have been
   * queried and sent to the browser — so the reads themselves are gated, and a
   * card the person may not see is never computed at all.
   */
  const shows = {
    money: can(user, 'accounts', 'view'),
    sales: can(user, 'sales', 'view'),
    spending: can(user, 'expenses', 'view'),
    profit: can(user, 'reports', 'view'),
    owed: can(user, 'customers', 'view'),
    stock: can(user, 'inventory', 'view'),
  };

  // The server's reading fills the space on first paint; the Clock then keeps
  // itself honest. Formatted through the SAME functions the Clock uses, so the
  // two cannot drift apart and reflow the header on hydration.
  const renderedAt = new Date();
  const renderedDate = formatClockDate(renderedAt);
  const renderedTime = formatClockTime(renderedAt);
  const today = toBusinessDate();
  const monthStart = `${today.slice(0, 7)}-01`;

  const paymentAccounts = shows.money ? getPaymentAccountBalances(db) : [];
  const trialBalance = shows.money ? getTrialBalance(db) : null;
  const entryCount = shows.money ? countJournalEntries(db) : 0;
  const stock = shows.stock ? getStockSummary(db) : null;
  const lowStockItems = shows.stock ? listProducts(db, { lowStockOnly: true }) : [];

  const salesFrom = daysBefore(today, RANGES[salesRange].days);
  const spendFrom = daysBefore(today, RANGES[spendRange].days);

  const todaySales = shows.sales ? getSalesSummary(db, today, today) : null;
  const rangeSales = shows.sales ? getSalesSummary(db, salesFrom, today) : null;
  const salesByDay = shows.sales ? getSalesByDay(db, { from: salesFrom, to: today }) : [];

  const moneyMonths = shows.money ? getMoneyByMonth(db, today, 6) : [];
  const cashHeld = sum(paymentAccounts.map((account) => account.balance));

  const spend = shows.spending ? getExpensesTotal(db, spendFrom, today) : null;
  const spendByCategory = shows.spending ? getExpensesByCategory(db, spendFrom, today) : [];

  const monthSales = shows.profit ? getSalesSummary(db, monthStart, today) : null;
  const monthExpenses = shows.profit ? getExpensesTotal(db, monthStart, today) : null;
  const monthOtherIncome = shows.profit ? getIncomesTotal(db, monthStart, today) : null;
  const monthNet =
    monthSales === null || monthExpenses === null || monthOtherIncome === null
      ? null
      : subtract(add(monthSales.grossProfit, monthOtherIncome), monthExpenses);

  const receivables = shows.owed ? getTotalReceivables(db) : null;
  const payables = shows.owed ? getTotalPayables(db) : null;
  const ageing = shows.owed ? getReceivablesAgeing(db, today) : [];
  const overdue = sum(ageing.map((row) => add(add(row.days31to60, row.days61to90), row.over90)));
  const notYetDue = receivables === null ? null : subtract(receivables, overdue);

  const topCategories = spendByCategory.slice(0, 4).map((row) => ({
    label: row.categoryName,
    value: row.total,
    display: money(row.total, { bare: true }),
  }));

  const nothingToShow = !Object.values(shows).some(Boolean);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-content">
            Good day, {user.displayName.split(' ')[0]}
          </h1>
          <p className="mt-1 text-sm text-content-muted">
            {nothingToShow
              ? 'Use the menu to get to your work.'
              : 'Here is where your money stands right now.'}
          </p>
        </div>
        <Clock initialDate={renderedDate} initialTime={renderedTime} />
      </header>

      {nothingToShow && (
        <Alert tone="info" title="Nothing to summarise here">
          This screen shows money, sales and stock figures, and your account is not set up to see
          any of them. That is not a fault — everything you can do is in the menu. Ask the owner if
          you think you should see more.
        </Alert>
      )}

      {trialBalance !== null && !trialBalance.balanced && (
        <Alert tone="danger" title="The books do not balance">
          Total debits ({money(trialBalance.totalDebit)}) do not equal total credits (
          {money(trialBalance.totalCredit)}). Difference: {money(trialBalance.difference)}. This
          should never happen — please report it before recording anything else.
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {shows.money && (
        <Card title="Cash flow">
          <Headline value={money(cashHeld)} note="Held across all your accounts" />
          <PairedBars
            data={moneyMonths.map((month) => ({
              label: month.label,
              in: month.inMinor,
              out: month.outMinor,
            }))}
            summary={`Money in and out for the last ${moneyMonths.length} months.`}
          />
        </Card>
        )}

        {shows.sales && rangeSales !== null && todaySales !== null && (
        <Card title="Sales" control={<RangePicker param="sales" current={salesRange} />}>
          <Headline
            value={money(rangeSales.total)}
            note={`${rangeSales.count} sale${rangeSales.count === 1 ? '' : 's'} · ${RANGES[salesRange].label.toLowerCase()}`}
          />
          <TrendLine
            data={salesByDay.map((day) => ({ label: day.businessDate.slice(5), value: day.total }))}
            summary={`Daily sales over the ${RANGES[salesRange].label.toLowerCase()}.`}
          />
          <p className="mt-2 text-xs text-content-muted">
            Today: <span className="tabular font-medium text-content">{money(todaySales.total)}</span>
          </p>
        </Card>
        )}

        {shows.spending && spend !== null && (
        <Card title="Spending" control={<RangePicker param="spend" current={spendRange} />}>
          <Headline value={money(spend)} note={RANGES[spendRange].label} />
          {topCategories.length > 0 ? (
            <Donut
              slices={topCategories}
              summary={`Spending by category over the ${RANGES[spendRange].label.toLowerCase()}.`}
            />
          ) : (
            <p className="text-sm text-content-muted">Nothing spent in this period.</p>
          )}
        </Card>
        )}

        {shows.profit &&
          monthNet !== null &&
          monthSales !== null &&
          monthExpenses !== null && (
        <Card title="Profit this month">
          <Headline
            value={money(monthNet)}
            note="Sales profit plus other income, less running costs"
            {...(monthNet < 0 ? { tone: 'danger' as const } : {})}
          />
          <dl className="space-y-2 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-content-muted">Sales</dt>
              <dd className="tabular font-medium text-content">{money(monthSales.total)}</dd>
            </div>
            <SplitBar
              parts={[
                { label: 'Kept', value: Math.max(0, monthSales.grossProfit), tone: 'accent' },
                { label: 'Cost of goods', value: Math.max(0, monthSales.total - monthSales.grossProfit), tone: 'muted' },
              ]}
              summary="Gross profit against the cost of the goods sold."
            />
            <div className="flex items-baseline justify-between gap-2 pt-1">
              <dt className="text-content-muted">Running costs</dt>
              <dd className="tabular font-medium text-content">{money(monthExpenses)}</dd>
            </div>
          </dl>
        </Card>
        )}

        {shows.owed && receivables !== null && notYetDue !== null && (
        <Card title="Money owed to you">
          <Headline value={money(receivables)} note="Across all customers" />
          {receivables > 0 ? (
            <>
              <SplitBar
                parts={[
                  { label: 'Overdue', value: overdue, tone: 'danger' },
                  { label: 'Not due yet', value: Math.max(0, notYetDue), tone: 'accent' },
                ]}
                summary="What is overdue against what is not yet due."
              />
              <div className="mt-3 flex justify-between text-sm">
                <span>
                  <span className="tabular block font-medium text-danger">{money(overdue)}</span>
                  <span className="text-xs text-content-muted">Over 30 days</span>
                </span>
                <span className="text-right">
                  <span className="tabular block font-medium text-content">
                    {money(Math.max(0, notYetDue) as Minor)}
                  </span>
                  <span className="text-xs text-content-muted">More recent</span>
                </span>
              </div>
              <Link
                href="/customers?owing=1"
                className="mt-3 text-xs font-medium text-accent hover:underline"
              >
                See who owes
              </Link>
            </>
          ) : (
            <p className="text-sm text-content-muted">Nobody owes you anything.</p>
          )}
          {payables !== null && payables > 0 && (
            <p className="mt-3 border-t border-line pt-3 text-sm text-content-muted">
              You owe suppliers{' '}
              <Link href="/suppliers" className="tabular font-medium text-warning hover:underline">
                {money(payables)}
              </Link>
            </p>
          )}
        </Card>
        )}

        {shows.money && (
        <Card title="Money accounts">
          <ul className="space-y-2.5">
            {paymentAccounts.map((account) => (
              <li key={account.id} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-content">{account.name}</span>
                  <span className="text-xs text-content-subtle">
                    Ledger {account.glCode}
                    {account.provider ? ` · ${account.provider}` : ''}
                  </span>
                </span>
                <span className="tabular shrink-0 font-medium text-content">
                  {money(account.balance)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {shows.stock && stock !== null && (
        <Card title="Stock">
          <Headline value={money(stock.totalStockValue)} note="At weighted average cost" />
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-xs text-content-muted">Products</dt>
              <dd className="tabular font-medium text-content">{stock.productCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-content-muted">Low</dt>
              <dd
                className={`tabular font-medium ${stock.lowStockCount > 0 ? 'text-warning' : 'text-content'}`}
              >
                {stock.lowStockCount}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-content-muted">Out</dt>
              <dd
                className={`tabular font-medium ${stock.outOfStockCount > 0 ? 'text-danger' : 'text-content'}`}
              >
                {stock.outOfStockCount}
              </dd>
            </div>
          </dl>
          {lowStockItems.length > 0 && (
            <p className="mt-3 border-t border-line pt-3 text-xs text-content-muted">
              Running low:{' '}
              {lowStockItems.slice(0, 3).map((item, index) => (
                <span key={item.id}>
                  {index > 0 && ', '}
                  <Link href={`/inventory?product=${item.id}`} className="text-accent hover:underline">
                    {item.name}
                  </Link>
                </span>
              ))}
              {lowStockItems.length > 3 && ` and ${lowStockItems.length - 3} more`}.{' '}
              <Link href="/products?low=1" className="text-accent hover:underline">
                See all
              </Link>
            </p>
          )}
        </Card>
        )}

        {shows.money && trialBalance !== null && (
        <div className="lg:col-span-2">
          <Card title="Books check">
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
          </Card>
        </div>
        )}
      </div>
    </div>
  );
}
