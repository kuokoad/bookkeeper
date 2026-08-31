import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { countCustomers, getTotalReceivables, listCustomers } from '@/services/customer.service';
import { money } from '@/lib/format';
import { buildQuery, clampPage, type ActiveFilter } from '@/lib/filters';
import { parseCustomerFilters, type SearchParams } from '@/lib/list-filters';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { FilterBar } from '@/components/shared/filter-bar';
import { Pagination, SortLink } from '@/components/shared/pagination';

export const metadata: Metadata = { title: 'Customers' };
export const dynamic = 'force-dynamic';

const BALANCE_LABELS: Record<string, string> = {
  owing: 'Owes money',
  zero: 'Nothing owing',
  credit: 'In credit',
};

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePageAccess('customers', 'view');
  const params = await searchParams;

  const { filters, page: requestedPage, pageSize, carried } = parseCustomerFilters(params);

  const total = countCustomers(db, filters);
  const page = clampPage(requestedPage, total, pageSize);
  const customers = listCustomers(db, {
    ...filters,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  /*
    The shop-wide figures, deliberately not filtered: "total owed to you" must
    equal the receivables line on the balance sheet whatever the owner is
    searching for. `owingCount` is a COUNT, not a page length — it used to be
    `listCustomers(...).length`, which stopped at the page size and so quietly
    under-reported how many people owed the shop money.
  */
  const totalOwed = getTotalReceivables(db);
  const owingCount = countCustomers(db, { balanceState: 'owing' });

  const sort = filters.sort ?? 'name';
  const direction = filters.direction ?? 'asc';

  const active: ActiveFilter[] = [];
  if (filters.search) active.push({ key: 'q', label: 'Search', value: filters.search });
  if (filters.balanceState !== undefined) {
    active.push({
      key: 'balance',
      label: 'Balance',
      value: BALANCE_LABELS[filters.balanceState] ?? '',
    });
  }
  if (filters.customerStatus !== undefined) {
    active.push({
      key: 'archived',
      label: 'Status',
      value: filters.customerStatus === 'archived' ? 'Archived' : 'Active',
    });
  }

  const isFiltered = active.length > 0;
  const exportHref = `/api/exports/customers${buildQuery(carried)}`;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Customers"
        description="Who buys from you, and who owes you money."
        actions={
          <>
            <a href={exportHref} download>
              <Button variant="secondary" size="sm" type="button">
                Download CSV
              </Button>
            </a>
            {can(user, 'customers', 'create') ? (
              <Link href="/customers/new">
                <Button size="sm">Add customer</Button>
              </Link>
            ) : null}
          </>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Customers" icon="customers" value={String(countCustomers(db))} />
        <Stat
          label="Total owed to you" icon="owed"
          value={money(totalOwed)}
          tone={totalOwed > 0 ? 'warning' : 'default'}
          hint="Accounts receivable"
        />
        <Stat label="Customers owing" icon="owed" value={String(owingCount)} />
      </div>

      <FilterBar
        basePath="/customers"
        active={active}
        quick={[
          { label: 'Customers who owe', params: { balance: 'owing' }, match: { balance: 'owing' } },
          { label: 'Nothing owing', params: { balance: 'zero' }, match: { balance: 'zero' } },
          { label: 'Archived', params: { archived: 'archived' }, match: { archived: 'archived' } },
        ]}
        fields={[
          {
            kind: 'search',
            key: 'q',
            label: 'Search',
            placeholder: 'Name, phone or email',
            wide: true,
          },
          {
            kind: 'select',
            key: 'balance',
            label: 'Balance',
            allLabel: 'Any balance',
            options: [
              { value: 'owing', label: 'Owes money' },
              { value: 'zero', label: 'Nothing owing' },
              { value: 'credit', label: 'In credit' },
            ],
          },
          {
            kind: 'select',
            key: 'archived',
            label: 'Status',
            allLabel: 'Active only',
            options: [
              { value: 'active', label: 'Active' },
              { value: 'archived', label: 'Archived' },
            ],
          },
        ]}
      />

      {customers.length === 0 ? (
        <EmptyState
          title={isFiltered ? 'No customers match' : 'No customers yet'}
          description={
            isFiltered
              ? 'Try a different search or clear the filter.'
              : 'Add a customer when you need to sell on credit or keep a record of who bought what. Walk-in cash sales do not need one.'
          }
          action={
            can(user, 'customers', 'create') && !isFiltered ? (
              <Link href="/customers/new">
                <Button>Add your first customer</Button>
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
                  basePath="/customers"
                  values={carried}
                  column="name"
                  activeSort={sort}
                  activeDirection={direction}
                  defaultDirection="asc"
                >
                  Customer
                </SortLink>
              </TH>
              <TH>Phone</TH>
              <TH numeric>
                <SortLink
                  basePath="/customers"
                  values={carried}
                  column="balance"
                  activeSort={sort}
                  activeDirection={direction}
                >
                  Owes
                </SortLink>
              </TH>
              <TH numeric>Credit limit</TH>
              <TH>Status</TH>
            </THead>
            <tbody>
              {customers.map((customer) => (
                <TR key={customer.id}>
                  <TD>
                    <Link
                      href={`/customers/${customer.id}`}
                      className="font-medium text-accent hover:underline"
                    >
                      {customer.name}
                    </Link>
                  </TD>
                  <TD>
                    <span className="text-content-muted">{customer.phone ?? '—'}</span>
                  </TD>
                  <TD numeric>
                    {customer.balance > 0 ? (
                      <span className="font-medium text-warning">
                        {money(customer.balance, { bare: true })}
                      </span>
                    ) : (
                      <span className="text-content-subtle">—</span>
                    )}
                  </TD>
                  <TD numeric>
                    {customer.creditLimit === null ? (
                      <span className="text-content-subtle">No limit</span>
                    ) : (
                      money(customer.creditLimit, { bare: true })
                    )}
                  </TD>
                  <TD>
                    {!customer.isActive ? (
                      <Badge tone="neutral">Archived</Badge>
                    ) : customer.overLimit ? (
                      <Badge tone="danger">Over limit</Badge>
                    ) : customer.balance > 0 ? (
                      <Badge tone="warning">Owing</Badge>
                    ) : (
                      <Badge tone="success">Clear</Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </TableWrap>

          <Pagination
            basePath="/customers"
            values={carried}
            page={page}
            pageSize={pageSize}
            total={total}
            noun="customer"
          />
        </>
      )}

      <p className="mt-4 text-xs text-content-subtle">
        What a customer owes is calculated from the accounts-receivable entries tagged to them, so
        this total always equals the receivables figure on the balance sheet — and so does the
        &ldquo;Customers who owe&rdquo; filter.
      </p>
    </div>
  );
}
