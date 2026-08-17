import type { Metadata } from 'next';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import {
  getSalesByCategory,
  getSalesByCustomer,
  getSalesByDay,
  getSalesByPaymentMethod,
  getSalesByProduct,
} from '@/services/reporting/operations.service';
import { formatDate, money, quantity, toBusinessDate } from '@/lib/format';
import { mulDiv, sum } from '@/domain/money';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { describePeriod, PeriodFilter, resolvePeriod } from '@/components/shared/period-filter';
import { ReportActions } from '@/components/shared/report-actions';

export const metadata: Metadata = { title: 'Sales report' };
export const dynamic = 'force-dynamic';

function percent(bp: number | null): string {
  return bp === null ? '—' : `${(bp / 100).toFixed(1)}%`;
}

export default async function SalesReportPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  await requirePageAccess('reports', 'view');
  const params = await searchParams;

  const { period, preset } = resolvePeriod(params.period, params.from, params.to, toBusinessDate());

  const byDay = getSalesByDay(db, period);
  const byProduct = getSalesByProduct(db, period);
  const byCategory = getSalesByCategory(db, period);
  const byCustomer = getSalesByCustomer(db, period);
  const byMethod = getSalesByPaymentMethod(db, period);

  const totalSales = sum(byDay.map((row) => row.total));
  const totalProfit = sum(byDay.map((row) => row.profit));
  const saleCount = byDay.reduce((total, row) => total + row.saleCount, 0);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Sales report"
        description={describePeriod(period, preset)}
        actions={
          <ReportActions csvHref={`/api/reports/sales?from=${period.from}&to=${period.to}`} />
        }
      />

      <PeriodFilter basePath="/reports/sales" active={preset} period={period} />

      {byDay.length === 0 ? (
        <EmptyState
          title="No sales in this period"
          description="Try a different date range, or record a sale to see it here."
        />
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-4">
            <Stat label="Total sales" value={money(totalSales)} />
            <Stat label="Gross profit" value={money(totalProfit)} tone="success" />
            <Stat label="Number of sales" value={String(saleCount)} />
            <Stat
              label="Average sale"
              value={money(saleCount === 0 ? totalSales : mulDiv(totalSales, 1, saleCount))}
            />
          </div>

          <h2 className="mb-3 text-sm font-semibold text-content">By day</h2>
          <TableWrap className="mb-8">
            <THead>
              <TH>Date</TH>
              <TH numeric>Sales</TH>
              <TH numeric>Revenue</TH>
              <TH numeric>Cost</TH>
              <TH numeric>Profit</TH>
            </THead>
            <tbody>
              {byDay.map((row) => (
                <TR key={row.businessDate}>
                  <TD>
                    <span className="whitespace-nowrap">{formatDate(row.businessDate)}</span>
                  </TD>
                  <TD numeric>{row.saleCount}</TD>
                  <TD numeric>{money(row.total, { bare: true })}</TD>
                  <TD numeric>{money(row.cogs, { bare: true })}</TD>
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
              <p className="mt-2 text-xs text-content-subtle">
                This is what was actually handed over, so it is less than total sales when
                something was sold on credit.
              </p>
            </div>
          </div>

          <h2 className="mt-8 mb-3 text-sm font-semibold text-content">By customer</h2>
          <TableWrap>
            <THead>
              <TH>Customer</TH>
              <TH numeric>Sales</TH>
              <TH numeric>Total</TH>
              <TH numeric>Profit</TH>
            </THead>
            <tbody>
              {byCustomer.map((row) => (
                <TR key={row.customerId ?? 'walk-in'}>
                  <TD>{row.customerName}</TD>
                  <TD numeric>{row.saleCount}</TD>
                  <TD numeric>{money(row.total, { bare: true })}</TD>
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
