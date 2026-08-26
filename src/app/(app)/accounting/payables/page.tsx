import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getPayablesAgeing } from '@/services/reporting/ledger.service';
import { getTotalPayables, listSuppliers } from '@/services/supplier.service';
import { getAccountBalanceByCode } from '@/services/reporting/balances.service';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { sum } from '@/domain/money';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { PageHeader, Stat } from '@/components/ui/page';
import { AgeingTable } from '@/components/shared/ageing-table';
import { FilterBar } from '@/components/shared/filter-bar';
import { parseDate, parseEnum, parseId, type ActiveFilter } from '@/lib/filters';
import type { SearchParams } from '@/lib/list-filters';

export const metadata: Metadata = { title: 'Who you owe' };
export const dynamic = 'force-dynamic';

export default async function PayablesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePageAccess('accounts', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  const asAt = parseDate(typeof params.asAt === 'string' ? params.asAt : undefined) ?? today;
  const supplierId = parseId(typeof params.supplier === 'string' ? params.supplier : undefined);
  const status = parseEnum(
    typeof params.status === 'string' ? params.status : undefined,
    ['overdue', 'current'] as const,
  );

  const all = getPayablesAgeing(db, asAt);

  /*
    The ledger check runs against the WHOLE report, before any narrowing —
    comparing one supplier's balance with the Accounts Payable control account
    would raise a false alarm the moment somebody looked at one supplier.
  */
  const ageingTotal = sum(all.map((row) => row.total));
  const subledgerTotal = getTotalPayables(db);
  const controlTotal = getAccountBalanceByCode(db, ACCOUNT_CODES.ACCOUNTS_PAYABLE);

  const isToday = asAt === today;
  const agrees = !isToday || (ageingTotal === subledgerTotal && subledgerTotal === controlTotal);

  const rows = all.filter((row) => {
    if (supplierId !== undefined && row.partyId !== supplierId) return false;
    if (status === 'overdue' && row.over90 <= 0) return false;
    if (status === 'current' && row.over90 > 0) return false;
    return true;
  });

  const overdue = sum(rows.map((row) => row.over90));
  const shown = sum(rows.map((row) => row.total));
  const suppliers = listSuppliers(db, { balanceState: 'owing', limit: 500 });

  const active: ActiveFilter[] = [];
  if (supplierId !== undefined) {
    active.push({
      key: 'supplier',
      label: 'Supplier',
      value: all.find((row) => row.partyId === supplierId)?.partyName ?? String(supplierId),
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
        title="Who you owe"
        description="Supplier balances, grouped by how long they have been outstanding."
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
          The ageing adds to {money(ageingTotal)}, supplier balances add to {money(subledgerTotal)},
          and the Accounts Payable account holds {money(controlTotal)}. These three must match.
          Please report this.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat
          label={active.length > 0 ? 'Owed, as filtered' : 'Total you owe'}
          value={money(shown)}
          tone={shown > 0 ? 'warning' : 'default'}
          {...(active.length > 0 ? { hint: `of ${money(ageingTotal)} in total` } : {})}
        />
        <Stat label="Suppliers owed" value={String(rows.length)} />
        <Stat
          label="Over 90 days"
          value={money(overdue)}
          tone={overdue > 0 ? 'danger' : 'default'}
          hint={overdue > 0 ? 'Long overdue' : 'Nothing long overdue'}
        />
      </div>

      <FilterBar
        basePath="/accounting/payables"
        active={active}
        quick={[
          { label: 'Over 90 days', params: { status: 'overdue' }, match: { status: 'overdue' } },
        ]}
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
        hrefBase="/suppliers"
        nameHeading="Supplier"
        emptyTitle="You do not owe anyone"
        emptyDescription="Purchases that have not been fully paid will appear here, grouped by age."
      />

      <p className="mt-4 text-xs text-content-subtle">
        As at {formatDate(asAt)}. Age is measured from the date of each delivery. These figures come
        from the same records as each supplier&rsquo;s profile, so the two always agree.
      </p>
    </div>
  );
}
