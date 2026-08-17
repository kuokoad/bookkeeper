import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { journalEntries, journalLines, accounts } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getStockAdjustment, REASON_LABELS } from '@/services/stock-adjustment.service';
import { formatDate, formatDateTime, money, quantity } from '@/lib/format';
import { minor } from '@/domain/money';
import { qty as makeQty } from '@/domain/quantity';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Card, PageHeader } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { isDomainError } from '@/domain/errors';
import { VoidAdjustmentForm } from './void-form';

export const metadata: Metadata = { title: 'Stock adjustment' };
export const dynamic = 'force-dynamic';

export default async function AdjustmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePageAccess('inventory', 'view');
  const { id } = await params;
  const adjustmentId = Number(id);
  if (!Number.isInteger(adjustmentId) || adjustmentId <= 0) notFound();

  let data;
  try {
    data = getStockAdjustment(db, adjustmentId);
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const { adjustment, items } = data;

  // The journal entry this document produced — shown so the accounting effect
  // is visible rather than hidden behind the stock movement.
  const entry =
    adjustment.journalEntryId === null
      ? null
      : (db
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.id, adjustment.journalEntryId))
          .get() ?? null);

  const lines = entry
    ? db
        .select({
          id: journalLines.id,
          accountCode: accounts.code,
          accountName: accounts.name,
          debit: journalLines.debitMinor,
          credit: journalLines.creditMinor,
        })
        .from(journalLines)
        .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
        .where(eq(journalLines.entryId, entry.id))
        .all()
    : [];

  const totalDebit = lines.reduce((total, line) => total + line.debit, 0);
  const totalCredit = lines.reduce((total, line) => total + line.credit, 0);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={adjustment.adjustmentNo}
        description={`${REASON_LABELS[adjustment.reason]} · ${formatDate(adjustment.businessDate)}`}
        actions={
          <Link href="/inventory/adjustments">
            <Button variant="secondary" size="sm">
              Back
            </Button>
          </Link>
        }
      />

      {adjustment.status === 'VOIDED' && (
        <Alert tone="warning" title="This adjustment was voided" className="mb-4">
          {adjustment.voidReason}
          {adjustment.voidedAt && ` — ${formatDateTime(adjustment.voidedAt)}`}. The original record
          is kept exactly as it was recorded.
        </Alert>
      )}

      <Card className="mb-4">
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-content-muted">Reason</dt>
            <dd className="mt-0.5 font-medium text-content">{REASON_LABELS[adjustment.reason]}</dd>
          </div>
          <div>
            <dt className="text-sm text-content-muted">Recorded</dt>
            <dd className="mt-0.5 font-medium text-content">
              {formatDateTime(adjustment.occurredAt)}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-content-muted">Status</dt>
            <dd className="mt-0.5">
              {adjustment.status === 'VOIDED' ? (
                <Badge tone="danger">Voided</Badge>
              ) : (
                <Badge tone="success">Posted</Badge>
              )}
            </dd>
          </div>
          {adjustment.note && (
            <div className="sm:col-span-3">
              <dt className="text-sm text-content-muted">Note</dt>
              <dd className="mt-0.5 text-content">{adjustment.note}</dd>
            </div>
          )}
        </dl>
      </Card>

      <h2 className="mb-3 text-sm font-semibold text-content">Products</h2>
      <TableWrap className="mb-6">
        <THead>
          <TH>Product</TH>
          <TH>Direction</TH>
          <TH numeric>Quantity</TH>
          <TH numeric>Unit cost</TH>
          <TH numeric>Value</TH>
        </THead>
        <tbody>
          {items.map((item) => (
            <TR key={item.id}>
              <TD>
                <span className="font-medium text-content">{item.productName}</span>
              </TD>
              <TD>
                <Badge tone={item.direction === 'IN' ? 'success' : 'warning'}>
                  {item.direction === 'IN' ? 'In' : 'Out'}
                </Badge>
              </TD>
              <TD numeric>{quantity(makeQty(item.qtyMilli), item.unit)}</TD>
              <TD numeric>{money(minor(item.unitCostMinor), { bare: true })}</TD>
              <TD numeric>{money(minor(item.totalCostMinor), { bare: true })}</TD>
            </TR>
          ))}
        </tbody>
      </TableWrap>

      <h2 className="mb-3 text-sm font-semibold text-content">Accounting entry</h2>
      {entry === null ? (
        <Card>
          <p className="text-sm text-content-muted">
            No accounting entry was needed — every line moved stock that carried no value.
          </p>
        </Card>
      ) : (
        <>
          <TableWrap>
            <THead>
              <TH>Account</TH>
              <TH numeric>Debit</TH>
              <TH numeric>Credit</TH>
            </THead>
            <tbody>
              {lines.map((line) => (
                <TR key={line.id}>
                  <TD>
                    <span className="text-content-subtle">{line.accountCode}</span>{' '}
                    <span className="font-medium text-content">{line.accountName}</span>
                  </TD>
                  <TD numeric>
                    {line.debit > 0 ? money(minor(line.debit), { bare: true }) : '—'}
                  </TD>
                  <TD numeric>
                    {line.credit > 0 ? money(minor(line.credit), { bare: true }) : '—'}
                  </TD>
                </TR>
              ))}
              <TR className="bg-surface-sunken font-semibold">
                <TD>Total ({entry.entryNo})</TD>
                <TD numeric>{money(minor(totalDebit), { bare: true })}</TD>
                <TD numeric>{money(minor(totalCredit), { bare: true })}</TD>
              </TR>
            </tbody>
          </TableWrap>
          <p className="mt-2 text-xs text-content-subtle">
            {totalDebit === totalCredit
              ? 'Debits equal credits — this entry balances.'
              : 'WARNING: this entry does not balance. Please report it.'}
          </p>
        </>
      )}

      {adjustment.status === 'POSTED' && can(user, 'inventory', 'void') && (
        <div className="mt-8">
          <VoidAdjustmentForm adjustmentId={adjustment.id} reference={adjustment.adjustmentNo} />
        </div>
      )}
    </div>
  );
}
