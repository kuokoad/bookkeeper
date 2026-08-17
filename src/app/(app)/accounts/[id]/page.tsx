import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getAccountMovements, getPaymentAccount } from '@/services/payment-account.service';
import { formatDate, formatDateTime, money } from '@/lib/format';
import { minor } from '@/domain/money';
import { isDomainError } from '@/domain/errors';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata: Metadata = { title: 'Account' };
export const dynamic = 'force-dynamic';

/** Where each movement came from, in words the owner uses. */
const SOURCE_LABELS: Record<string, string> = {
  SALE: 'Sale',
  SALE_RETURN: 'Customer return',
  PURCHASE: 'Purchase',
  PURCHASE_RETURN: 'Return to supplier',
  CUSTOMER_PAYMENT: 'Customer payment',
  SUPPLIER_PAYMENT: 'Paid supplier',
  EXPENSE: 'Expense',
  INCOME: 'Other income',
  STOCK_ADJUSTMENT: 'Stock adjustment',
  RECONCILIATION: 'Reconciliation',
  OPENING_BALANCE: 'Opening balance',
  CAPITAL: 'Owner capital',
  DRAWINGS: 'Owner drawings',
  REVERSAL: 'Reversal',
};

/** Where clicking a movement should take you. */
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

export default async function AccountDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string; updated?: string }>;
}) {
  await requirePageAccess('accounts', 'view');
  const { id } = await params;
  const query = await searchParams;

  const accountId = Number(id);
  if (!Number.isInteger(accountId) || accountId <= 0) notFound();

  let account;
  try {
    account = getPaymentAccount(db, accountId);
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const currency = settings?.currencyCode ?? 'GHS';

  const movements = getAccountMovements(db, accountId, {
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    limit: 300,
  });

  const totalIn = movements.reduce((total, movement) => total + movement.inMinor, 0);
  const totalOut = movements.reduce((total, movement) => total + movement.outMinor, 0);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={account.name}
        description={`${account.provider ? `${account.provider} · ` : ''}Ledger account ${account.glCode}`}
        actions={
          <Link href="/accounts">
            <Button variant="secondary" size="sm">
              All accounts
            </Button>
          </Link>
        }
      />

      {query.updated === '1' && (
        <Alert tone="success" className="mb-4">
          Account updated.
        </Alert>
      )}

      {account.balance < 0 && (
        <Alert tone="warning" title="This account is showing less than zero" className="mb-4">
          That normally means money went out of the wrong account, or something received was never
          recorded. The movements below show exactly how it got here.
        </Alert>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat
          label="Balance now"
          value={money(account.balance, { currencyCode: currency })}
          tone={account.balance < 0 ? 'danger' : 'default'}
        />
        <Stat label="Money in" value={money(minor(totalIn), { bare: true })} hint="In this view" />
        <Stat label="Money out" value={money(minor(totalOut), { bare: true })} hint="In this view" />
      </div>

      <h2 className="mb-3 text-sm font-semibold text-content">Movements</h2>

      {movements.length === 0 ? (
        <EmptyState
          title="Nothing has moved through this account yet"
          description="Sales, purchases, expenses and payments that use this account will appear here with a running balance."
        />
      ) : (
        <TableWrap>
          <THead>
            <TH>Date</TH>
            <TH>What happened</TH>
            <TH>Reference</TH>
            <TH numeric>In</TH>
            <TH numeric>Out</TH>
            <TH numeric>Balance</TH>
          </THead>
          <tbody>
            {movements.map((movement) => {
              const href = sourceHref(movement.sourceType, movement.sourceId);
              return (
                <TR key={`${movement.entryId}-${movement.entryNo}`}>
                  <TD>
                    <span className="whitespace-nowrap text-content-muted">
                      {formatDate(movement.entryDate)}
                    </span>
                    <span className="block text-xs text-content-subtle">
                      {formatDateTime(movement.occurredAt).split(', ')[1] ?? ''}
                    </span>
                  </TD>
                  <TD>
                    <Badge tone={movement.inMinor > 0 ? 'success' : 'warning'}>
                      {SOURCE_LABELS[movement.sourceType] ?? movement.sourceType}
                    </Badge>
                    <span className="mt-0.5 block text-xs text-content-muted">
                      {movement.description ?? movement.memo ?? ''}
                    </span>
                  </TD>
                  <TD>
                    {href ? (
                      <Link href={href} className="text-xs font-medium text-accent hover:underline">
                        {movement.entryNo}
                      </Link>
                    ) : (
                      <span className="text-xs text-content-subtle">{movement.entryNo}</span>
                    )}
                  </TD>
                  <TD numeric>
                    {movement.inMinor > 0 ? money(minor(movement.inMinor), { bare: true }) : '—'}
                  </TD>
                  <TD numeric>
                    {movement.outMinor > 0 ? money(minor(movement.outMinor), { bare: true }) : '—'}
                  </TD>
                  <TD numeric>
                    <span
                      className={movement.runningBalance < 0 ? 'font-medium text-danger' : 'font-medium'}
                    >
                      {money(minor(movement.runningBalance), { bare: true })}
                    </span>
                  </TD>
                </TR>
              );
            })}
          </tbody>
        </TableWrap>
      )}

      <p className="mt-4 text-xs text-content-subtle">
        This is the full answer to &ldquo;why is the balance {money(account.balance, { currencyCode: currency })}?&rdquo;
        — every line that moved money through this account, oldest at the bottom, with the balance
        after each one.
      </p>
    </div>
  );
}
