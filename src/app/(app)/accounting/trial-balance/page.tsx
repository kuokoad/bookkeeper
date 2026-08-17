import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getChartOfAccounts } from '@/services/reporting/ledger.service';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { minor, sum } from '@/domain/money';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata: Metadata = { title: 'Trial balance' };
export const dynamic = 'force-dynamic';

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  await requirePageAccess('accounts', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  const to = params.to ?? today;
  const from = params.from;

  const chart = getChartOfAccounts(db, {
    ...(from ? { from } : {}),
    to,
  });

  // Headings are excluded so nothing is counted twice.
  const rows = chart.filter(
    (account) => !account.isHeader && (account.totalDebit > 0 || account.totalCredit > 0),
  );

  const totalDebit = sum(rows.map((row) => row.totalDebit));
  const totalCredit = sum(rows.map((row) => row.totalCredit));
  const balanced = totalDebit === totalCredit;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Trial balance"
        description="Every account with movement, and the proof that debits equal credits."
        actions={
          <Link href="/accounting">
            <Button variant="secondary" size="sm">
              Back
            </Button>
          </Link>
        }
      />

      {balanced ? (
        <Alert tone="success" className="mb-4 no-print">
          The books balance. Total debits equal total credits exactly.
        </Alert>
      ) : (
        <Alert tone="danger" title="The books do not balance" className="mb-4">
          Debits {money(totalDebit)} do not equal credits {money(totalCredit)}. Difference{' '}
          {money(minor(totalDebit - totalCredit))}. Please report this.
        </Alert>
      )}

      <form action="/accounting/trial-balance" className="mb-4 flex flex-wrap items-end gap-2 no-print">
        <div>
          <label htmlFor="from" className="mb-1 block text-xs text-content-muted">
            From (optional)
          </label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={from ?? ''}
            className="h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
          />
        </div>
        <div>
          <label htmlFor="to" className="mb-1 block text-xs text-content-muted">
            As at
          </label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={to}
            className="h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
          />
        </div>
        <Button type="submit" size="sm" variant="secondary">
          Apply
        </Button>
      </form>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Total debits" value={money(totalDebit)} />
        <Stat label="Total credits" value={money(totalCredit)} />
        <Stat
          label="Status"
          value={balanced ? 'Balanced' : 'Out of balance'}
          tone={balanced ? 'success' : 'danger'}
        />
      </div>

      <TableWrap>
        <THead>
          <TH>Code</TH>
          <TH>Account</TH>
          <TH numeric>Debit</TH>
          <TH numeric>Credit</TH>
        </THead>
        <tbody>
          {rows.map((row) => (
            <TR key={row.id}>
              <TD>
                <span className="tabular text-xs text-content-subtle">{row.code}</span>
              </TD>
              <TD>
                <Link
                  href={`/accounting/ledger/${row.id}`}
                  className="text-accent hover:underline"
                >
                  {row.name}
                </Link>
              </TD>
              <TD numeric>{row.totalDebit > 0 ? money(row.totalDebit, { bare: true }) : '—'}</TD>
              <TD numeric>{row.totalCredit > 0 ? money(row.totalCredit, { bare: true }) : '—'}</TD>
            </TR>
          ))}
          <TR className="bg-surface-sunken font-semibold">
            <TD />
            <TD>Total</TD>
            <TD numeric>{money(totalDebit, { bare: true })}</TD>
            <TD numeric>{money(totalCredit, { bare: true })}</TD>
          </TR>
        </tbody>
      </TableWrap>

      <p className="mt-4 text-xs text-content-subtle">
        {from ? `${formatDate(from)} to ${formatDate(to)}` : `Everything up to ${formatDate(to)}`}.
        This lists the raw debit and credit totals per account — the check that the double entry
        holds. For what the shop is worth, see the balance sheet.
      </p>
    </div>
  );
}
