import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { countSuppliers, getTotalPayables, listSuppliers } from '@/services/supplier.service';
import { money } from '@/lib/format';
import { buildQuery, clampPage, type ActiveFilter } from '@/lib/filters';
import { parseSupplierFilters, type SearchParams } from '@/lib/list-filters';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { FilterBar } from '@/components/shared/filter-bar';
import { Pagination, SortLink } from '@/components/shared/pagination';

export const metadata: Metadata = { title: 'Suppliers' };
export const dynamic = 'force-dynamic';

const BALANCE_LABELS: Record<string, string> = {
  owing: 'We owe them',
  zero: 'Nothing owing',
  credit: 'They owe us',
};

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePageAccess('suppliers', 'view');
  const params = await searchParams;

  const { filters, page: requestedPage, pageSize, carried } = parseSupplierFilters(params);

  const total = countSuppliers(db, filters);
  const page = clampPage(requestedPage, total, pageSize);
  const suppliers = listSuppliers(db, {
    ...filters,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  // Shop-wide, so the total always equals the payables line on the balance
  // sheet. `owedCount` is a COUNT rather than a page length, which is what it
  // used to be — and so used to stop at the page size.
  const payables = getTotalPayables(db);
  const owedCount = countSuppliers(db, { balanceState: 'owing' });

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
  if (filters.supplierStatus !== undefined) {
    active.push({
      key: 'archived',
      label: 'Status',
      value: filters.supplierStatus === 'archived' ? 'Archived' : 'Active',
    });
  }

  const isFiltered = active.length > 0;
  const exportHref = `/api/exports/suppliers${buildQuery(carried)}`;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Suppliers"
        description="Who you buy from, and what you owe them."
        actions={
          <>
            <a href={exportHref} download>
              <Button variant="secondary" size="sm" type="button">
                Download CSV
              </Button>
            </a>
            {can(user, 'suppliers', 'create') ? (
              <Link href="/suppliers/new">
                <Button size="sm">Add supplier</Button>
              </Link>
            ) : null}
          </>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Suppliers" value={String(countSuppliers(db))} />
        <Stat
          label="Total you owe"
          value={money(payables)}
          tone={payables > 0 ? 'warning' : 'default'}
          hint="Accounts payable"
        />
        <Stat label="Suppliers owed" value={String(owedCount)} />
      </div>

      <FilterBar
        basePath="/suppliers"
        active={active}
        quick={[
          { label: 'Suppliers we owe', params: { balance: 'owing' }, match: { balance: 'owing' } },
          { label: 'Nothing owing', params: { balance: 'zero' }, match: { balance: 'zero' } },
          { label: 'Archived', params: { archived: 'archived' }, match: { archived: 'archived' } },
        ]}
        fields={[
          {
            kind: 'search',
            key: 'q',
            label: 'Search',
            placeholder: 'Name, contact, phone or email',
            wide: true,
          },
          {
            kind: 'select',
            key: 'balance',
            label: 'Balance',
            allLabel: 'Any balance',
            options: [
              { value: 'owing', label: 'We owe them' },
              { value: 'zero', label: 'Nothing owing' },
              { value: 'credit', label: 'They owe us' },
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

      {suppliers.length === 0 ? (
        <EmptyState
          title={isFiltered ? 'No suppliers match' : 'No suppliers yet'}
          description={
            isFiltered
              ? 'Try a different search or clear the filter.'
              : 'Add the people and businesses you buy stock from, so purchases and what you owe can be tracked.'
          }
          action={
            can(user, 'suppliers', 'create') && !isFiltered ? (
              <Link href="/suppliers/new">
                <Button>Add your first supplier</Button>
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
                  basePath="/suppliers"
                  values={carried}
                  column="name"
                  activeSort={sort}
                  activeDirection={direction}
                  defaultDirection="asc"
                >
                  Supplier
                </SortLink>
              </TH>
              <TH>Contact</TH>
              <TH>Phone</TH>
              <TH numeric>
                <SortLink
                  basePath="/suppliers"
                  values={carried}
                  column="balance"
                  activeSort={sort}
                  activeDirection={direction}
                >
                  You owe
                </SortLink>
              </TH>
              <TH>Status</TH>
            </THead>
            <tbody>
              {suppliers.map((supplier) => (
                <TR key={supplier.id}>
                  <TD>
                    <Link
                      href={`/suppliers/${supplier.id}`}
                      className="font-medium text-accent hover:underline"
                    >
                      {supplier.name}
                    </Link>
                  </TD>
                  <TD>
                    <span className="text-content-muted">{supplier.contactPerson ?? '—'}</span>
                  </TD>
                  <TD>
                    <span className="text-content-muted">{supplier.phone ?? '—'}</span>
                  </TD>
                  <TD numeric>
                    {supplier.balance > 0 ? (
                      <span className="font-medium text-warning">
                        {money(supplier.balance, { bare: true })}
                      </span>
                    ) : (
                      <span className="text-content-subtle">—</span>
                    )}
                  </TD>
                  <TD>
                    {!supplier.isActive ? (
                      <Badge tone="neutral">Archived</Badge>
                    ) : supplier.balance > 0 ? (
                      <Badge tone="warning">Owed</Badge>
                    ) : (
                      <Badge tone="success">Clear</Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </TableWrap>

          <Pagination
            basePath="/suppliers"
            values={carried}
            page={page}
            pageSize={pageSize}
            total={total}
            noun="supplier"
          />
        </>
      )}

      <p className="mt-4 text-xs text-content-subtle">
        What you owe is calculated from the accounts-payable entries tagged to each supplier, so
        this total always equals the payables figure on the balance sheet — and so does the
        &ldquo;Suppliers we owe&rdquo; filter.
      </p>
    </div>
  );
}
