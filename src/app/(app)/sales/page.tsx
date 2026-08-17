import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getSalesSummary, listSales } from '@/services/sale.service';
import { formatDate, formatTime, money, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState, PageHeader, Stat } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata: Metadata = { title: 'Sales' };
export const dynamic = 'force-dynamic';

function monthStart(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ unpaid?: string; from?: string; to?: string }>;
}) {
  const user = await requirePageAccess('sales', 'view');
  const params = await searchParams;

  const today = toBusinessDate();
  const from = params.from ?? monthStart(today);
  const to = params.to ?? today;

  const rows = listSales(db, { from, to, unpaidOnly: params.unpaid === '1', limit: 200 });
  const todaySummary = getSalesSummary(db, today, today);
  const monthSummary = getSalesSummary(db, monthStart(today), today);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Sales"
        description="Every sale, what it earned and what is still owed."
        actions={
          can(user, 'sales', 'create') ? (
            <Link href="/sales/new">
              <Button size="sm">New sale</Button>
            </Link>
          ) : null
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Today's sales" value={money(todaySummary.total)} hint={`${todaySummary.count} sale(s)`} />
        <Stat label="Today's profit" value={money(todaySummary.grossProfit)} hint="Revenue less cost of goods" />
        <Stat label="This month" value={money(monthSummary.total)} hint={`${monthSummary.count} sale(s)`} />
        <Stat label="Month profit" value={money(monthSummary.grossProfit)} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link href={params.unpaid === '1' ? '/sales' : '/sales?unpaid=1'}>
          <Button size="sm" variant={params.unpaid === '1' ? 'primary' : 'secondary'}>
            Unpaid only
          </Button>
        </Link>
        <span className="text-xs text-content-subtle">
          Showing {formatDate(from)} to {formatDate(to)}
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No sales in this period"
          description="Sales you record will appear here with their profit and any balance still owing."
          action={
            can(user, 'sales', 'create') ? (
              <Link href="/sales/new">
                <Button>Record a sale</Button>
              </Link>
            ) : null
          }
        />
      ) : (
        <TableWrap>
          <THead>
            <TH>Receipt</TH>
            <TH>When</TH>
            <TH>Customer</TH>
            <TH numeric>Items</TH>
            <TH numeric>Total</TH>
            <TH numeric>Profit</TH>
            <TH numeric>Owing</TH>
            <TH>Status</TH>
          </THead>
          <tbody>
            {rows.map((row) => (
              <TR key={row.id}>
                <TD>
                  <Link
                    href={`/sales/${row.id}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {row.receiptNo}
                  </Link>
                </TD>
                <TD>
                  <span className="whitespace-nowrap text-content-muted">
                    {formatDate(row.businessDate)} {formatTime(row.occurredAt)}
                  </span>
                </TD>
                <TD>
                  {row.customerName ? (
                    <Link
                      href={`/customers/${row.customerId}`}
                      className="text-accent hover:underline"
                    >
                      {row.customerName}
                    </Link>
                  ) : (
                    <span className="text-content-subtle">Walk-in</span>
                  )}
                </TD>
                <TD numeric>{row.itemCount}</TD>
                <TD numeric>{money(minor(row.totalMinor), { bare: true })}</TD>
                <TD numeric>
                  <span className={row.profitMinor < 0 ? 'text-danger' : ''}>
                    {money(minor(row.profitMinor), { bare: true })}
                  </span>
                </TD>
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
                  ) : row.voidsSaleId !== null ? (
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

      <p className="mt-4 text-xs text-content-subtle">
        Profit is revenue less the cost the goods actually carried when they were sold, taken from
        the stock ledger — not from today&rsquo;s cost price.
      </p>
    </div>
  );
}
