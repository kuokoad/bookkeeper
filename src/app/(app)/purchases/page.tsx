import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import {
  countPurchases,
  getFilteredPurchasesSummary,
  listPurchases,
} from '@/services/purchase.service';
import { listCategories, listProductOptions } from '@/services/catalog.service';
import { getTotalPayables, listSupplierOptions } from '@/services/supplier.service';
import { listPaymentAccountOptions } from '@/services/payment-account.service';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import {
  buildQuery,
  chipAmount,
  clampPage,
  describeDateRange,
  type ActiveFilter,
} from '@/lib/filters';
import { parsePurchaseFilters, type SearchParams } from '@/lib/list-filters';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { FilterBar } from '@/components/shared/filter-bar';
import { Pagination, SortLink } from '@/components/shared/pagination';

export const metadata: Metadata = { title: 'Purchases' };
export const dynamic = 'force-dynamic';

const METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  MOBILE_MONEY: 'Mobile money',
  BANK: 'Bank',
  OTHER: 'Other',
};

export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePageAccess('purchases', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  const { filters, range, preset, page: requestedPage, pageSize, carried } =
    parsePurchaseFilters(params, today);

  const suppliers = listSupplierOptions(db, true);
  // Shop-wide, deliberately outside the filter. See the note by the stats.
  const payables = getTotalPayables(db);
  const categories = listCategories(db);
  const products = listProductOptions(db, true);
  const accounts = listPaymentAccountOptions(db, true);

  const total = countPurchases(db, filters);
  const page = clampPage(requestedPage, total, pageSize);
  const rows = listPurchases(db, { ...filters, limit: pageSize, offset: (page - 1) * pageSize });

  // Totals for the filtered set, not for the month.
  const summary = getFilteredPurchasesSummary(db, filters);

  const sort = filters.sort ?? 'date';
  const direction = filters.direction ?? 'desc';

  const nameOf = <T extends { id: number; name: string }>(
    list: T[],
    id: number | undefined,
  ): string | undefined => (id === undefined ? undefined : list.find((item) => item.id === id)?.name);

  const active: ActiveFilter[] = [];
  if (filters.search) active.push({ key: 'q', label: 'Search', value: filters.search });
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
      label: 'Paid from',
      value: nameOf(accounts, filters.paymentAccountId) ?? String(filters.paymentAccountId),
    });
  }
  if (filters.paymentKind !== undefined) {
    active.push({ key: 'method', label: 'Method', value: METHOD_LABELS[filters.paymentKind] ?? '' });
  }
  if (filters.status !== undefined) {
    active.push({
      key: 'status',
      label: 'Status',
      value: filters.status === 'VOIDED' ? 'Voided' : 'Posted',
    });
  }
  if (filters.paymentState !== undefined) {
    active.push({
      key: 'paid',
      label: 'Settlement',
      value:
        filters.paymentState === 'paid'
          ? 'Fully paid'
          : filters.paymentState === 'partial'
            ? 'Partly paid'
            : 'Outstanding',
    });
  }
  if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
    active.push({
      key: 'min',
      label: 'Total',
      value:
        filters.minAmount !== undefined && filters.maxAmount !== undefined
          ? `${chipAmount(filters.minAmount)} – ${chipAmount(filters.maxAmount)}`
          : filters.minAmount !== undefined
            ? `over ${chipAmount(filters.minAmount)}`
            : `under ${chipAmount(filters.maxAmount!)}`,
      alsoClears: ['max'],
    });
  }
  if (preset !== 'month') {
    active.push({
      key: 'period',
      label: 'Period',
      value: describeDateRange(range, preset, today),
      alsoClears: ['from', 'to'],
    });
  }

  const exportHref = `/api/exports/purchases${buildQuery(carried)}`;
  const isFiltered = active.length > 0;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Purchases"
        description="What you bought, from whom, and what you still owe."
        actions={
          <>
            <a href={exportHref} download>
              <Button variant="secondary" size="sm" type="button">
                Download CSV
              </Button>
            </a>
            {can(user, 'purchases', 'create') ? (
              <Link href="/purchases/new">
                <Button size="sm">New purchase</Button>
              </Link>
            ) : null}
          </>
        }
      />

      {/*
        Four figures for the deliveries this filter selects, and one for the
        shop. "You owe suppliers" is the whole payable balance and must NOT move
        with the filter: narrowing to one month cannot reduce what the shop
        actually owes, and an owner who looks here to decide whether they can
        afford something needs the real number. The same split as the Products
        page — the shop on top, the selection beside it.
      */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat
          label="Deliveries"
          value={String(summary.count)}
          hint={describeDateRange(range, preset, today)}
        />
        <Stat label="Total cost" value={money(summary.total)} />
        <Stat label="Paid" value={money(summary.paid, { bare: true })} />
        <Stat
          label="Owing on these"
          value={money(summary.outstanding, { bare: true })}
          tone={summary.outstanding > 0 ? 'warning' : 'default'}
        />
        <Stat
          label="You owe suppliers"
          value={money(payables)}
          tone={payables > 0 ? 'warning' : 'default'}
          hint="Accounts payable, whole shop"
        />
      </div>

      <FilterBar
        basePath="/purchases"
        dateRange={{ preset, from: range.from, to: range.to }}
        active={active}
        quick={[
          {
            label: "Today's purchases",
            params: { period: 'today', from: null, to: null },
            match: { period: 'today' },
          },
          { label: 'Credit purchases', params: { paid: 'outstanding' }, match: { paid: 'outstanding' } },
          { label: 'Fully paid', params: { paid: 'paid' }, match: { paid: 'paid' } },
          { label: 'Partly paid', params: { paid: 'partial' }, match: { paid: 'partial' } },
        ]}
        fields={[
          {
            kind: 'search',
            key: 'q',
            label: 'Search',
            placeholder: 'Purchase or invoice no, supplier, product',
            wide: true,
          },
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
            label: 'Paid from',
            allLabel: 'Any account',
            options: accounts.map((item) => ({ value: String(item.id), label: item.name })),
          },
          {
            kind: 'select',
            key: 'status',
            label: 'Status',
            allLabel: 'All',
            options: [
              { value: 'POSTED', label: 'Posted' },
              { value: 'VOIDED', label: 'Voided' },
            ],
          },
          { kind: 'amount-range', minKey: 'min', maxKey: 'max', label: 'Total', currency: 'GHS' },
        ]}
      />

      {rows.length === 0 ? (
        <EmptyState
          title={isFiltered ? 'No purchases match these filters' : 'No purchases in this period'}
          description={
            isFiltered
              ? 'Try widening the dates, or clear a filter to see more.'
              : 'Record a delivery to add stock at what it actually cost you, and to track what you owe.'
          }
          action={
            can(user, 'purchases', 'create') && !isFiltered ? (
              <Link href="/purchases/new">
                <Button>Record a purchase</Button>
              </Link>
            ) : null
          }
        />
      ) : (
        <>
          <TableWrap>
            <THead>
              <TH>
                <SortLink
                  basePath="/purchases"
                  values={carried}
                  column="reference"
                  activeSort={sort}
                  activeDirection={direction}
                  defaultDirection="asc"
                >
                  Reference
                </SortLink>
              </TH>
              <TH>
                <SortLink
                  basePath="/purchases"
                  values={carried}
                  column="date"
                  activeSort={sort}
                  activeDirection={direction}
                >
                  Date
                </SortLink>
              </TH>
              <TH>
                <SortLink
                  basePath="/purchases"
                  values={carried}
                  column="supplier"
                  activeSort={sort}
                  activeDirection={direction}
                  defaultDirection="asc"
                >
                  Supplier
                </SortLink>
              </TH>
              <TH>Invoice</TH>
              <TH numeric>Lines</TH>
              <TH numeric>
                <SortLink
                  basePath="/purchases"
                  values={carried}
                  column="amount"
                  activeSort={sort}
                  activeDirection={direction}
                >
                  Total
                </SortLink>
              </TH>
              <TH numeric>
                <SortLink
                  basePath="/purchases"
                  values={carried}
                  column="outstanding"
                  activeSort={sort}
                  activeDirection={direction}
                >
                  Owing
                </SortLink>
              </TH>
              <TH>Status</TH>
            </THead>
            <tbody>
              {rows.map((row) => (
                <TR key={row.id}>
                  <TD>
                    <Link
                      href={`/purchases/${row.id}`}
                      className="font-medium text-accent hover:underline"
                    >
                      {row.purchaseNo}
                    </Link>
                  </TD>
                  <TD>
                    <span className="whitespace-nowrap text-content-muted">
                      {formatDate(row.businessDate)}
                    </span>
                  </TD>
                  <TD>
                    {row.supplierName ? (
                      <Link
                        href={`/suppliers/${row.supplierId}`}
                        className="text-accent hover:underline"
                      >
                        {row.supplierName}
                      </Link>
                    ) : (
                      <span className="text-content-subtle">—</span>
                    )}
                  </TD>
                  <TD>
                    <span className="text-content-subtle">{row.invoiceNo ?? '—'}</span>
                  </TD>
                  <TD numeric>{row.itemCount}</TD>
                  <TD numeric>{money(minor(row.totalMinor), { bare: true })}</TD>
                  <TD numeric>
                    {row.outstandingMinor > 0 ? (
                      <span className="font-medium text-warning">
                        {money(minor(row.outstandingMinor), { bare: true })}
                      </span>
                    ) : (
                      <span className="text-content-subtle">—</span>
                    )}
                  </TD>
                  <TD>
                    {row.status === 'VOIDED' ? (
                      <Badge tone="danger">Voided</Badge>
                    ) : row.kind === 'RETURN' ? (
                      <Badge tone="accent">Return</Badge>
                    ) : row.kind === 'VOID' ? (
                      <Badge tone="neutral">Reversal</Badge>
                    ) : row.outstandingMinor > 0 ? (
                      <Badge tone={row.paidMinor > 0 ? 'warning' : 'danger'}>
                        {row.paidMinor > 0 ? 'Part paid' : 'Unpaid'}
                      </Badge>
                    ) : (
                      <Badge tone="success">Paid</Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </TableWrap>

          <Pagination
            basePath="/purchases"
            values={carried}
            page={page}
            pageSize={pageSize}
            total={total}
            noun="purchase"
          />
        </>
      )}

      <p className="mt-4 text-xs text-content-subtle">
        Every figure above the table is calculated from the deliveries this filter selects, and the
        CSV downloads the same set.
      </p>
    </div>
  );
}
