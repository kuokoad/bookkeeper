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
import { describePeriod } from '@/components/shared/period-filter';
import { ReportActions } from '@/components/shared/report-actions';
import { FilterBar } from '@/components/shared/filter-bar';
import { listCategories, listProductOptions } from '@/services/catalog.service';
import { listSupplierOptions } from '@/services/supplier.service';
import { listPaymentAccountOptions } from '@/services/payment-account.service';
import { buildQuery, type ActiveFilter } from '@/lib/filters';
import { parsePurchaseReportFilters, type SearchParams } from '@/lib/list-filters';

export const metadata: Metadata = { title: 'Purchase report' };
export const dynamic = 'force-dynamic';

export default async function PurchaseReportPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePageAccess('reports', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  const { filters, range: period, preset, carried } = parsePurchaseReportFilters(params, today);

  const byDay = getPurchasesByDay(db, filters);
  const bySupplier = getPurchasesBySupplier(db, filters);
  const byProduct = getPurchasesByProduct(db, filters);

  const total = sum(byDay.map((row) => row.total));
  const count = byDay.reduce((sumSoFar, row) => sumSoFar + row.purchaseCount, 0);

  const suppliers = listSupplierOptions(db, true);
  const categories = listCategories(db);
  const products = listProductOptions(db, true);
  const accounts = listPaymentAccountOptions(db, true);

  const nameOf = <T extends { id: number; name: string }>(
    list: T[],
    id: number | undefined,
  ): string | undefined => (id === undefined ? undefined : list.find((item) => item.id === id)?.name);

  const active: ActiveFilter[] = [];
  if (filters.supplierId !== undefined) {
    active.push({
      key: 'supplier',
      label: 'Supplier',
      value: nameOf(suppliers, filters.supplierId) ?? String(filters.supplierId),
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
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Purchase report"
        description={describePeriod(period, preset)}
        actions={<ReportActions csvHref={`/api/reports/purchases${buildQuery(carried)}`} />}
      />

      <FilterBar
        basePath="/reports/purchases"
        dateRange={{ preset, from: period.from, to: period.to }}
        active={active}
        fields={[
          {
            kind: 'select',
            key: 'supplier',
            label: 'Supplier',
            allLabel: 'All suppliers',
            options: suppliers.map((item) => ({ value: String(item.id), label: item.name })),
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
