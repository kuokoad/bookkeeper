import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { listJournalEntries } from '@/services/reporting/ledger.service';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { EmptyState, PageHeader } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata: Metadata = { title: 'Journal' };
export const dynamic = 'force-dynamic';

export const SOURCE_LABELS: Record<string, string> = {
  SALE: 'Sale',
  SALE_RETURN: 'Customer return',
  PURCHASE: 'Purchase',
  PURCHASE_RETURN: 'Supplier return',
  CUSTOMER_PAYMENT: 'Customer payment',
  SUPPLIER_PAYMENT: 'Supplier payment',
  EXPENSE: 'Expense',
  INCOME: 'Other income',
  STOCK_ADJUSTMENT: 'Stock adjustment',
  RECONCILIATION: 'Reconciliation',
  OPENING_BALANCE: 'Opening balance',
  CAPITAL: 'Owner capital',
  DRAWINGS: 'Owner drawings',
  REVERSAL: 'Reversal',
};

const FILTERS = [
  { value: '', label: 'Everything' },
  { value: 'SALE', label: 'Sales' },
  { value: 'PURCHASE', label: 'Purchases' },
  { value: 'EXPENSE', label: 'Expenses' },
  { value: 'INCOME', label: 'Other income' },
  { value: 'CUSTOMER_PAYMENT', label: 'Customer payments' },
  { value: 'SUPPLIER_PAYMENT', label: 'Supplier payments' },
  { value: 'STOCK_ADJUSTMENT', label: 'Stock adjustments' },
];

export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; from?: string; to?: string }>;
}) {
  await requirePageAccess('accounts', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  const from = params.from ?? `${today.slice(0, 7)}-01`;
  const to = params.to ?? today;

  const entries = listJournalEntries(db, {
    from,
    to,
    ...(params.source ? { sourceType: params.source } : {}),
    limit: 300,
  });

  const unbalanced = entries.filter((entry) => !entry.balanced);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Journal"
        description="Every accounting entry, newest first. Each one traces back to a real transaction."
        actions={
          <Link href="/accounting">
            <Button variant="secondary" size="sm">
              Back to accounting
            </Button>
          </Link>
        }
      />

      {unbalanced.length > 0 && (
        <Alert tone="danger" title="Some entries do not balance" className="mb-4">
          {unbalanced.map((entry) => entry.entryNo).join(', ')}. This should be impossible — please
          report it.
        </Alert>
      )}

      <form action="/accounting/journal" className="mb-4 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="from" className="mb-1 block text-xs text-content-muted">
            From
          </label>
          <input
            id="from"
            name="from"
            type="date"
            defaultValue={from}
            className="h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
          />
        </div>
        <div>
          <label htmlFor="to" className="mb-1 block text-xs text-content-muted">
            To
          </label>
          <input
            id="to"
            name="to"
            type="date"
            defaultValue={to}
            className="h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
          />
        </div>
        <div>
          <label htmlFor="source" className="mb-1 block text-xs text-content-muted">
            Kind
          </label>
          <select
            id="source"
            name="source"
            defaultValue={params.source ?? ''}
            className="h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
          >
            {FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" size="sm" variant="secondary">
          Apply
        </Button>
      </form>

      {entries.length === 0 ? (
        <EmptyState
          title="No entries in this period"
          description="Accounting entries are created automatically whenever you record a sale, purchase, payment or expense."
        />
      ) : (
        <TableWrap>
          <THead>
            <TH>Entry</TH>
            <TH>Date</TH>
            <TH>Kind</TH>
            <TH>What it was</TH>
            <TH numeric>Lines</TH>
            <TH numeric>Amount</TH>
            <TH />
          </THead>
          <tbody>
            {entries.map((entry) => (
              <TR key={entry.id}>
                <TD>
                  <Link
                    href={`/accounting/journal/${entry.id}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {entry.entryNo}
                  </Link>
                </TD>
                <TD>
                  <span className="whitespace-nowrap text-content-muted">
                    {formatDate(entry.entryDate)}
                  </span>
                </TD>
                <TD>
                  <Badge tone={entry.reversesEntryId !== null ? 'neutral' : 'accent'}>
                    {SOURCE_LABELS[entry.sourceType] ?? entry.sourceType}
                  </Badge>
                </TD>
                <TD>
                  <span className="text-content-muted">{entry.memo ?? '—'}</span>
                </TD>
                <TD numeric>{entry.lineCount}</TD>
                <TD numeric>{money(entry.total, { bare: true })}</TD>
                <TD>
                  <div className="flex justify-end gap-1">
                    {entry.isOpening && <Badge tone="neutral">Opening</Badge>}
                    {entry.reversedByEntryId !== null && <Badge tone="danger">Reversed</Badge>}
                    {!entry.balanced && <Badge tone="danger">Unbalanced</Badge>}
                  </div>
                </TD>
              </TR>
            ))}
          </tbody>
        </TableWrap>
      )}

      <p className="mt-4 text-xs text-content-subtle">
        Showing {formatDate(from)} to {formatDate(to)}. Nothing here can be edited — a mistake is
        corrected by posting a reversing entry, so both the error and the correction stay visible.
      </p>
    </div>
  );
}
