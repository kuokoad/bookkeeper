import type { Metadata } from 'next';
import Link from 'next/link';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { voidTransferAction } from '@/actions/cashbook.actions';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { accountHref } from '@/lib/account-routes';
import { clampPage, parsePage } from '@/lib/filters';
import { formatDate, money } from '@/lib/format';
import { countTransfers, listTransfers } from '@/services/transfer.service';
import { RowVoidForm } from '@/components/shared/row-void-form';
import { Pagination } from '@/components/shared/pagination';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeader } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata: Metadata = { title: 'Transfers' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function TransfersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; voided?: string }>;
}) {
  const user = await requirePageAccess('accounts', 'view');
  const params = await searchParams;

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const currency = settings?.currencyCode ?? 'GHS';

  const total = countTransfers(db);
  const requested = parsePage(params.page, PAGE_SIZE);
  const page = clampPage(requested.page, total, PAGE_SIZE);
  const rows = listTransfers(db, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });

  const canVoid = can(user, 'accounts', 'void');
  const returnTo = page > 1 ? `page=${page}` : '';

  return (
    <div className="w-full">
      <PageHeader
        title="Transfers"
        description="Money moved between the shop's own accounts — cash banked, MoMo drawn into the till."
        actions={
          <Link href="/accounts">
            <Button variant="secondary" size="sm">
              All accounts
            </Button>
          </Link>
        }
      />

      {params.voided === '1' && (
        <Alert tone="success" className="mb-4">
          Transfer voided. The original record was kept and a reversing entry posted today, so
          both balances are back where they were.
        </Alert>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title="No transfers yet"
          description="When you bank cash or move money between accounts, record it from the Accounts page so both balances stay right."
        />
      ) : (
        <>
          <TableWrap>
            <THead>
              <TH>Date</TH>
              <TH>Transfer</TH>
              <TH>From</TH>
              <TH>To</TH>
              <TH numeric>Amount ({currency})</TH>
              <TH />
            </THead>
            <tbody>
              {rows.map((row) => (
                <TR key={row.id}>
                  <TD>{formatDate(row.businessDate)}</TD>
                  <TD>
                    <span className="font-medium text-content">{row.transferNo}</span>
                    {row.status === 'VOIDED' && (
                      <Badge tone="danger" className="ml-2">
                        Voided
                      </Badge>
                    )}
                    {(row.reference || row.note) && (
                      <div className="mt-0.5 text-xs text-content-subtle">
                        {[row.reference, row.note].filter(Boolean).join(' · ')}
                      </div>
                    )}
                    {row.status === 'VOIDED' && row.voidReason && (
                      <div className="mt-0.5 text-xs text-content-subtle">
                        Voided: {row.voidReason}
                      </div>
                    )}
                  </TD>
                  <TD>
                    <Link
                      href={accountHref(row.fromAccountId)}
                      className="text-accent hover:underline"
                    >
                      {row.fromAccountName}
                    </Link>
                  </TD>
                  <TD>
                    <Link
                      href={accountHref(row.toAccountId)}
                      className="text-accent hover:underline"
                    >
                      {row.toAccountName}
                    </Link>
                  </TD>
                  <TD numeric>
                    <span className={row.status === 'VOIDED' ? 'text-content-subtle line-through' : ''}>
                      {money(row.amount, { bare: true })}
                    </span>
                  </TD>
                  <TD>
                    <div className="flex justify-end">
                      {canVoid && row.status === 'POSTED' && (
                        <RowVoidForm
                          action={voidTransferAction.bind(null, row.id)}
                          returnTo={returnTo}
                          what={row.transferNo}
                          placeholder="e.g. Wrong amount"
                        />
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </tbody>
          </TableWrap>
          <Pagination
            basePath="/accounts/transfers"
            values={{}}
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            noun="transfer"
          />
        </>
      )}
    </div>
  );
}
