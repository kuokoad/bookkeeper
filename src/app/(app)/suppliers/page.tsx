import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getTotalPayables, listSuppliers } from '@/services/supplier.service';
import { money } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata: Metadata = { title: 'Suppliers' };
export const dynamic = 'force-dynamic';

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; owing?: string }>;
}) {
  const user = await requirePageAccess('suppliers', 'view');
  const params = await searchParams;

  const suppliers = listSuppliers(db, {
    ...(params.q ? { search: params.q } : {}),
    owingOnly: params.owing === '1',
  });
  const payables = getTotalPayables(db);
  const owingCount = listSuppliers(db, { owingOnly: true }).length;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Suppliers"
        description="Who you buy from, and what you owe them."
        actions={
          can(user, 'suppliers', 'create') ? (
            <Link href="/suppliers/new">
              <Button size="sm">Add supplier</Button>
            </Link>
          ) : null
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Suppliers" value={String(suppliers.length)} />
        <Stat
          label="Total you owe"
          value={money(payables)}
          tone={payables > 0 ? 'warning' : 'default'}
          hint="Accounts payable"
        />
        <Stat label="Suppliers owed" value={String(owingCount)} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form action="/suppliers" className="flex gap-2">
          <label htmlFor="q" className="sr-only">
            Search suppliers
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={params.q ?? ''}
            placeholder="Search name or phone"
            className="h-10 w-56 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
          />
          <Button type="submit" size="sm" variant="secondary">
            Search
          </Button>
        </form>
        <Link href={params.owing === '1' ? '/suppliers' : '/suppliers?owing=1'}>
          <Button size="sm" variant={params.owing === '1' ? 'primary' : 'secondary'}>
            Owed only
          </Button>
        </Link>
      </div>

      {suppliers.length === 0 ? (
        <EmptyState
          title={params.q || params.owing ? 'No suppliers match' : 'No suppliers yet'}
          description={
            params.q || params.owing
              ? 'Try a different search or clear the filter.'
              : 'Add the people and businesses you buy stock from, so purchases and what you owe can be tracked.'
          }
          action={
            can(user, 'suppliers', 'create') && !params.q ? (
              <Link href="/suppliers/new">
                <Button>Add your first supplier</Button>
              </Link>
            ) : null
          }
        />
      ) : (
        <TableWrap>
          <THead>
            <TH>Supplier</TH>
            <TH>Contact</TH>
            <TH>Phone</TH>
            <TH numeric>You owe</TH>
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
      )}

      <p className="mt-4 text-xs text-content-subtle">
        What you owe is calculated from the accounts-payable entries tagged to each supplier, so
        this total always equals the payables figure on the balance sheet.
      </p>
    </div>
  );
}
