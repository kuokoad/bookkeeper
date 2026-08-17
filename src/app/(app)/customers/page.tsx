import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getTotalReceivables, listCustomers } from '@/services/customer.service';
import { money } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata: Metadata = { title: 'Customers' };
export const dynamic = 'force-dynamic';

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; owing?: string }>;
}) {
  const user = await requirePageAccess('customers', 'view');
  const params = await searchParams;

  const customers = listCustomers(db, {
    ...(params.q ? { search: params.q } : {}),
    owingOnly: params.owing === '1',
  });

  const totalOwed = getTotalReceivables(db);
  const owingCount = listCustomers(db, { owingOnly: true }).length;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Customers"
        description="Who buys from you, and who owes you money."
        actions={
          can(user, 'customers', 'create') ? (
            <Link href="/customers/new">
              <Button size="sm">Add customer</Button>
            </Link>
          ) : null
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Customers" value={String(customers.length)} />
        <Stat
          label="Total owed to you"
          value={money(totalOwed)}
          tone={totalOwed > 0 ? 'warning' : 'default'}
          hint="Accounts receivable"
        />
        <Stat label="Customers owing" value={String(owingCount)} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form action="/customers" className="flex gap-2">
          <label htmlFor="q" className="sr-only">
            Search customers
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
        <Link href={params.owing === '1' ? '/customers' : '/customers?owing=1'}>
          <Button size="sm" variant={params.owing === '1' ? 'primary' : 'secondary'}>
            Owing only
          </Button>
        </Link>
      </div>

      {customers.length === 0 ? (
        <EmptyState
          title={params.q || params.owing ? 'No customers match' : 'No customers yet'}
          description={
            params.q || params.owing
              ? 'Try a different search or clear the filter.'
              : 'Add a customer when you need to sell on credit or keep a record of who bought what. Walk-in cash sales do not need one.'
          }
          action={
            can(user, 'customers', 'create') && !params.q ? (
              <Link href="/customers/new">
                <Button>Add your first customer</Button>
              </Link>
            ) : null
          }
        />
      ) : (
        <TableWrap>
          <THead>
            <TH>Customer</TH>
            <TH>Phone</TH>
            <TH numeric>Owes</TH>
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
      )}

      <p className="mt-4 text-xs text-content-subtle">
        What a customer owes is calculated from the accounts-receivable entries tagged to them, so
        this total always equals the receivables figure on the balance sheet.
      </p>
    </div>
  );
}
