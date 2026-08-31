import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { countSales, getFilteredSalesSummary, listSales } from '@/services/sale.service';
import { listCategories, listProductOptions } from '@/services/catalog.service';
import { listCustomerOptions } from '@/services/customer.service';
import { listPaymentAccountOptions } from '@/services/payment-account.service';
import { listUsers } from '@/services/user.service';
import { formatDate, formatTime, money, quantity, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import {
  buildQuery,
  chipAmount,
  clampPage,
  describeDateRange,
  type ActiveFilter,
} from '@/lib/filters';
import { parseSalesFilters, type SearchParams } from '@/lib/list-filters';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { FilterBar } from '@/components/shared/filter-bar';
import { Pagination, SortLink } from '@/components/shared/pagination';

export const metadata: Metadata = { title: 'Sales' };
export const dynamic = 'force-dynamic';

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePageAccess('sales', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  // The same parser the CSV route uses, so the file can never hold a different
  // set of sales from the screen it was downloaded from.
  const { filters, range, preset, page: requestedPage, pageSize, carried } =
    parseSalesFilters(params, today);

  /*
    Options come from the shop's own records, so a filter can only ever offer a
    value that exists. A dropdown listing a customer who was never sold to is a
    dead end the owner has to discover by trying it.
  */
  const customers = listCustomerOptions(db, true);
  const categories = listCategories(db);
  const products = listProductOptions(db, true);
  const accounts = listPaymentAccountOptions(db, true);
  const staff = listUsers(db);

  const minAmount = filters.minAmount;
  const maxAmount = filters.maxAmount;
  const sort = filters.sort ?? 'date';
  const direction = filters.direction ?? 'desc';

  /*
    Count first, then clamp. Filtering 1,000 sales down to 27 while the URL
    still says page 4 would otherwise show an empty table under a pager
    insisting there are results.
  */
  const total = countSales(db, filters);
  const page = clampPage(requestedPage, total, pageSize);

  const rows = listSales(db, { ...filters, limit: pageSize, offset: (page - 1) * pageSize });

  // The same filters that chose the rows, so the figures describe the table.
  const summary = getFilteredSalesSummary(db, filters);

  // --- what the chips say --------------------------------------------------

  const nameOf = <T extends { id: number; name?: string; displayName?: string }>(
    list: T[],
    id: number | undefined,
  ): string | undefined =>
    id === undefined
      ? undefined
      : (list.find((item) => item.id === id)?.name ??
        list.find((item) => item.id === id)?.displayName);

  const METHOD_LABELS: Record<string, string> = {
    CASH: 'Cash',
    MOBILE_MONEY: 'Mobile money',
    BANK: 'Bank',
    OTHER: 'Other',
  };

  const active: ActiveFilter[] = [];
  if (filters.search) active.push({ key: 'q', label: 'Search', value: filters.search });
  if (filters.customerId !== undefined) {
    active.push({
      key: 'customer',
      label: 'Customer',
      value: nameOf(customers, filters.customerId) ?? String(filters.customerId),
    });
  }
  if (filters.productId !== undefined) {
    active.push({
      key: 'product',
      label: 'Product',
      value: nameOf(products, filters.productId) ?? String(filters.productId),
    });
  }
  if (filters.categoryId !== undefined) {
    active.push({
      key: 'category',
      label: 'Category',
      value: nameOf(categories, filters.categoryId) ?? String(filters.categoryId),
    });
  }
  if (filters.paymentAccountId !== undefined) {
    active.push({
      key: 'account',
      label: 'Paid into',
      value: nameOf(accounts, filters.paymentAccountId) ?? String(filters.paymentAccountId),
    });
  }
  if (filters.paymentKind !== undefined) {
    active.push({ key: 'method', label: 'Method', value: METHOD_LABELS[filters.paymentKind] ?? '' });
  }
  if (filters.staffId !== undefined) {
    active.push({
      key: 'staff',
      label: 'Served by',
      value: nameOf(staff, filters.staffId) ?? String(filters.staffId),
    });
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
      value: filters.paymentState === 'unpaid' ? 'Still owing' : 'Settled',
    });
  }
  if (minAmount !== undefined || maxAmount !== undefined) {
    active.push({
      key: 'min',
      label: 'Amount',
      value:
        minAmount !== undefined && maxAmount !== undefined
          ? `${chipAmount(minAmount)} – ${chipAmount(maxAmount)}`
          : minAmount !== undefined
            ? `over ${chipAmount(minAmount)}`
            : `under ${chipAmount(maxAmount!)}`,
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

  /* The export carries the filters, so the file matches what is on screen. */
  const exportHref = `/api/exports/sales${buildQuery(carried)}`;
  const isFiltered = active.length > 0;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Sales"
        description="Every sale, what it earned and what is still owed."
        actions={
          <>
            <a href={exportHref} download>
              <Button variant="secondary" size="sm" type="button">
                Download CSV
              </Button>
            </a>
            {can(user, 'sales', 'create') ? (
              <Link href="/sales/new">
                <Button size="sm">New sale</Button>
              </Link>
            ) : null}
          </>
        }
      />

      {/*
        These are the FILTERED figures, not the shop's month to date. Narrow to
        cash sales in the first fortnight and every one of them narrows with the
        table — a filtered list under unfiltered totals is a page that lies.
      */}
      {/*
        The three an owner opens this page for, at reading size; the three that
        explain them, beneath. Both rows are the same card — only the figure
        changes size — so a glance still takes them in as one set of totals.

        The notes say nothing that needs its own sum. A margin percentage was
        the obvious one to add and is the reason there isn't one: `revenue` is
        SUM(total_minor), and the schema's own CHECK has total = subtotal -
        discount + tax, so profit over revenue would divide by a tax-inclusive
        figure and quietly understate the margin on every taxed sale.
      */}
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <Stat
          label="Revenue" icon="income"
          value={money(summary.revenue)}
          hint={
            summary.outstanding > 0
              ? `${money(summary.outstanding, { bare: true })} still owing`
              : summary.count > 0
                ? 'All settled'
                : undefined
          }
        />
        <Stat
          label="Gross profit" icon="profit"
          value={money(summary.grossProfit, { bare: true })}
          tone={summary.grossProfit < 0 ? 'danger' : 'success'}
          hint="Revenue less ledger cost"
        />
        <Stat
          label="Sales" icon="sales"
          value={String(summary.count)}
          hint={describeDateRange(range, preset, today)}
        />
      </div>

      <div className="mb-6 grid grid-cols-3 gap-3">
        <Stat size="compact" label="Items sold" icon="products" value={quantity(summary.quantity)} />
        <Stat size="compact" label="Discount" icon="discount" value={money(summary.discount, { bare: true })} />
        <Stat size="compact" label="Cost of goods" icon="expenses" value={money(summary.cogs, { bare: true })} />
      </div>

      <FilterBar
        basePath="/sales"
        dateRange={{ preset, from: range.from, to: range.to }}
        active={active}
        quick={[
          { label: "Today's sales", params: { period: 'today', from: null, to: null }, match: { period: 'today' } },
          { label: 'Credit sales', params: { paid: 'unpaid' }, match: { paid: 'unpaid' } },
          { label: 'Cash sales', params: { method: 'CASH' }, match: { method: 'CASH' } },
          { label: 'MoMo sales', params: { method: 'MOBILE_MONEY' }, match: { method: 'MOBILE_MONEY' } },
          { label: 'Voided', params: { status: 'VOIDED' }, match: { status: 'VOIDED' } },
        ]}
        fields={[
          {
            kind: 'search',
            key: 'q',
            label: 'Search',
            placeholder: 'Receipt, customer, phone, product or SKU',
            wide: true,
          },
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
            label: 'Paid into',
            allLabel: 'Any account',
            options: accounts.map((item) => ({ value: String(item.id), label: item.name })),
          },
          {
            kind: 'select',
            key: 'staff',
            label: 'Served by',
            allLabel: 'Anyone',
            options: staff.map((item) => ({ value: String(item.id), label: item.displayName })),
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
          title={isFiltered ? 'No sales match these filters' : 'No sales in this period'}
          description={
            isFiltered
              ? 'Try widening the dates, or clear a filter to see more.'
              : 'Sales you record will appear here with their profit and any balance still owing.'
          }
          action={
            can(user, 'sales', 'create') && !isFiltered ? (
              <Link href="/sales/new">
                <Button>Record a sale</Button>
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
                  basePath="/sales"
                  values={carried}
                  column="receipt"
                  activeSort={sort}
                  activeDirection={direction}
                  defaultDirection="asc"
                >
                  Receipt
                </SortLink>
              </TH>
              <TH>
                <SortLink
                  basePath="/sales"
                  values={carried}
                  column="date"
                  activeSort={sort}
                  activeDirection={direction}
                >
                  When
                </SortLink>
              </TH>
              <TH>
                <SortLink
                  basePath="/sales"
                  values={carried}
                  column="customer"
                  activeSort={sort}
                  activeDirection={direction}
                  defaultDirection="asc"
                >
                  Customer
                </SortLink>
              </TH>
              <TH numeric>Items</TH>
              <TH numeric>
                <SortLink
                  basePath="/sales"
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
                  basePath="/sales"
                  values={carried}
                  column="profit"
                  activeSort={sort}
                  activeDirection={direction}
                >
                  Profit
                </SortLink>
              </TH>
              <TH numeric>Owing</TH>
              <TH>Status</TH>
            </THead>
            <tbody>
              {rows.map((row) => (
                <TR key={row.id}>
                  <TD>
                    <Link
                      href={`/sales/${row.id}`}
                      className="font-medium text-accent hover:underline"
                    >
                      {row.receiptNo}
                    </Link>
                  </TD>
                  <TD>
                    <span className="whitespace-nowrap text-content-muted">
                      {formatDate(row.businessDate)} {formatTime(row.occurredAt)}
                    </span>
                  </TD>
                  <TD>
                    {row.customerName ? (
                      <Link
                        href={`/customers/${row.customerId}`}
                        className="text-accent hover:underline"
                      >
                        {row.customerName}
                      </Link>
                    ) : (
                      <span className="text-content-subtle">Walk-in</span>
                    )}
                    {row.staffName && (
                      <span className="block text-xs text-content-subtle">{row.staffName}</span>
                    )}
                  </TD>
                  <TD numeric>{row.itemCount}</TD>
                  <TD numeric>{money(minor(row.totalMinor), { bare: true })}</TD>
                  <TD numeric>
                    <span className={row.profitMinor < 0 ? 'text-danger' : ''}>
                      {money(minor(row.profitMinor), { bare: true })}
                    </span>
                  </TD>
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
                    ) : row.voidsSaleId !== null ? (
                      <Badge tone="neutral">Reversal</Badge>
                    ) : row.outstandingMinor > 0 ? (
                      <Badge tone="warning">Credit</Badge>
                    ) : (
                      <Badge tone="success">Paid</Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </TableWrap>

          <Pagination
            basePath="/sales"
            values={carried}
            page={page}
            pageSize={pageSize}
            total={total}
            noun="sale"
          />
        </>
      )}

      <p className="mt-4 text-xs text-content-subtle">
        Profit is revenue less the cost the goods actually carried when they were sold, taken from
        the stock ledger — not from today&rsquo;s cost price. Every figure above the table is
        calculated from the sales this filter selects, and the CSV downloads the same set.
      </p>
    </div>
  );
}
