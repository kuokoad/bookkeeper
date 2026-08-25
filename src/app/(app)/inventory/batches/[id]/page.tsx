import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getBatchHistory, type BatchHistoryEntry } from '@/services/inventory.service';
import { formatDate, formatDateTime, quantity, toBusinessDate } from '@/lib/format';
import { qty as makeQty } from '@/domain/quantity';
import { daysBetween } from '@/domain/business-date';
import { isDomainError } from '@/domain/errors';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Card, PageHeader } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { ExpiryForm } from './expiry-form';

export const metadata: Metadata = { title: 'Batch' };
export const dynamic = 'force-dynamic';

/**
 * One crate, and everywhere it went.
 *
 * This page is why the batch split was hung off the ledger row rather than the
 * sale line back in Phase 1. A supplier telephones about a bad lot; somebody
 * types the reference off the box into the search bar; this page names the
 * people who took it home.
 *
 * Quantities only, never money. A batch has never carried a cost — value is
 * weighted-average and pooled per product — so a column of figures here would
 * be an invention.
 */

/** Where a movement came from, in words a shop owner uses. */
const SOURCE_LABELS: Record<string, string> = {
  PURCHASE: 'Delivery',
  PURCHASE_RETURN: 'Returned to supplier',
  PURCHASE_VOID: 'Delivery cancelled',
  SALE: 'Sold',
  SALE_RETURN: 'Customer returned',
  SALE_VOID: 'Sale cancelled',
  STOCK_ADJUSTMENT: 'Stock adjustment',
  OPENING: 'On the shelf at the start',
};

/** The document a movement belongs to, when there is a page for it. */
function documentHref(entry: BatchHistoryEntry): string | null {
  if (entry.sourceId === null) return null;
  if (entry.sourceType === 'SALE' || entry.sourceType === 'SALE_RETURN') {
    return `/sales/${entry.sourceId}`;
  }
  if (entry.sourceType === 'PURCHASE' || entry.sourceType === 'PURCHASE_RETURN') {
    return `/purchases/${entry.sourceId}`;
  }
  return null;
}

export default async function BatchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageAccess('products', 'view');

  const { id } = await params;
  const batchId = Number(id);
  if (!Number.isInteger(batchId) || batchId <= 0) notFound();

  let history;
  try {
    history = getBatchHistory(db, batchId);
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const { batch, entries } = history;
  const today = toBusinessDate();
  const daysLeft = batch.expiryDate === null ? null : daysBetween(today, batch.expiryDate);
  const expired = daysLeft !== null && daysLeft < 0;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={batch.batchRef}
        description={
          batch.supplierName === null
            ? batch.productName
            : `${batch.productName} · from ${batch.supplierName}`
        }
        actions={
          <Link href={`/products/${batch.productId}/edit`}>
            <Button variant="secondary" size="sm">
              Open the product
            </Button>
          </Link>
        }
      />

      {expired && (
        <Alert tone="danger" title="This stock has passed its date" className="mb-4">
          It expired {formatDate(batch.expiryDate!)}, {Math.abs(daysLeft)} day
          {Math.abs(daysLeft) === 1 ? '' : 's'} ago. It cannot be sold without approval. Record a
          stock adjustment with the reason &ldquo;Expired&rdquo; to take it off the shelf and out of
          the accounts.
        </Alert>
      )}

      <Card title="This batch" className="mb-4">
        <dl className="grid gap-4 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-content-muted">Still on the shelf</dt>
            <dd className="tabular text-lg font-semibold text-content">
              {quantity(makeQty(batch.qtyMilli), batch.unit)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-content-muted">Arrived with</dt>
            <dd className="tabular text-lg font-semibold text-content">
              {quantity(makeQty(arrivedWith(batch.openingQtyMilli, entries)), batch.unit)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-content-muted">Expires</dt>
            <dd className="text-lg font-semibold text-content">
              {batch.expiryDate === null ? (
                <span className="text-content-muted">No date recorded</span>
              ) : (
                formatDate(batch.expiryDate)
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-content-muted">Status</dt>
            <dd className="text-lg font-semibold">
              {expired ? (
                <Badge tone="danger">Expired</Badge>
              ) : batch.isClosed ? (
                <Badge tone="neutral">Empty</Badge>
              ) : daysLeft !== null && daysLeft <= 30 ? (
                <Badge tone="warning">
                  {daysLeft} day{daysLeft === 1 ? '' : 's'} left
                </Badge>
              ) : (
                <Badge tone="success">On the shelf</Badge>
              )}
            </dd>
          </div>
        </dl>

        {batch.receivedDate !== null && (
          <p className="mt-3 border-t border-line pt-3 text-xs text-content-muted">
            Received {formatDate(batch.receivedDate)}
            {batch.note !== null && ` · ${batch.note}`}
          </p>
        )}

        {can(user, 'inventory', 'edit') && (
          <div className="mt-3 border-t border-line pt-3">
            <ExpiryForm
              batchId={batch.id}
              batchRef={batch.batchRef}
              expiryDate={batch.expiryDate}
            />
          </div>
        )}
      </Card>

      <Card title="Everywhere it went">
        {entries.length === 0 ? (
          <p className="text-sm text-content-muted">
            Nothing has moved through this batch yet. Stock that was already on the shelf when
            batches were first recorded has no history before that day.
          </p>
        ) : (
          <>
            <p className="mb-3 text-sm text-content-muted">
              Every movement that touched this batch, oldest first. On the day a supplier reports a
              problem, this is who to telephone.
            </p>
            <TableWrap>
              <THead>
                <TH>When</TH>
                <TH>What happened</TH>
                <TH>Who</TH>
                <TH numeric>In</TH>
                <TH numeric>Out</TH>
              </THead>
              <tbody>
                {entries.map((entry) => {
                  const href = documentHref(entry);
                  return (
                    <TR key={entry.ledgerId}>
                      <TD>
                        <span className="block text-content">{formatDate(entry.businessDate)}</span>
                        <span className="block text-xs text-content-subtle">
                          {formatDateTime(entry.occurredAt)}
                        </span>
                      </TD>
                      <TD>
                        <span className="text-content">
                          {SOURCE_LABELS[entry.sourceType] ?? entry.sourceType}
                        </span>
                        {entry.sourceRef !== null && (
                          <span className="block text-xs text-content-subtle">
                            {href === null ? (
                              entry.sourceRef
                            ) : (
                              <Link href={href} className="text-accent hover:underline">
                                {entry.sourceRef}
                              </Link>
                            )}
                          </span>
                        )}
                      </TD>
                      <TD>
                        {entry.partyName ?? <span className="text-content-subtle">—</span>}
                      </TD>
                      <TD numeric>
                        {entry.qtyInMilli > 0
                          ? quantity(makeQty(entry.qtyInMilli), batch.unit)
                          : '—'}
                      </TD>
                      <TD numeric>
                        {entry.qtyOutMilli > 0
                          ? quantity(makeQty(entry.qtyOutMilli), batch.unit)
                          : '—'}
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </TableWrap>
          </>
        )}
      </Card>
    </div>
  );
}

/**
 * How much this crate started with.
 *
 * `openingQtyMilli` for a batch the migration opened, since nothing moved
 * through it; the first delivery in, for one a purchase opened, which starts
 * empty and is filled by the allocation immediately after — see `openBatch`.
 */
function arrivedWith(openingQtyMilli: number, entries: BatchHistoryEntry[]): number {
  if (openingQtyMilli !== 0) return openingQtyMilli;
  return entries.reduce((total, entry) => total + entry.qtyInMilli, 0);
}
