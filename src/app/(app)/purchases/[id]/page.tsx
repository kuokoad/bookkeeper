import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { accounts, businessSettings, journalLines, paymentAccounts } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getPurchase } from '@/services/purchase.service';
import { getReturnablePurchaseItems } from '@/services/returns.service';
import { createSupplierReturnAction, voidPurchaseAction } from '@/actions/purchase.actions';
import { formatDate, formatDateTime, money, quantity, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import { qty as makeQty } from '@/domain/quantity';
import { isDomainError } from '@/domain/errors';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Card, PageHeader } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { ReturnForm } from '@/components/shared/return-form';
import { ConfirmVoidForm } from '@/components/shared/confirm-void-form';

export const metadata: Metadata = { title: 'Purchase' };
export const dynamic = 'force-dynamic';

export default async function PurchaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ voided?: string; returned?: string }>;
}) {
  const user = await requirePageAccess('purchases', 'view');
  const { id } = await params;
  const query = await searchParams;

  const purchaseId = Number(id);
  if (!Number.isInteger(purchaseId) || purchaseId <= 0) notFound();

  let purchase;
  try {
    purchase = getPurchase(db, purchaseId);
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const currency = settings?.currencyCode ?? 'GHS';

  const lines =
    purchase.journalEntryId === null
      ? []
      : db
          .select({
            id: journalLines.id,
            accountCode: accounts.code,
            accountName: accounts.name,
            debit: journalLines.debitMinor,
            credit: journalLines.creditMinor,
          })
          .from(journalLines)
          .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
          .where(eq(journalLines.entryId, purchase.journalEntryId))
          .all();

  const totalDebit = lines.reduce((total, line) => total + line.debit, 0);
  const totalCredit = lines.reduce((total, line) => total + line.credit, 0);

  const returnable =
    purchase.kind === 'PURCHASE' && purchase.status === 'POSTED'
      ? getReturnablePurchaseItems(db, purchaseId)
      : [];

  const payAccounts = db
    .select()
    .from(paymentAccounts)
    .where(eq(paymentAccounts.isActive, true))
    .orderBy(paymentAccounts.sortOrder)
    .all()
    .map((account) => ({ id: account.id, name: account.name, isDefault: account.isDefault }));

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={purchase.purchaseNo}
        description={`${formatDate(purchase.businessDate)}${purchase.invoiceNo ? ` · Invoice ${purchase.invoiceNo}` : ''}`}
        actions={
          <Link href="/purchases">
            <Button variant="secondary" size="sm">
              All purchases
            </Button>
          </Link>
        }
      />

      {query.voided === '1' && (
        <Alert tone="success" className="mb-4">
          Purchase voided. The original record was kept and a reversing entry posted.
        </Alert>
      )}
      {query.returned === '1' && (
        <Alert tone="success" className="mb-4">
          Return recorded. Stock went out at the price this supplier charged.
        </Alert>
      )}

      {purchase.status === 'VOIDED' && (
        <Alert tone="warning" title="This purchase was voided" className="mb-4">
          {purchase.voidReason}
          {purchase.voidedAt && ` — ${formatDateTime(purchase.voidedAt)}`}.
        </Alert>
      )}
      {purchase.kind === 'RETURN' && (
        <Alert tone="info" className="mb-4">
          This is a return document — goods sent back to the supplier.
        </Alert>
      )}
      {purchase.kind === 'VOID' && (
        <Alert tone="info" className="mb-4">
          This is the reversing entry created when a purchase was voided.
        </Alert>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-sm text-content-muted">Total</p>
          <p className="tabular mt-1 text-xl font-semibold text-content">
            {money(minor(purchase.totalMinor), { currencyCode: currency })}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-content-muted">Paid</p>
          <p className="tabular mt-1 text-xl font-semibold text-content">
            {money(
              minor(purchase.tenders.reduce((total, tender) => total + tender.amountMinor, 0)),
              { bare: true },
            )}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-content-muted">Still owed</p>
          <p
            className={`tabular mt-1 text-xl font-semibold ${purchase.outstandingMinor > 0 ? 'text-warning' : 'text-content'}`}
          >
            {money(purchase.outstandingMinor, { bare: true })}
          </p>
        </Card>
      </div>

      {purchase.supplierName && (
        <Card className="mb-4">
          <p className="text-sm text-content-muted">Supplier</p>
          <p className="mt-0.5">
            <Link
              href={`/suppliers/${purchase.supplierId}`}
              className="font-medium text-accent hover:underline"
            >
              {purchase.supplierName}
            </Link>
            {purchase.supplierPhone && (
              <span className="ml-2 text-sm text-content-subtle">{purchase.supplierPhone}</span>
            )}
          </p>
        </Card>
      )}

      <h2 className="mb-3 text-sm font-semibold text-content">Items</h2>
      <TableWrap className="mb-6">
        <THead>
          <TH>Product</TH>
          <TH numeric>Qty</TH>
          <TH numeric>Cost each</TH>
          <TH numeric>Discount</TH>
          <TH numeric>Total</TH>
          <TH numeric>Returned</TH>
        </THead>
        <tbody>
          {purchase.items.map((item) => (
            <TR key={item.id}>
              <TD>
                <span className="font-medium text-content">{item.productName}</span>
              </TD>
              <TD numeric>{quantity(makeQty(item.qtyMilli), item.unit)}</TD>
              <TD numeric>{money(minor(item.unitCostMinor), { bare: true })}</TD>
              <TD numeric>
                {item.discountMinor > 0 ? money(minor(item.discountMinor), { bare: true }) : '—'}
              </TD>
              <TD numeric>{money(minor(item.lineTotalMinor), { bare: true })}</TD>
              <TD numeric>
                {item.returnedQtyMilli > 0 ? (
                  <span className="text-warning">
                    {quantity(makeQty(item.returnedQtyMilli), item.unit)}
                  </span>
                ) : (
                  <span className="text-content-subtle">—</span>
                )}
              </TD>
            </TR>
          ))}
          <TR className="bg-surface-sunken font-semibold">
            <TD>Total</TD>
            <TD />
            <TD />
            <TD numeric>
              {purchase.discountMinor > 0 ? money(minor(purchase.discountMinor), { bare: true }) : '—'}
            </TD>
            <TD numeric>{money(minor(purchase.totalMinor), { bare: true })}</TD>
            <TD />
          </TR>
        </tbody>
      </TableWrap>

      <h2 className="mb-3 text-sm font-semibold text-content">Accounting entry</h2>
      {lines.length === 0 ? (
        <Card>
          <p className="text-sm text-content-muted">No accounting entry is linked to this purchase.</p>
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
                  <TD numeric>{line.debit > 0 ? money(minor(line.debit), { bare: true }) : '—'}</TD>
                  <TD numeric>
                    {line.credit > 0 ? money(minor(line.credit), { bare: true }) : '—'}
                  </TD>
                </TR>
              ))}
              <TR className="bg-surface-sunken font-semibold">
                <TD>Total</TD>
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

      {returnable.length > 0 && can(user, 'purchases', 'create') && (
        <div className="mt-8">
          <ReturnForm
            action={createSupplierReturnAction.bind(null, purchaseId)}
            items={returnable.map((item) => ({
              id: item.id,
              productName: item.productName,
              unit: item.unit,
              returnableMilli: item.returnableMilli,
              unitAmountMinor: item.unitCostMinor,
            }))}
            accounts={payAccounts}
            today={toBusinessDate()}
            currencyCode={currency}
            title="Return goods to this supplier"
            description="Send some or all of this delivery back. Stock leaves at the price this supplier charged, not the blended average."
            submitLabel="Record return to supplier"
            creditLabel="reduces what you owe them"
          />
        </div>
      )}

      {purchase.status === 'POSTED' &&
        purchase.kind === 'PURCHASE' &&
        can(user, 'purchases', 'void') && (
          <div className="mt-6">
            <ConfirmVoidForm
              action={voidPurchaseAction.bind(null, purchaseId)}
              reference={purchase.purchaseNo}
              title="Void this purchase"
              description="Stock is taken back out and the payable or payment reversed. The original record is kept."
              placeholder="e.g. Delivered to the wrong shop"
            />
          </div>
        )}
    </div>
  );
}
