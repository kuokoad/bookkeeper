import type { Metadata } from 'next';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import {
  getPurchasesByDay,
  getPurchasesByProduct,
  getPurchasesBySupplier,
} from '@/services/reporting/operations.service';
import { formatDate, money, quantity, toBusinessDate } from '@/lib/format';
import { sum } from '@/domain/money';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { describePeriod, PeriodFilter, resolvePeriod } from '@/components/shared/period-filter';
import { ReportActions } from '@/components/shared/report-actions';

export const metadata: Metadata = { title: 'Purchase report' };
export const dynamic = 'force-dynamic';

export default async function PurchaseReportPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  await requirePageAccess('reports', 'view');
  const params = await searchParams;

  const { period, preset } = resolvePeriod(params.period, params.from, params.to, toBusinessDate());

  const byDay = getPurchasesByDay(db, period);
  const bySupplier = getPurchasesBySupplier(db, period);
  const byProduct = getPurchasesByProduct(db, period);

  const total = sum(byDay.map((row) => row.total));
  const count = byDay.reduce((sumSoFar, row) => sumSoFar + row.purchaseCount, 0);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Purchase report"
        description={describePeriod(period, preset)}
        actions={
          <ReportActions csvHref={`/api/reports/purchases?from=${period.from}&to=${period.to}`} />
        }
      />

      <PeriodFilter basePath="/reports/purchases" active={preset} period={period} />

      {byDay.length === 0 ? (
        <EmptyState
          title="No purchases in this period"
          description="Try a different date range, or record a delivery to see it here."
        />
      ) : (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            <Stat label="Total bought" value={money(total)} />
            <Stat label="Deliveries" value={String(count)} />
            <Stat label="Suppliers used" value={String(bySupplier.length)} />
          </div>

          <h2 className="mb-3 text-sm font-semibold text-content">By supplier</h2>
          <TableWrap className="mb-8">
            <THead>
              <TH>Supplier</TH>
              <TH numeric>Deliveries</TH>
              <TH numeric>Total</TH>
            </THead>
            <tbody>
              {bySupplier.map((row) => (
                <TR key={row.supplierId ?? 'unknown'}>
                  <TD>
                    <span className="font-medium text-content">{row.supplierName}</span>
                  </TD>
                  <TD numeric>{row.purchaseCount}</TD>
                  <TD numeric>{money(row.total, { bare: true })}</TD>
                </TR>
              ))}
              <TR className="bg-surface-sunken font-semibold">
                <TD>Total</TD>
                <TD numeric>{count}</TD>
                <TD numeric>{money(total, { bare: true })}</TD>
              </TR>
            </tbody>
          </TableWrap>

          <h2 className="mb-3 text-sm font-semibold text-content">By product</h2>
          <TableWrap className="mb-8">
            <THead>
              <TH>Product</TH>
              <TH numeric>Quantity</TH>
              <TH numeric>Total cost</TH>
            </THead>
            <tbody>
              {byProduct.map((row) => (
                <TR key={row.productId}>
                  <TD>
                    <span className="font-medium text-content">{row.productName}</span>
                  </TD>
                  <TD numeric>{quantity(row.qtyBought, row.unit)}</TD>
                  <TD numeric>{money(row.total, { bare: true })}</TD>
                </TR>
              ))}
            </tbody>
          </TableWrap>

          <h2 className="mb-3 text-sm font-semibold text-content">By day</h2>
          <TableWrap>
            <THead>
              <TH>Date</TH>
              <TH numeric>Deliveries</TH>
              <TH numeric>Total</TH>
            </THead>
            <tbody>
              {byDay.map((row) => (
                <TR key={row.businessDate}>
                  <TD>
                    <span className="whitespace-nowrap">{formatDate(row.businessDate)}</span>
                  </TD>
                  <TD numeric>{row.purchaseCount}</TD>
                  <TD numeric>{money(row.total, { bare: true })}</TD>
                </TR>
              ))}
            </tbody>
          </TableWrap>
        </>
      )}
    </div>
  );
}
