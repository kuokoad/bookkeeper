import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getGeneralLedger } from '@/services/reporting/ledger.service';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { isDomainError } from '@/domain/errors';
import { Badge } from '@/components/ui/badge';
import { DateField } from '@/components/ui/date-field';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { SOURCE_LABELS } from '../../journal/page';

export const metadata: Metadata = { title: 'Account ledger' };
export const dynamic = 'force-dynamic';

export default async function GeneralLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  await requirePageAccess('accounts', 'view');
  const { id } = await params;
  const query = await searchParams;

  const accountId = Number(id);
  if (!Number.isInteger(accountId) || accountId <= 0) notFound();

  let ledger;
  try {
    ledger = getGeneralLedger(db, accountId, {
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
    });
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const { account, lines, openingBalance, closingBalance, totalDebit, totalCredit } = ledger;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={account.name}
        description={`Account ${account.code} · ${account.type.replace('_', ' ').toLowerCase()}`}
        actions={
          <>
            <Link href="/accounting/chart">
              <Button variant="secondary" size="sm">
                Chart of accounts
              </Button>
            </Link>
            <Link href={`/accounting/journal?account=${accountId}`}>
              <Button variant="secondary" size="sm">
                Journal
              </Button>
            </Link>
          </>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Stat label="Opening" value={money(openingBalance, { bare: true })} />
        <Stat label="Debits" value={money(totalDebit, { bare: true })} />
        <Stat label="Credits" value={money(totalCredit, { bare: true })} />
        <Stat
          label="Balance"
          value={money(closingBalance)}
          tone={closingBalance < 0 ? 'danger' : 'default'}
        />
      </div>

      <form action={`/accounting/ledger/${accountId}`} className="mb-4 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="from" className="mb-1 block text-xs text-content-muted">
            From
          </label>
          <DateField
            id="from"
            name="from"
            defaultValue={query.from ?? ''}
          />
        </div>
        <div>
          <label htmlFor="to" className="mb-1 block text-xs text-content-muted">
            To
          </label>
          <DateField
            id="to"
            name="to"
            defaultValue={query.to ?? toBusinessDate()}
          />
        </div>
        <Button type="submit" size="sm" variant="secondary">
          Apply
        </Button>
        {(query.from || query.to) && (
          <Link href={`/accounting/ledger/${accountId}`}>
            <Button type="button" size="sm" variant="ghost">
              Clear
            </Button>
          </Link>
        )}
      </form>

      {lines.length === 0 ? (
        <EmptyState
          title="Nothing posted to this account"
          description="Entries appear here as soon as a transaction touches this account."
        />
      ) : (
        <TableWrap>
          <THead>
            <TH>Date</TH>
            <TH>Entry</TH>
            <TH>Kind</TH>
            <TH>Detail</TH>
            <TH numeric>Debit</TH>
            <TH numeric>Credit</TH>
            <TH numeric>Balance</TH>
          </THead>
          <tbody>
            {query.from && (
              <TR className="bg-surface-sunken">
                <TD>
                  <span className="text-content-muted">{formatDate(query.from)}</span>
                </TD>
                <TD />
                <TD />
                <TD>
                  <span className="italic text-content-muted">Opening balance</span>
                </TD>
                <TD />
                <TD />
                <TD numeric>{money(openingBalance, { bare: true })}</TD>
              </TR>
            )}
            {lines.map((line, index) => (
              <TR key={`${line.entryId}-${index}`}>
                <TD>
                  <span className="whitespace-nowrap text-content-muted">
                    {formatDate(line.entryDate)}
                  </span>
                </TD>
                <TD>
                  <Link
                    href={`/accounting/journal/${line.entryId}`}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    {line.entryNo}
                  </Link>
                </TD>
                <TD>
                  <Badge tone="neutral">
                    {SOURCE_LABELS[line.sourceType] ?? line.sourceType}
                  </Badge>
                </TD>
                <TD>
                  <span className="text-content-muted">{line.description ?? line.memo ?? '—'}</span>
                </TD>
                <TD numeric>{line.debit > 0 ? money(line.debit, { bare: true }) : '—'}</TD>
                <TD numeric>{line.credit > 0 ? money(line.credit, { bare: true }) : '—'}</TD>
                <TD numeric>
                  <span className="font-medium">{money(line.runningBalance, { bare: true })}</span>
                </TD>
              </TR>
            ))}
            <TR className="bg-surface-sunken font-semibold">
              <TD>Closing</TD>
              <TD />
              <TD />
              <TD />
              <TD numeric>{money(totalDebit, { bare: true })}</TD>
              <TD numeric>{money(totalCredit, { bare: true })}</TD>
              <TD numeric>{money(closingBalance, { bare: true })}</TD>
            </TR>
          </tbody>
        </TableWrap>
      )}

      <p className="mt-4 text-xs text-content-subtle">
        The running balance is shown the way this kind of account reads — for cash and stock a debit
        increases it; for what you owe and what you earn a credit does. Click any entry to see the
        full double entry behind it.
      </p>
    </div>
  );
}
