import { accountHref } from '@/lib/account-routes';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db } from '@/db/client';
import {
  countJournalEntries,
  getPaymentAccountBalances,
} from '@/services/reporting/balances.service';
import { getExpirySummary, getStockSummary } from '@/services/catalog.service';
import { getSalesSummary } from '@/services/sale.service';
import {
  getSalesByDay,
  getTopProductByRevenue,
} from '@/services/reporting/operations.service';
import { getMoneyByMonth } from '@/services/reporting/money-trend';
import {
  checkBooksIntegrity,
  getReceivablesAgeing,
} from '@/services/reporting/ledger.service';
import { getProfitAndLoss } from '@/services/reporting/financial.service';
import { getReconciliationOverview } from '@/services/reconciliation.service';
import { getTotalReceivables } from '@/services/customer.service';
import { getTotalPayables } from '@/services/supplier.service';
import {
  getExpensesByCategory,
  getExpensesByDay,
  getExpensesTotal,
} from '@/services/cashbook.service';
import { getCurrentUser } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { sum } from '@/domain/money';
import { money, quantity, toBusinessDate, formatDate } from '@/lib/format';
import {
  dashboardRange,
  dashboardDailySeries,
  dashboardPeriod,
  dashboardRangeHref,
  summariseAgeing,
  reconciliationIssues,
  integrityChecks,
  type DashboardRange,
} from '@/lib/dashboard';
import { Badge } from '@/components/ui/badge';
import { Icon, type IconName } from '@/components/ui/icon';
import { Alert } from '@/components/ui/alert';
import { PairedBars, TrendLine } from '@/components/ui/chart';
import {
  DashboardCard as Card,
  DashboardFigure as Figure,
} from '@/components/dashboard/card';

export const metadata: Metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

function PeriodPicker({
  label,
  param,
  sales,
  spend,
}: {
  label: string;
  param: 'sales' | 'spend';
  sales: DashboardRange;
  spend: DashboardRange;
}) {
  const current = param === 'sales' ? sales : spend;
  return (
    <nav
      aria-label={`${label} reporting period`}
      className="mb-3 flex flex-wrap items-center gap-1 text-xs"
    >
      <span className="sr-only">{label}</span>
      {(['week', 'month', 'quarter'] as const).map((key) => (
        <Link
          key={key}
          href={dashboardRangeHref(
            param === 'sales' ? key : sales,
            param === 'spend' ? key : spend,
          )}
          scroll={false}
          aria-current={current === key ? 'true' : undefined}
          className={`rounded-lg px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent ${current === key ? 'bg-accent-soft font-semibold text-accent' : 'text-content-muted hover:bg-surface-sunken'}`}
        >
          {key === 'week' ? '7d' : key === 'month' ? '30d' : '90d'}
        </Link>
      ))}
    </nav>
  );
}

function Detail({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-block rounded text-sm font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
    </Link>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ sales?: string; spend?: string }>;
}) {
  const params = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const shows = {
    money: can(user, 'accounts', 'view'),
    sales: can(user, 'sales', 'view'),
    spending: can(user, 'expenses', 'view'),
    profit: can(user, 'reports', 'view'),
    owed: can(user, 'customers', 'view'),
    suppliers: can(user, 'suppliers', 'view'),
    stock: can(user, 'inventory', 'view'),
    reconciliation: can(user, 'reconciliation', 'view'),
  };
  const today = toBusinessDate();
  const salesRange = dashboardRange(params.sales);
  const spendRange = dashboardRange(params.spend);
  const salesPeriod = dashboardPeriod(today, salesRange);
  const spendPeriod = dashboardPeriod(today, spendRange);
  const profitPeriod = { from: `${today.slice(0, 7)}-01`, to: today };
  const dates = (period: { from: string; to: string }) =>
    `${formatDate(period.from)} to ${formatDate(period.to)} (inclusive)`;
  const reportHref = (path: string, period: { from: string; to: string }) =>
    `${path}?period=custom&from=${period.from}&to=${period.to}`;
  const paymentAccounts = shows.money ? getPaymentAccountBalances(db) : [];
  const booksCheck = shows.money ? checkBooksIntegrity(db) : null;
  const entryCount = shows.money ? countJournalEntries(db) : 0;
  const stock = shows.stock ? getStockSummary(db) : null;
  const expiry = shows.stock ? getExpirySummary(db) : null;
  const rangeSales = shows.sales
    ? getSalesSummary(db, salesPeriod.from, salesPeriod.to)
    : null;
  const todaySales = shows.sales ? getSalesSummary(db, today, today) : null;
  const salesByDay = shows.sales ? getSalesByDay(db, salesPeriod) : [];
  const topProduct = shows.sales
    ? getTopProductByRevenue(db, salesPeriod)
    : null;
  const spend = shows.spending
    ? getExpensesTotal(db, spendPeriod.from, spendPeriod.to)
    : null;
  const expenseDays = shows.spending
    ? getExpensesByDay(db, spendPeriod.from, spendPeriod.to)
    : [];
  const categories = shows.spending
    ? getExpensesByCategory(db, spendPeriod.from, spendPeriod.to)
    : [];
  const pl = shows.profit ? getProfitAndLoss(db, profitPeriod) : null;
  const receivables = shows.owed ? getTotalReceivables(db) : null;
  const payables = shows.suppliers ? getTotalPayables(db) : null;
  const ageing = shows.owed ? getReceivablesAgeing(db, today) : [];
  const aged =
    receivables === null ? null : summariseAgeing(ageing, receivables);
  const reconciliation = shows.reconciliation
    ? getReconciliationOverview(db)
    : [];
  const differences = reconciliationIssues(reconciliation);
  const moneyMonths = shows.money ? getMoneyByMonth(db, today, 6) : [];
  const cashHeld = sum(paymentAccounts.map((account) => account.balance));
  const negativeAccounts = paymentAccounts.filter(
    (account) => account.balance < 0,
  );
  const checks = booksCheck === null ? [] : integrityChecks(booksCheck);
  const failedChecks = checks.filter((check) => !check.passed);
  const actions = [
    {
      label: 'New Sale',
      icon: 'add' as IconName,
      href: '/sales/new',
      allowed: can(user, 'sales', 'create'),
    },
    {
      label: 'Record Expense',
      icon: 'receipt' as IconName,
      href: '/expenses#record-expense',
      allowed: can(user, 'expenses', 'create'),
    },
    {
      label: 'New Purchase',
      icon: 'shoppingBag' as IconName,
      href: '/purchases/new',
      allowed: can(user, 'purchases', 'create'),
    },
    {
      label: 'Receive Payment',
      icon: 'payment' as IconName,
      href: '/customers?owing=1',
      allowed: can(user, 'customers', 'create'),
    },
  ].filter((action) => action.allowed);
  const attention: { title: string; note: string; href: string; negativeBalance?: boolean }[] = [
    ...(aged !== null && aged.overdue > 0
      ? [
        {
          title: `${money(aged.overdue)} overdue receivables`,
          note: 'Includes amounts 1–30 days overdue and all older buckets. Customer credits can reduce bucket totals.',
          href: '/customers?owing=1',
        },
      ]
      : []),
    ...negativeAccounts.map((account) => ({
      negativeBalance: true,
      title: `${account.name}: ${money(account.balance)}`,
      note: 'Negative ledger balance. This may be an overdraft; it is not a confirmed reconciliation error.',
      href: accountHref(account.id),
    })),
    ...(stock !== null && (stock.lowStockCount > 0 || stock.outOfStockCount > 0)
      ? [
        {
          title: `${stock.lowStockCount} low-stock and ${stock.outOfStockCount} out-of-stock products`,
          note: 'Review stock levels before recording the next sale.',
          href: '/inventory',
        },
      ]
      : []),
    ...differences.map((account) => ({
      title: `${account.accountName}: ${money(account.unresolvedDifference)} unresolved count difference`,
      note: 'Recorded counts differ from the books and have not been adjusted.',
      href: '/reconciliation',
    })),
    ...failedChecks.map((check) => ({
      title: check.label,
      note: 'This integrity check needs investigation.',
      href: '/accounting',
    })),
    ...(aged !== null && !aged.reconciles
      ? [
        {
          title: `${money(aged.unaged)} outside invoice ageing`,
          note: 'Ledger balances include amounts without an invoice due-date bucket. Review allocations and opening balances.',
          href: '/customers',
        },
      ]
      : []),
  ];
  const nothingToShow = !Object.values(shows).some(Boolean);

  return (
    <div className="stitch-dashboard w-full space-y-4">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-content">Dashboard</h1>
            <p className="mt-1 text-sm text-content-muted">
              {user.displayName}, your financial overview · {formatDate(today)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Quick actions">
            {actions.map((action) => (
              <Link
                key={action.href}
                href={action.href}
                className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-accent ${action.href === "/sales/new" ? "border-accent bg-accent text-accent-text hover:opacity-90" : "border-line bg-surface-raised text-accent hover:bg-accent-soft"}`}
              >
                <Icon name={action.icon} className="h-4 w-4" />
                {action.label}
              </Link>
            ))}
          </div>
        </div>
      </header>
      {nothingToShow && (
        <Alert tone="info" title="No dashboard summaries available">
          Use the menu to access your work. Ask the owner if you need access to
          financial summaries.
        </Alert>
      )}
      <section
        aria-label="Primary financial figures"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <h2 className="sr-only">Primary financial figures</h2>
        {shows.money && (
          <Card
            title="Cash & Bank Balance"
            icon="accounts"
            href="/accounts"
            period="Current ledger balance · all recorded dates"
          >
            <Figure
              value={money(cashHeld)}
              hint="Cash, bank, mobile money and other active payment accounts"
              negative={cashHeld < 0}
            />
          </Card>
        )}
        {rangeSales !== null && (
          <Card
            title="Sales"
            icon="sales"
            href={`/sales?period=custom&from=${salesPeriod.from}&to=${salesPeriod.to}`}
          >
            <PeriodPicker label="Sales" param="sales" sales={salesRange} spend={spendRange} />
            <Figure
              value={money(rangeSales.total)}
              hint={`${rangeSales.count} posted sale${rangeSales.count === 1 ? '' : 's'} · transaction total`}
            />
          </Card>
        )}
        {spend !== null && (
          <Card
            title="Expenses"
            icon="expenses"
            href={reportHref('/expenses', spendPeriod)}
          >
            <PeriodPicker label="Expenses" param="spend" sales={salesRange} spend={spendRange} />
            <Figure
              value={money(spend)}
              hint="Recorded expense transactions; excludes other ledger adjustments"
            />
          </Card>
        )}
        {pl !== null && (
          <Card
            title="Net Profit"
            icon="profit"
            href={reportHref('/reports/profit-and-loss', profitPeriod)}
            period="Month to date"
          >
            <Figure
              value={money(pl.netProfit)}
              negative={pl.netProfit < 0}
              hint="Net sales − cost of goods + other income − all ledger expenses"
            />
          </Card>
        )}
      </section>
      {!nothingToShow && (
        <section aria-labelledby="attention-heading" className="needs-attention rounded-xl border border-line bg-surface-raised p-5">
          <h2
            id="attention-heading"
            className="mb-3 flex items-center gap-2 text-xl font-semibold leading-7 text-content"
          >
            <Icon name="warning" className="attention-heading-icon h-[18px] w-[18px]" />
            Needs Attention
          </h2>
          <div className="min-w-0">
            {attention.length === 0 ? (
              <p className="py-3 text-sm text-content-muted">
                No issues found in the dashboard checks available to your
                account.
              </p>
            ) : (
              <ul className="grid gap-2.5 md:grid-cols-2">
                {attention.map((item) => (
                  <li key={item.title} className={`min-w-0 rounded-lg border border-line bg-surface-sunken p-4 ${item.negativeBalance ? 'negative-account-alert' : ''}`}>
                    <Detail href={item.href}>{item.title}</Detail>
                    <p className="attention-note mt-1 text-content-muted">
                      {item.note}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
      {(shows.sales || shows.spending || shows.money) && (
        <section aria-labelledby="trends-heading">
          <h2
            id="trends-heading"
            className="sr-only"
          >
            Financial trends
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {(shows.sales || shows.spending) && (<Card title="Sales & expense trends" icon="sales">
              <div className="grid gap-3 sm:grid-cols-2">
                {shows.sales && (
                <div className="min-w-0">
                  <Detail href={`/sales?period=custom&from=${salesPeriod.from}&to=${salesPeriod.to}`}>Daily sales</Detail>
                  <p className="mb-2 mt-1 text-xs text-content-muted">{dates(salesPeriod)}</p>
                  {salesByDay.length > 0 ? (
                    <TrendLine
                      data={dashboardDailySeries(salesByDay, salesPeriod)}
                      summary={`Daily sales: ${dates(salesPeriod)}. Total ${money(rangeSales!.total)}.`}
                    />
                  ) : (
                    <p className="text-sm text-content-muted">
                      No sales recorded in this period.
                    </p>
                  )}
                  <p className="mt-2 text-xs text-content-muted">
                    Today ({formatDate(today)}): {money(todaySales!.total)}
                  </p>
                </div>
              )}
                {shows.spending && (
                  <div className="min-w-0 border-t border-line pt-3 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-3">
                    <Detail href={reportHref('/expenses', spendPeriod)}>Daily expenses</Detail>
                    <p className="mb-2 mt-1 text-xs text-content-muted">{dates(spendPeriod)}</p>
                    {expenseDays.length > 0 ? (
                      <TrendLine
                        data={dashboardDailySeries(expenseDays, spendPeriod)}
                        summary={`Recorded daily expenses: ${dates(spendPeriod)}. Total ${money(spend!)}.`}
                      />
                    ) : (
                      <p className="text-sm text-content-muted">
                        No expense transactions recorded in this period.
                      </p>
                    )}
                    {categories.length > 0 && (
                      <details className="mt-3 text-sm">
                        <summary className="cursor-pointer text-accent">
                          Expense categories
                        </summary>
                        <dl className="mt-2 space-y-1">
                          {categories.map((category) => (
                            <div
                              key={category.categoryAccountId}
                              className="flex justify-between gap-3"
                            >
                              <dt className="text-content-muted">
                                {category.categoryName}
                              </dt>
                              <dd className="tabular">{money(category.total)}</dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    )}
                  </div>
                )}
              </div>
            </Card>
            )}
            {shows.money && (
              <Card
                title="Cash movements"
                icon="cashflow"
                href={shows.profit ? '/reports/cash-flow' : '/accounts'}
                period={`${moneyMonths[0]?.month} through ${moneyMonths.at(-1)?.month} · whole calendar months`}
              >
                {moneyMonths.some(
                  (month) => month.inMinor !== 0 || month.outMinor !== 0,
                ) ? (
                  <PairedBars
                    data={moneyMonths.map((month) => ({
                      label: month.label,
                      in: month.inMinor,
                      out: month.outMinor,
                    }))}
                    summary="Gross debits and credits to payment accounts over six whole calendar months."
                  />
                ) : (
                  <p className="text-sm text-content-muted">
                    No money movements recorded in these months.
                  </p>
                )}
                <p className="mt-2 text-xs text-content-muted">
                  Gross money in and out, including transfers between accounts.
                  This is separate from your cash balance.
                </p>
              </Card>
            )}

          </div>
        </section>
      )}
      {(shows.stock || shows.money || shows.owed || shows.suppliers || shows.sales) && (
        <section aria-labelledby="summaries-heading">
          <h2
            id="summaries-heading"
            className="mb-2 text-base font-semibold text-content"
          >
            Inventory and account summaries
          </h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {stock !== null && (
              <Card
                title="Inventory valuation"
                icon="stock"
                href="/inventory"
                period="Current stock · all recorded dates"
              >
                <Figure
                  value={money(stock.totalStockValue)}
                  hint="At weighted average cost"
                />
                <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <dt className="text-content-muted">Products</dt>
                    <dd className="tabular">{stock.trackedCount}</dd>
                  </div>
                  <div>
                    <dt className="text-content-muted">Low stock</dt>
                    <dd className="tabular">{stock.lowStockCount}</dd>
                  </div>
                  <div>
                    <dt className="text-content-muted">Out of stock</dt>
                    <dd className="tabular">{stock.outOfStockCount}</dd>
                  </div>
                </dl>
                {stock.trackedCount === 0 && (
                  <p className="mt-2 text-sm text-content-muted">
                    No stock-tracked products yet.
                  </p>
                )}
                {shows.sales && (
                  <div className="mt-3 rounded-lg border border-line bg-surface-sunken p-3">
                    <h4 className="text-sm font-semibold">Top selling product</h4>
                    <p className="mb-2 mt-1 text-xs text-content-muted">{dates(salesPeriod)}</p>
                    {topProduct === null ? (
                      <p className="text-sm text-content-muted">
                        No product sales in this period.
                      </p>
                    ) : (
                      <>
                        <p className="text-lg font-semibold text-content">
                          {topProduct.productName}
                        </p>
                        <p className="mt-1 text-sm text-content-muted">
                          {money(topProduct.revenue)} revenue ·{' '}
                          {quantity(topProduct.qtySold, topProduct.unit)} sold
                        </p>
                        <p className="mt-2 text-xs text-content-subtle">
                          Ranked by revenue, rather than units sold.
                        </p>
                      </>
                    )}
                  </div>
                )}
                {expiry !== null &&
                  (expiry.expiredCount > 0 || expiry.expiringSoonCount > 0) && (
                    <p className="mt-3 border-t border-line pt-2 text-sm text-warning">
                      {expiry.expiredCount} products with expired stock;{' '}
                      {expiry.expiringSoonCount} expiring soon. Review batch
                      dates in Inventory.
                    </p>
                  )}
              </Card>
            )}
            {(shows.owed || shows.suppliers) && (<Card title="Receivables & payables" icon="owed">
              <div className="space-y-3">            {receivables !== null && aged !== null && (
                <div className="rounded-lg border border-line bg-surface-sunken p-3">
                  <Detail href="/customers?owing=1">Customer receivables</Detail>
                  <p className="mb-2 mt-1 text-xs text-content-muted">Current ledger balance · invoice ageing at {formatDate(today)}</p>
                  <Figure
                    value={money(receivables)}
                    hint="Net customer ledger balance, including customer credits"
                  />
                  <dl className="mt-3 space-y-2 text-sm">
                    <div className="flex flex-wrap justify-between gap-2">
                      <dt>Overdue (all overdue buckets)</dt>
                      <dd className="tabular">{money(aged.overdue)}</dd>
                    </div>
                    <div className="flex flex-wrap justify-between gap-2">
                      <dt>Not yet due / due today</dt>
                      <dd className="tabular">{money(aged.notYetDue)}</dd>
                    </div>
                    {!aged.reconciles && (
                      <div className="flex flex-wrap justify-between gap-2 text-warning">
                        <dt>Outside invoice ageing</dt>
                        <dd className="tabular">{money(aged.unaged)}</dd>
                      </div>
                    )}
                  </dl>
                  <p className="mt-3 text-xs text-content-muted">
                    {aged.reconciles
                      ? 'Overdue + not yet due agrees with the customer ledger.'
                      : 'Invoice buckets + amounts outside invoice ageing agree with the customer ledger. Review unallocated credits, opening balances and future-dated transactions.'}{' '}
                    Negative bucket amounts represent customer credits.
                  </p>
                </div>
              )}
                {payables !== null && (
                  <div className="rounded-lg border border-line bg-surface-sunken p-3">
                    <Detail href="/suppliers">Supplier payables</Detail>
                    <p className="mb-2 mt-1 text-xs text-content-muted">Current ledger balance · all recorded dates</p>
                    <Figure
                      value={money(payables)}
                      hint="Net amount owed to suppliers, including supplier credits"
                    />
                  </div>
                )}</div>
            </Card>
            )}
            {shows.money && (
              <Card
                title="Money accounts"
                icon="cashflow"
                href="/accounts"
                period="Current ledger balances · all recorded dates"
              >
                {paymentAccounts.length === 0 ? (
                  <p className="text-sm text-content-muted">
                    No active payment accounts. Open Accounts to review setup.
                  </p>
                ) : (
                  <ul className="divide-y divide-line">
                    {paymentAccounts.map((account) => (
                      <li
                        key={account.id}
                        className="flex flex-wrap items-baseline justify-between gap-2 py-2"
                      >
                        <Detail href={accountHref(account.id)}>
                          {account.name}
                        </Detail>
                        <span
                          className={`tabular ${account.balance < 0 ? 'text-danger' : 'text-content'}`}
                        >
                          {money(account.balance)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            {shows.sales && !shows.stock && (
              <Card
                title="Top selling product"
                icon="products"
                period={dates(salesPeriod)}
              >
                {topProduct === null ? (
                  <p className="text-sm text-content-muted">
                    No product sales in this period.
                  </p>
                ) : (
                  <>
                    <p className="text-lg font-semibold text-content">
                      {topProduct.productName}
                    </p>
                    <p className="mt-1 text-sm text-content-muted">
                      {money(topProduct.revenue)} revenue ·{' '}
                      {quantity(topProduct.qtySold, topProduct.unit)} sold
                    </p>
                    <p className="mt-2 text-xs text-content-subtle">
                      Ranked by revenue, rather than units sold.
                    </p>
                  </>
                )}
              </Card>
            )}
          </div>
        </section>
      )}
      {(booksCheck !== null || shows.reconciliation) && (
        <section aria-labelledby="books-heading" className="rounded-xl border border-line bg-surface-raised p-4">
          <h2
            id="books-heading"
            className="mb-2 text-base font-semibold text-content"
          >
            Books Check and reconciliation
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {booksCheck !== null && (
              <Card
                title="Books Check"
                embedded
                icon="books"
                href="/accounting"
                period="All recorded journal entries"
              >
                <dl className="space-y-2 text-sm">
                  {checks.map((check) => (
                    <div
                      key={check.label}
                      className="flex justify-between gap-3"
                    >
                      <dt className="text-content-muted">{check.label}</dt>
                      <dd
                        className={`shrink-0 font-medium ${check.passed ? 'text-success' : 'text-danger'}`}
                      >
                        <Badge tone={check.passed ? 'success' : 'danger'}>{check.passed ? 'Passed' : 'Needs review'}</Badge>
                      </dd>
                    </div>
                  ))}
                  <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-2">
                    <dt>Total debits</dt>
                    <dd className="tabular">{money(booksCheck.totalDebit)}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt>Total credits</dt>
                    <dd className="tabular">{money(booksCheck.totalCredit)}</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt>Difference</dt>
                    <dd className="tabular">{money(booksCheck.difference)}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-content-muted">
                  {entryCount} journal entries checked. Matching debits and
                  credits does not confirm that every transaction is correct.
                  Review classifications, supporting documents and
                  reconciliation.
                </p>
              </Card>
            )}
            {shows.reconciliation && (
              <Card
                title="Account reconciliation"
                embedded
                icon="check"
                href="/reconciliation"
                period="Recorded counts · each account checked separately"
              >
                {reconciliation.length === 0 ? (
                  <p className="text-sm text-content-muted">
                    No active accounts available to reconcile.
                  </p>
                ) : (
                  <ul className="divide-y divide-line">
                    {reconciliation.map((account) => (
                      <li key={account.paymentAccountId} className="py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-medium text-content">
                            {account.accountName}
                          </p>
                          <Badge tone={account.unresolvedDifference !== 0 ? 'warning' : 'neutral'}>
                            {account.unresolvedDifference !== 0
                              ? 'Needs review'
                              : account.lastCountedOn === null
                                ? 'Not verified'
                                : 'Count recorded'}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-content-muted">
                          {account.lastCountedOn === null
                            ? 'No count recorded; reconciliation not verified.'
                            : `Last counted ${formatDate(account.lastCountedOn)}.`}
                        </p>
                        <p
                          className={`mt-1 text-sm ${account.unresolvedDifference !== 0 ? 'text-warning' : 'text-content-muted'}`}
                        >
                          {account.unresolvedDifference !== 0
                            ? `${money(account.unresolvedDifference)} unresolved difference`
                            : account.lastCountedOn === null
                              ? 'Count this account to establish a comparison.'
                              : 'No unresolved recorded difference.'}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
