import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getPayablesAgeing } from '@/services/reporting/ledger.service';
import { getTotalPayables } from '@/services/supplier.service';
import { getAccountBalanceByCode } from '@/services/reporting/balances.service';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { sum } from '@/domain/money';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { PageHeader, Stat } from '@/components/ui/page';
import { AgeingTable } from '@/components/shared/ageing-table';

export const metadata: Metadata = { title: 'Who you owe' };
export const dynamic = 'force-dynamic';

export default async function PayablesPage({
  searchParams,
}: {
  searchParams: Promise<{ asAt?: string }>;
}) {
  await requirePageAccess('accounts', 'view');
  const params = await searchParams;

  const asAt = params.asAt ?? toBusinessDate();
  const rows = getPayablesAgeing(db, asAt);

  const ageingTotal = sum(rows.map((row) => row.total));
  const subledgerTotal = getTotalPayables(db);
  const controlTotal = getAccountBalanceByCode(db, ACCOUNT_CODES.ACCOUNTS_PAYABLE);
  const overdue = sum(rows.map((row) => row.over90));

  const isToday = asAt === toBusinessDate();
  const agrees = !isToday || (ageingTotal === subledgerTotal && subledgerTotal === controlTotal);

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
          label="Total you owe"
          value={money(ageingTotal)}
          tone={ageingTotal > 0 ? 'warning' : 'default'}
        />
        <Stat label="Suppliers owed" value={String(rows.length)} />
        <Stat
          label="Over 90 days"
          value={money(overdue)}
          tone={overdue > 0 ? 'danger' : 'default'}
          hint={overdue > 0 ? 'Long overdue' : 'Nothing long overdue'}
        />
      </div>

      <form action="/accounting/payables" className="mb-4 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="asAt" className="mb-1 block text-xs text-content-muted">
            As at
          </label>
          <input
            id="asAt"
            name="asAt"
            type="date"
            defaultValue={asAt}
            className="h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
          />
        </div>
        <Button type="submit" size="sm" variant="secondary">
          Apply
        </Button>
      </form>

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
