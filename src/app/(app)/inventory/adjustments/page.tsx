import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import {
  listStockAdjustments,
  REASON_LABELS,
} from '@/services/stock-adjustment.service';
import { formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { EmptyState, PageHeader } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata: Metadata = { title: 'Stock adjustments' };
export const dynamic = 'force-dynamic';

export default async function AdjustmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; voided?: string }>;
}) {
  const user = await requirePageAccess('inventory', 'view');
  const params = await searchParams;
  const adjustments = listStockAdjustments(db, 100);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Stock adjustments"
        description="Damage, loss, opening stock and count corrections."
        actions={
          <>
            <Link href="/inventory">
              <Button variant="secondary" size="sm">
                Back to inventory
              </Button>
            </Link>
            {can(user, 'inventory', 'create') && (
              <Link href="/inventory/adjustments/new">
                <Button size="sm">New adjustment</Button>
              </Link>
            )}
          </>
        }
      />

      {params.created === '1' && (
        <Alert tone="success" className="mb-4">
          Adjustment saved. Stock and the accounts were updated together.
        </Alert>
      )}
      {params.voided === '1' && (
        <Alert tone="success" className="mb-4">
          Adjustment voided. The original record was kept and a reversing entry was posted.
        </Alert>
      )}

      {adjustments.length === 0 ? (
        <EmptyState
          title="No adjustments yet"
          description="Use an adjustment to enter opening stock, or to record damage, loss or a count correction."
          action={
            can(user, 'inventory', 'create') ? (
              <Link href="/inventory/adjustments/new">
                <Button>Record one</Button>
              </Link>
            ) : null
          }
        />
      ) : (
        <TableWrap>
          <THead>
            <TH>Reference</TH>
            <TH>Date</TH>
            <TH>Reason</TH>
            <TH>Note</TH>
            <TH>Status</TH>
            <TH />
          </THead>
          <tbody>
            {adjustments.map((adjustment) => (
              <TR key={adjustment.id}>
                <TD>
                  <span className="font-medium text-content">{adjustment.adjustmentNo}</span>
                </TD>
                <TD>
                  <span className="whitespace-nowrap text-content-muted">
                    {formatDate(adjustment.businessDate)}
                  </span>
                </TD>
                <TD>{REASON_LABELS[adjustment.reason]}</TD>
                <TD>
                  <span className="text-content-muted">{adjustment.note ?? '—'}</span>
                </TD>
                <TD>
                  {adjustment.status === 'VOIDED' ? (
                    <Badge tone="danger">Voided</Badge>
                  ) : (
                    <Badge tone="success">Posted</Badge>
                  )}
                </TD>
                <TD>
                  <div className="flex justify-end">
                    <Link
                      href={`/inventory/adjustments/${adjustment.id}`}
                      className="text-xs font-medium text-accent hover:underline"
                    >
                      View
                    </Link>
                  </div>
                </TD>
              </TR>
            ))}
          </tbody>
        </TableWrap>
      )}

      <p className="mt-4 text-xs text-content-subtle">
        Adjustments are never deleted. Voiding one keeps the original and posts a reversing entry,
        so the history shows both what was recorded and that it was corrected.
      </p>
    </div>
  );
}
