import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getPurchasesSummary, listPurchases } from '@/services/purchase.service';
import { getTotalPayables } from '@/services/supplier.service';
import { formatDate, money, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata: Metadata = { title: 'Purchases' };
export const dynamic = 'force-dynamic';

export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ unpaid?: string }>;
}) {
  const user = await requirePageAccess('purchases', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  const monthStart = `${today.slice(0, 7)}-01`;

  const rows = listPurchases(db, {
    from: monthStart,
    to: today,
    unpaidOnly: params.unpaid === '1',
    limit: 200,
  });
  const monthSummary = getPurchasesSummary(db, monthStart, today);
  const todaySummary = getPurchasesSummary(db, today, today);
  const payables = getTotalPayables(db);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Purchases"
        description="What you bought, from whom, and what you still owe."
        actions={
          can(user, 'purchases', 'create') ? (
            <Link href="/purchases/new">
              <Button size="sm">New purchase</Button>
            </Link>
          ) : null
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Today's purchases" value={money(todaySummary.total)} hint={`${todaySummary.count} delivery(ies)`} />
        <Stat label="This month" value={money(monthSummary.total)} hint={`${monthSummary.count} deliveries`} />
        <Stat
          label="You owe suppliers"
          value={money(payables)}
          tone={payables > 0 ? 'warning' : 'default'}
          hint="Accounts payable"
        />
      </div>

      <div className="mb-4">
        <Link href={params.unpaid === '1' ? '/purchases' : '/purchases?unpaid=1'}>
          <Button size="sm" variant={params.unpaid === '1' ? 'primary' : 'secondary'}>
            Unpaid only
          </Button>
        </Link>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No purchases this month"
          description="Record a delivery to add stock at what it actually cost you, and to track what you owe."
          action={
            can(user, 'purchases', 'create') ? (
              <Link href="/purchases/new">
                <Button>Record a purchase</Button>
              </Link>
            ) : null
          }
        />
      ) : (
        <TableWrap>
          <THead>
            <TH>Reference</TH>
            <TH>Date</TH>
            <TH>Supplier</TH>
            <TH>Invoice</TH>
            <TH numeric>Lines</TH>
            <TH numeric>Total</TH>
            <TH numeric>Owing</TH>
            <TH>Status</TH>
          </THead>
          <tbody>
            {rows.map((row) => (
              <TR key={row.id}>
                <TD>
                  <Link href={`/purchases/${row.id}`} className="font-medium text-accent hover:underline">
                    {row.purchaseNo}
                  </Link>
                </TD>
                <TD>
                  <span className="whitespace-nowrap text-content-muted">
                    {formatDate(row.businessDate)}
                  </span>
                </TD>
                <TD>
                  {row.supplierName ? (
                    <Link href={`/suppliers/${row.supplierId}`} className="text-accent hover:underline">
                      {row.supplierName}
                    </Link>
                  ) : (
                    <span className="text-content-subtle">—</span>
                  )}
                </TD>
                <TD>
                  <span className="text-content-subtle">{row.invoiceNo ?? '—'}</span>
                </TD>
                <TD numeric>{row.itemCount}</TD>
                <TD numeric>{money(minor(row.totalMinor), { bare: true })}</TD>
                <TD numeric>
                  {row.outstandingMinor > 0 ? (
                    <span className="font-medium text-warning">
                      {money(minor(row.outstandingMinor), { bare: true })}
                    </span>
                  ) : (
                    <span className="text-content-subtle">—</span>
                  )}
                </TD>
                <TD>
                  {row.status === 'VOIDED' ? (
                    <Badge tone="danger">Voided</Badge>
                  ) : row.kind === 'RETURN' ? (
                    <Badge tone="accent">Return</Badge>
                  ) : row.kind === 'VOID' ? (
                    <Badge tone="neutral">Reversal</Badge>
                  ) : row.outstandingMinor > 0 ? (
                    <Badge tone="warning">Credit</Badge>
                  ) : (
                    <Badge tone="success">Paid</Badge>
                  )}
                </TD>
              </TR>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
