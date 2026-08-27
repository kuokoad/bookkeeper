import type { Metadata } from 'next';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import {
  getSalesByCategory,
  getSalesByCustomer,
  getSalesByDay,
  getSalesByPaymentMethod,
  getSalesByProduct,
  getSalesLinesByCustomer,
  getSalesLinesByDay,
} from '@/services/reporting/operations.service';
import { formatDate, money, quantity, toBusinessDate } from '@/lib/format';
import { mulDiv, sum } from '@/domain/money';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { describePeriod } from '@/components/shared/period-filter';
import { ReportActions } from '@/components/shared/report-actions';
import { FilterBar } from '@/components/shared/filter-bar';
import { listCategories, listProductOptions } from '@/services/catalog.service';
import { listCustomerOptions } from '@/services/customer.service';
import { listPaymentAccountOptions } from '@/services/payment-account.service';
import { buildQuery, type ActiveFilter } from '@/lib/filters';
import { parseSalesReportFilters, type SearchParams } from '@/lib/list-filters';

export const metadata: Metadata = { title: 'Sales report' };
export const dynamic = 'force-dynamic';

function percent(bp: number | null): string {
  return bp === null ? '—' : `${(bp / 100).toFixed(1)}%`;
}

export default async function SalesReportPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePageAccess('reports', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  const { filters, range: period, preset, carried } = parseSalesReportFilters(params, today);

  /*
    A product or a category is a property of a LINE, so once one is chosen every
    money figure on this page becomes line money: the product's revenue, net of
    tax, and the product's cost. A line has no tender, no invoice discount and
    no tax of its own — those belong to the receipt — so the receipt-level
    tables are swapped for line-level ones rather than being left to report a
    whole receipt's total under a single product's name.
  */
  const byLine = filters.productId !== undefined || filters.categoryId !== undefined;

  const byProduct = getSalesByProduct(db, filters);
  const byCategory = getSalesByCategory(db, filters);

  const byDay = byLine ? [] : getSalesByDay(db, filters);
  const byCustomer = byLine ? [] : getSalesByCustomer(db, filters);
  const byMethod = byLine ? [] : getSalesByPaymentMethod(db, filters);

  const linesByDay = byLine ? getSalesLinesByDay(db, filters) : [];
  const linesByCustomer = byLine ? getSalesLinesByCustomer(db, filters) : [];

  const days = byLine
    ? linesByDay.map((row) => ({
        businessDate: row.businessDate,
        saleCount: row.saleCount,
        revenue: row.revenue,
        cost: row.cost,
        profit: row.profit,
      }))
    : byDay.map((row) => ({
        businessDate: row.businessDate,
        saleCount: row.saleCount,
        revenue: row.total,
        cost: row.cogs,
        profit: row.profit,
      }));

  const customerRows = byLine
    ? linesByCustomer.map((row) => ({
        key: row.customerId,
        name: row.customerName,
        saleCount: row.saleCount,
        revenue: row.revenue,
        profit: row.profit,
      }))
    : byCustomer.map((row) => ({
        key: row.customerId,
        name: row.customerName,
        saleCount: row.saleCount,
        revenue: row.total,
        profit: row.profit,
      }));

  const totalSales = sum(days.map((row) => row.revenue));
  const totalProfit = sum(days.map((row) => row.profit));
  const saleCount = days.reduce((total, row) => total + row.saleCount, 0);

  const customers = listCustomerOptions(db, true);
  const categories = listCategories(db);
  const products = listProductOptions(db, true);
  const accounts = listPaymentAccountOptions(db, true);

  const nameOf = <T extends { id: number; name: string }>(
    list: T[],
    id: number | undefined,
  ): string | undefined => (id === undefined ? undefined : list.find((item) => item.id === id)?.name);

  const active: ActiveFilter[] = [];
  if (filters.customerId !== undefined) {
    active.push({
      key: 'customer',
      label: 'Customer',
      value: nameOf(customers, filters.customerId) ?? String(filters.customerId),
    });
  }
  if (filters.categoryId !== undefined) {
    active.push({
      key: 'category',
      label: 'Category',
      value: nameOf(categories, filters.categoryId) ?? String(filters.categoryId),
    });
  }
  if (filters.productId !== undefined) {
    active.push({
      key: 'product',
      label: 'Product',
      value: nameOf(products, filters.productId) ?? String(filters.productId),
    });
  }
  if (filters.paymentAccountId !== undefined) {
    active.push({
      key: 'account',
      label: 'Payment method',
      value: nameOf(accounts, filters.paymentAccountId) ?? String(filters.paymentAccountId),
    });
  }
  if (preset !== 'month') {
    active.push({
      key: 'period',
      label: 'Period',
      value: describePeriod(period, preset),
      alsoClears: ['from', 'to'],
    });
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Sales report"
        description={describePeriod(period, preset)}
        actions={<ReportActions csvHref={`/api/reports/sales${buildQuery(carried)}`} />}
      />

      <FilterBar
        basePath="/reports/sales"
        dateRange={{ preset, from: period.from, to: period.to }}
        active={active}
        fields={[
          {
            kind: 'select',
            key: 'customer',
            label: 'Customer',
            allLabel: 'All customers',
            options: customers.map((item) => ({ value: String(item.id), label: item.name })),
          },
          {
            kind: 'select',
            key: 'category',
            label: 'Category',
            allLabel: 'All categories',
            options: categories.map((item) => ({ value: String(item.id), label: item.name })),
          },
          {
            kind: 'select',
            key: 'product',
            label: 'Product',
            allLabel: 'All products',
            options: products.map((item) => ({ value: String(item.id), label: item.name })),
          },
          {
            kind: 'select',
            key: 'account',
            label: 'Payment method',
            allLabel: 'All methods',
            options: accounts.map((item) => ({ value: String(item.id), label: item.name })),
          },
        ]}
      />

      {byLine && (
        <p className="mb-4 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-xs text-content-muted no-print">
          Every figure below is for the matching lines only, net of tax — this product&rsquo;s
          revenue and this product&rsquo;s cost, not the totals of the receipts it appeared on.
          A line has no tender, no invoice discount and no tax of its own; those belong to the
          whole receipt, which is why there is no payment-method breakdown while this filter is on.
        </p>
      )}

      {days.length === 0 ? (
        <EmptyState
          title="No sales in this period"
          description="Try a different date range, or record a sale to see it here."
        />
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-4">
            <Stat label={byLine ? 'Product revenue (net)' : 'Total sales'} value={money(totalSales)} />
            <Stat label="Gross profit" value={money(totalProfit)} tone="success" />
            <Stat label={byLine ? 'Receipts involved' : 'Number of sales'} value={String(saleCount)} />
            <Stat
              label={byLine ? 'Average per receipt' : 'Average sale'}
              value={money(saleCount === 0 ? totalSales : mulDiv(totalSales, 1, saleCount))}
            />
          </div>

          <h2 className="mb-3 text-sm font-semibold text-content">By day</h2>
          <TableWrap className="mb-8">
            <THead>
              <TH>Date</TH>
              <TH numeric>Sales</TH>
              <TH numeric>{byLine ? 'Revenue (net)' : 'Revenue'}</TH>
              <TH numeric>Cost</TH>
              <TH numeric>Profit</TH>
            </THead>
            <tbody>
              {days.map((row) => (
                <TR key={row.businessDate}>
                  <TD>
                    <span className="whitespace-nowrap">{formatDate(row.businessDate)}</span>
                  </TD>
                  <TD numeric>{row.saleCount}</TD>
                  <TD numeric>{money(row.revenue, { bare: true })}</TD>
                  <TD numeric>{money(row.cost, { bare: true })}</TD>
                  <TD numeric>{money(row.profit, { bare: true })}</TD>
                </TR>
              ))}
              <TR className="bg-surface-sunken font-semibold">
                <TD>Total</TD>
                <TD numeric>{saleCount}</TD>
                <TD numeric>{money(totalSales, { bare: true })}</TD>
                <TD numeric>{money(sum(byDay.map((r) => r.cogs)), { bare: true })}</TD>
                <TD numeric>{money(totalProfit, { bare: true })}</TD>
              </TR>
            </tbody>
          </TableWrap>

          <h2 className="mb-3 text-sm font-semibold text-content">
            By product — what actually makes you money
          </h2>
          <TableWrap className="mb-8">
            <THead>
              <TH>Product</TH>
              <TH>Category</TH>
              <TH numeric>Sold</TH>
              <TH numeric>Revenue</TH>
              <TH numeric>Cost</TH>
              <TH numeric>Profit</TH>
              <TH numeric>Margin</TH>
            </THead>
            <tbody>
              {byProduct.map((row) => (
                <TR key={row.productId}>
                  <TD>
                    <span className="font-medium text-content">{row.productName}</span>
                  </TD>
                  <TD>
                    <span className="text-content-muted">{row.categoryName ?? '—'}</span>
                  </TD>
                  <TD numeric>{quantity(row.qtySold, row.unit)}</TD>
                  <TD numeric>{money(row.revenue, { bare: true })}</TD>
                  <TD numeric>{money(row.cost, { bare: true })}</TD>
                  <TD numeric>
                    <span className={row.profit < 0 ? 'text-danger' : ''}>
                      {money(row.profit, { bare: true })}
                    </span>
                  </TD>
                  <TD numeric>{percent(row.marginBp)}</TD>
                </TR>
              ))}
            </tbody>
          </TableWrap>

          <div className="grid gap-8 lg:grid-cols-2">
            <div>
              <h2 className="mb-3 text-sm font-semibold text-content">By category</h2>
              <TableWrap>
                <THead>
                  <TH>Category</TH>
                  <TH numeric>Revenue</TH>
                  <TH numeric>Profit</TH>
                </THead>
                <tbody>
                  {byCategory.map((row) => (
                    <TR key={row.categoryId ?? 'none'}>
                      <TD>{row.categoryName}</TD>
                      <TD numeric>{money(row.revenue, { bare: true })}</TD>
                      <TD numeric>{money(row.profit, { bare: true })}</TD>
                    </TR>
                  ))}
                </tbody>
              </TableWrap>
            </div>

            <div>
              <h2 className="mb-3 text-sm font-semibold text-content">By payment method</h2>
              {byLine ? (
                <p className="rounded-xl border border-dashed border-line-strong bg-surface-raised px-4 py-6 text-sm text-content-muted">
                  Not shown while a product or category filter is on. Money is handed over for a
                  whole receipt, so there is no honest way to say how much of a cash payment was
                  for one product on it.
                </p>
              ) : (
              <TableWrap>
                <THead>
                  <TH>Method</TH>
                  <TH numeric>Received</TH>
                </THead>
                <tbody>
                  {byMethod.map((row) => (
                    <TR key={row.paymentAccountId}>
                      <TD>{row.accountName}</TD>
                      <TD numeric>{money(row.received, { bare: true })}</TD>
                    </TR>
                  ))}
                  <TR className="bg-surface-sunken font-semibold">
                    <TD>Total taken</TD>
                    <TD numeric>
                      {money(sum(byMethod.map((r) => r.received)), { bare: true })}
                    </TD>
                  </TR>
                </tbody>
              </TableWrap>
              )}
              {!byLine && (
                <p className="mt-2 text-xs text-content-subtle">
                  This is what was actually handed over, so it is less than total sales when
                  something was sold on credit.
                </p>
              )}
            </div>
          </div>

          <h2 className="mt-8 mb-3 text-sm font-semibold text-content">By customer</h2>
          <TableWrap>
            <THead>
              <TH>Customer</TH>
              <TH numeric>{byLine ? 'Receipts' : 'Sales'}</TH>
              <TH numeric>{byLine ? 'Revenue (net)' : 'Total'}</TH>
              <TH numeric>Profit</TH>
            </THead>
            <tbody>
              {customerRows.map((row) => (
                <TR key={row.key ?? 'walk-in'}>
                  <TD>{row.name}</TD>
                  <TD numeric>{row.saleCount}</TD>
                  <TD numeric>{money(row.revenue, { bare: true })}</TD>
                  <TD numeric>{money(row.profit, { bare: true })}</TD>
                </TR>
              ))}
            </tbody>
          </TableWrap>
        </>
      )}
    </div>
  );
}
