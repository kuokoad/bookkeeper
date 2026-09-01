import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getReceivablesAgeing } from '@/services/reporting/ledger.service';
import { getTotalReceivables } from '@/services/customer.service';
import { getAccountBalanceByCode } from '@/services/reporting/balances.service';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { sum } from '@/domain/money';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { PageHeader, Stat } from '@/components/ui/page';
import { AgeingTable } from '@/components/shared/ageing-table';
import { FilterBar } from '@/components/shared/filter-bar';
import { listCustomers } from '@/services/customer.service';
import { parseDate, parseEnum, parseId, type ActiveFilter } from '@/lib/filters';
import type { SearchParams } from '@/lib/list-filters';

export const metadata: Metadata = { title: 'Who owes you' };
export const dynamic = 'force-dynamic';

export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePageAccess('accounts', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  const asAt = parseDate(typeof params.asAt === 'string' ? params.asAt : undefined) ?? today;
  const customerId = parseId(typeof params.customer === 'string' ? params.customer : undefined);
  const status = parseEnum(
    typeof params.status === 'string' ? params.status : undefined,
    ['overdue', 'current'] as const,
  );

  const all = getReceivablesAgeing(db, asAt);

  /*
    The ledger check is run against the WHOLE report, before any narrowing.
    Comparing one customer's debt with the Accounts Receivable control account
    would raise a false alarm every time somebody looked at one customer.
  */
  const ageingTotal = sum(all.map((row) => row.total));
  const subledgerTotal = getTotalReceivables(db);
  const controlTotal = getAccountBalanceByCode(db, ACCOUNT_CODES.ACCOUNTS_RECEIVABLE);

  // Only meaningful when looking at today — an "as at" date in the past will
  // legitimately differ from the live control account.
  const isToday = asAt === today;
  const agrees = !isToday || (ageingTotal === subledgerTotal && subledgerTotal === controlTotal);

  /*
    The ageing is one row per customer, so it is narrowed here rather than in
    SQL: the query already walks every unpaid sale to build the buckets, and
    filtering afterwards keeps the buckets exactly as the report computed them.
  */
  const rows = all.filter((row) => {
    if (customerId !== undefined && row.partyId !== customerId) return false;
    if (status === 'overdue' && row.over90 <= 0) return false;
    if (status === 'current' && row.over90 > 0) return false;
    return true;
  });

  const overdue = sum(rows.map((row) => row.over90));
  const shown = sum(rows.map((row) => row.total));
  const customers = listCustomers(db, { balanceState: 'owing', limit: 500 });

  const active: ActiveFilter[] = [];
  if (customerId !== undefined) {
    active.push({
      key: 'customer',
      label: 'Customer',
      value: all.find((row) => row.partyId === customerId)?.partyName ?? String(customerId),
    });
  }
  if (status !== undefined) {
    active.push({
      key: 'status',
      label: 'Outstanding',
      value: status === 'overdue' ? 'Over 90 days' : 'Within 90 days',
    });
  }
  if (asAt !== today) {
    active.push({ key: 'asAt', label: 'As at', value: formatDate(asAt) });
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Who owes you"
        description="Customer debts, grouped by how long they have been outstanding."
        actions={
          <Link href="/accounting">
            <Button variant="secondary" size="sm">
              Back to accounting
            </Button>
          </Link>
        }
      />

      {!agrees && (
        <Alert tone="danger" title="This report does not agree with the ledger" className="mb-4">
          The ageing adds to {money(ageingTotal)}, customer balances add to {money(subledgerTotal)},
          and the Accounts Receivable account holds {money(controlTotal)}. These three must match.
          Please report this.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat
          icon="owed"
          label={active.length > 0 ? 'Owed, as filtered' : 'Total owed to you'}
          value={money(shown)}
          tone={shown > 0 ? 'warning' : 'default'}
          {...(active.length > 0 ? { hint: `of ${money(ageingTotal)} in total` } : {})}
        />
        <Stat icon="customers" label="Customers owing" value={String(rows.length)} />
        <Stat
          icon="warning"
          label="Over 90 days"
          value={money(overdue)}
          tone={overdue > 0 ? 'danger' : 'default'}
          hint={overdue > 0 ? 'Worth chasing' : 'Nothing long overdue'}
        />
      </div>

      <FilterBar
        basePath="/accounting/receivables"
        active={active}
        quick={[
          { label: 'Over 90 days', params: { status: 'overdue' }, match: { status: 'overdue' } },
        ]}
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
            key: 'status',
            label: 'Outstanding',
            allLabel: 'Any age',
            options: [
              { value: 'overdue', label: 'Over 90 days' },
              { value: 'current', label: 'Within 90 days' },
            ],
          },
          { kind: 'date', key: 'asAt', label: 'As at' },
        ]}
      />

      <AgeingTable
        rows={rows}
        hrefBase="/customers"
        nameHeading="Customer"
        emptyTitle="Nobody owes you anything"
        emptyDescription="Credit sales that have not been fully paid will appear here, grouped by age."
      />

      <p className="mt-4 text-xs text-content-subtle">
        As at {formatDate(asAt)}. Age is measured from the date of each sale. These figures come
        from the same records as each customer&rsquo;s profile, so the two always agree.
      </p>
    </div>
  );
}
