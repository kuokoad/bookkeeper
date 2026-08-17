import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { accounts, businessSettings, journalLines, paymentAccounts } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getSale } from '@/services/sale.service';
import { getReturnableSaleItems } from '@/services/returns.service';
import { createCustomerReturnAction } from '@/actions/purchase.actions';
import { formatDate, formatDateTime, money, quantity, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import { qty as makeQty } from '@/domain/quantity';
import { isDomainError } from '@/domain/errors';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Card, PageHeader } from '@/components/ui/page';
import { TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { ReturnForm } from '@/components/shared/return-form';
import { VoidSaleForm } from './void-form';

export const metadata: Metadata = { title: 'Sale' };
export const dynamic = 'force-dynamic';

export default async function SaleDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ voided?: string }>;
}) {
  const user = await requirePageAccess('sales', 'view');
  const { id } = await params;
  const query = await searchParams;

  const saleId = Number(id);
  if (!Number.isInteger(saleId) || saleId <= 0) notFound();

  let sale;
  try {
    sale = getSale(db, saleId);
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const currency = settings?.currencyCode ?? 'GHS';

  const lines =
    sale.journalEntryId === null
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
          .where(eq(journalLines.entryId, sale.journalEntryId))
          .all();

  const totalDebit = lines.reduce((total, line) => total + line.debit, 0);
  const totalCredit = lines.reduce((total, line) => total + line.credit, 0);
  const profit = sale.totalMinor - sale.cogsMinor;

  const returnable =
    sale.kind === 'SALE' && sale.status === 'POSTED' ? getReturnableSaleItems(db, saleId) : [];

  const payAccounts = db
    .select()
    .from(paymentAccounts)
    .where(eq(paymentAccounts.isActive, true))
    .orderBy(paymentAccounts.sortOrder)
    .all()
    .map((account) => ({ id: account.id, name: account.name, isDefault: account.isDefault }));
  const tendered = sale.tenders.reduce((total, tender) => total + tender.amountMinor, 0);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={sale.receiptNo}
        description={`${formatDate(sale.businessDate)} · ${formatDateTime(sale.occurredAt)}`}
        actions={
          <>
            <Link href="/sales">
              <Button variant="secondary" size="sm">
                All sales
              </Button>
            </Link>
            <Link href={`/sales/${saleId}/receipt`}>
              <Button size="sm">View receipt</Button>
            </Link>
          </>
        }
      />

      {query.voided === '1' && (
        <Alert tone="success" className="mb-4">
          Sale voided. The original record was kept and a reversing entry was posted.
        </Alert>
      )}

      {sale.status === 'VOIDED' && (
        <Alert tone="warning" title="This sale was voided" className="mb-4">
          {sale.voidReason}
          {sale.voidedAt && ` — ${formatDateTime(sale.voidedAt)}`}. The original record is kept
          exactly as it was made.
        </Alert>
      )}

      {sale.voidsSaleId !== null && (
        <Alert tone="info" className="mb-4">
          This is the reversing entry created when an earlier sale was voided.
        </Alert>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Card>
          <p className="text-sm text-content-muted">Total</p>
          <p className="tabular mt-1 text-xl font-semibold text-content">
            {money(minor(sale.totalMinor), { currencyCode: currency })}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-content-muted">Cost of goods</p>
          <p className="tabular mt-1 text-xl font-semibold text-content">
            {money(minor(sale.cogsMinor), { bare: true })}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-content-muted">Profit</p>
          <p
            className={`tabular mt-1 text-xl font-semibold ${profit < 0 ? 'text-danger' : 'text-success'}`}
          >
            {money(minor(profit), { bare: true })}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-content-muted">Still owing</p>
          <p
            className={`tabular mt-1 text-xl font-semibold ${sale.outstandingMinor > 0 ? 'text-warning' : 'text-content'}`}
          >
            {money(sale.outstandingMinor, { bare: true })}
          </p>
        </Card>
      </div>

      {sale.customerName && (
        <Card className="mb-4">
          <p className="text-sm text-content-muted">Customer</p>
          <p className="mt-0.5">
            <Link
              href={`/customers/${sale.customerId}`}
              className="font-medium text-accent hover:underline"
            >
              {sale.customerName}
            </Link>
            {sale.customerPhone && (
              <span className="ml-2 text-sm text-content-subtle">{sale.customerPhone}</span>
            )}
          </p>
        </Card>
      )}

      <h2 className="mb-3 text-sm font-semibold text-content">Items</h2>
      <TableWrap className="mb-6">
        <THead>
          <TH>Product</TH>
          <TH numeric>Qty</TH>
          <TH numeric>Price</TH>
          <TH numeric>Discount</TH>
          <TH numeric>Total</TH>
          <TH numeric>Cost</TH>
        </THead>
        <tbody>
          {sale.items.map((item) => (
            <TR key={item.id}>
              <TD>
                <span className="font-medium text-content">{item.productName}</span>
              </TD>
              <TD numeric>{quantity(makeQty(item.qtyMilli), item.unit)}</TD>
              <TD numeric>{money(minor(item.unitPriceMinor), { bare: true })}</TD>
              <TD numeric>
                {item.discountMinor > 0 ? money(minor(item.discountMinor), { bare: true }) : '—'}
              </TD>
              <TD numeric>{money(minor(item.lineTotalMinor), { bare: true })}</TD>
              <TD numeric>
                <span className="text-content-muted">
                  {money(minor(item.totalCostMinor), { bare: true })}
                </span>
              </TD>
            </TR>
          ))}
          <TR className="bg-surface-sunken font-semibold">
            <TD>Total</TD>
            <TD />
            <TD />
            <TD numeric>
              {sale.discountMinor > 0 ? money(minor(sale.discountMinor), { bare: true }) : '—'}
            </TD>
            <TD numeric>{money(minor(sale.totalMinor), { bare: true })}</TD>
            <TD numeric>{money(minor(sale.cogsMinor), { bare: true })}</TD>
          </TR>
        </tbody>
      </TableWrap>

      <h2 className="mb-3 text-sm font-semibold text-content">Payment</h2>
      <TableWrap className="mb-6">
        <THead>
          <TH>Method</TH>
          <TH>Reference</TH>
          <TH numeric>Amount</TH>
        </THead>
        <tbody>
          {sale.tenders.length === 0 && (
            <TR>
              <TD className="text-content-muted">Nothing paid at the time of sale</TD>
              <TD />
              <TD numeric>0.00</TD>
            </TR>
          )}
          {sale.tenders.map((tender) => (
            <TR key={tender.id}>
              <TD>{tender.accountName}</TD>
              <TD>
                <span className="text-content-subtle">{tender.reference ?? '—'}</span>
              </TD>
              <TD numeric>{money(minor(tender.amountMinor), { bare: true })}</TD>
            </TR>
          ))}
          <TR className="bg-surface-sunken font-semibold">
            <TD>Received at the till</TD>
            <TD />
            <TD numeric>{money(minor(tendered), { bare: true })}</TD>
          </TR>
        </tbody>
      </TableWrap>

      <h2 className="mb-3 text-sm font-semibold text-content">Accounting entry</h2>
      {lines.length === 0 ? (
        <Card>
          <p className="text-sm text-content-muted">No accounting entry is linked to this sale.</p>
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

      {returnable.length > 0 && can(user, 'sales', 'create') && (
        <div className="mt-8">
          <ReturnForm
            action={createCustomerReturnAction.bind(null, saleId)}
            items={returnable.map((item) => ({
              id: item.id,
              productName: item.productName,
              unit: item.unit,
              returnableMilli: item.returnableMilli,
              unitAmountMinor: item.unitPriceMinor,
            }))}
            accounts={payAccounts}
            today={toBusinessDate()}
            currencyCode={currency}
            title="Customer return"
            description="Take some or all of these goods back. Stock returns at the cost it left at, so profit is unaffected."
            submitLabel="Record customer return"
            creditLabel="reduces what the customer owes"
          />
        </div>
      )}

      {sale.status === 'POSTED' &&
        sale.kind === 'SALE' &&
        sale.voidsSaleId === null &&
        can(user, 'sales', 'void') && (
          <div className="mt-6">
            <VoidSaleForm saleId={sale.id} reference={sale.receiptNo} />
          </div>
        )}
    </div>
  );
}
