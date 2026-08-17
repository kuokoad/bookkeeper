import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getJournalEntry } from '@/services/reporting/ledger.service';
import { formatDate, formatDateTime, money } from '@/lib/format';
import { minor } from '@/domain/money';
import { isDomainError } from '@/domain/errors';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Card, PageHeader } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { SOURCE_LABELS } from '../page';

export const metadata: Metadata = { title: 'Journal entry' };
export const dynamic = 'force-dynamic';

/** Where the transaction behind this entry lives. */
function sourceHref(sourceType: string, sourceId: number | null): string | null {
  if (sourceId === null) return null;
  switch (sourceType) {
    case 'SALE':
    case 'SALE_RETURN':
      return `/sales/${sourceId}`;
    case 'PURCHASE':
    case 'PURCHASE_RETURN':
      return `/purchases/${sourceId}`;
    case 'STOCK_ADJUSTMENT':
      return `/inventory/adjustments/${sourceId}`;
    default:
      return null;
  }
}

export default async function JournalEntryPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess('accounts', 'view');
  const { id } = await params;

  const entryId = Number(id);
  if (!Number.isInteger(entryId) || entryId <= 0) notFound();

  let data;
  try {
    data = getJournalEntry(db, entryId);
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const { entry, lines, totalDebit, totalCredit, balanced } = data;
  const href = sourceHref(entry.sourceType, entry.sourceId);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={entry.entryNo}
        description={`${formatDate(entry.entryDate)} · ${SOURCE_LABELS[entry.sourceType] ?? entry.sourceType}`}
        actions={
          <>
            <Link href="/accounting/journal">
              <Button variant="secondary" size="sm">
                All entries
              </Button>
            </Link>
            {href && (
              <Link href={href}>
                <Button size="sm">View the transaction</Button>
              </Link>
            )}
          </>
        }
      />

      {!balanced && (
        <Alert tone="danger" title="This entry does not balance" className="mb-4">
          Debits {money(totalDebit)} do not equal credits {money(totalCredit)}. This should be
          impossible — please report it.
        </Alert>
      )}

      {entry.reversedByEntryId !== null && (
        <Alert tone="warning" className="mb-4">
          This entry was reversed.{' '}
          <Link
            href={`/accounting/journal/${entry.reversedByEntryId}`}
            className="text-accent hover:underline"
          >
            See the reversing entry
          </Link>
          .
        </Alert>
      )}

      {entry.reversesEntryId !== null && (
        <Alert tone="info" className="mb-4">
          This entry reverses an earlier one.{' '}
          <Link
            href={`/accounting/journal/${entry.reversesEntryId}`}
            className="text-accent hover:underline"
          >
            See the original
          </Link>
          .
        </Alert>
      )}

      <Card className="mb-4">
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-content-muted">Recorded</dt>
            <dd className="mt-0.5 text-content">{formatDateTime(entry.occurredAt)}</dd>
          </div>
          <div>
            <dt className="text-sm text-content-muted">Business date</dt>
            <dd className="mt-0.5 text-content">{formatDate(entry.entryDate)}</dd>
          </div>
          <div>
            <dt className="text-sm text-content-muted">Traces to</dt>
            <dd className="mt-0.5 text-content">
              {SOURCE_LABELS[entry.sourceType] ?? entry.sourceType}
              {entry.sourceId !== null ? ` #${entry.sourceId}` : ''}
            </dd>
          </div>
          {entry.memo && (
            <div className="sm:col-span-3">
              <dt className="text-sm text-content-muted">Memo</dt>
              <dd className="mt-0.5 text-content">{entry.memo}</dd>
            </div>
          )}
        </dl>
      </Card>

      <TableWrap>
        <THead>
          <TH>Account</TH>
          <TH>Detail</TH>
          <TH numeric>Debit</TH>
          <TH numeric>Credit</TH>
        </THead>
        <tbody>
          {lines.map((line) => (
            <TR key={line.id}>
              <TD>
                <Link
                  href={`/accounting/ledger/${line.accountId}`}
                  className="font-medium text-accent hover:underline"
                >
                  {line.accountName}
                </Link>
                <span className="ml-2 tabular text-xs text-content-subtle">{line.accountCode}</span>
              </TD>
              <TD>
                <span className="text-content-muted">{line.description ?? '—'}</span>
                {line.customerName && (
                  <Badge tone="accent" className="ml-2">
                    {line.customerName}
                  </Badge>
                )}
                {line.supplierName && (
                  <Badge tone="warning" className="ml-2">
                    {line.supplierName}
                  </Badge>
                )}
              </TD>
              <TD numeric>{line.debit > 0 ? money(minor(line.debit), { bare: true }) : '—'}</TD>
              <TD numeric>{line.credit > 0 ? money(minor(line.credit), { bare: true }) : '—'}</TD>
            </TR>
          ))}
          <TR className="bg-surface-sunken font-semibold">
            <TD>Total</TD>
            <TD />
            <TD numeric>{money(totalDebit, { bare: true })}</TD>
            <TD numeric>{money(totalCredit, { bare: true })}</TD>
          </TR>
        </tbody>
      </TableWrap>

      <p className="mt-3 text-xs text-content-subtle">
        {balanced
          ? 'Debits equal credits — this entry balances.'
          : 'WARNING: this entry does not balance.'}
      </p>
    </div>
  );
}
