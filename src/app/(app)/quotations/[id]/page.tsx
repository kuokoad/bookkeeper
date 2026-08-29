import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getQuotation, isExpired } from '@/services/quotation.service';
import { listPaymentAccounts } from '@/services/payment-account.service';
import { isDomainError } from '@/domain/errors';
import { formatDate, money, quantity, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import { qty as makeQty } from '@/domain/quantity';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, PageHeader } from '@/components/ui/page';
import { ConvertPanel } from './convert-panel';

export const metadata: Metadata = { title: 'Quote' };
export const dynamic = 'force-dynamic';

export default async function QuotationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; cancelled?: string }>;
}) {
  const user = await requirePageAccess('quotations', 'view');
  const { id } = await params;
  const flags = await searchParams;

  const quotationId = Number(id);
  if (!Number.isInteger(quotationId) || quotationId <= 0) notFound();

  let quote;
  try {
    quote = getQuotation(db, quotationId);
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const currency = settings?.currencyCode ?? 'GHS';
  const today = toBusinessDate();
  const expired = isExpired(quote, today);
  const mayConvert = can(user, 'quotations', 'create') && quote.status === 'OPEN';

  const statusLabel =
    quote.status === 'CONVERTED'
      ? 'Became a sale'
      : quote.status === 'CANCELLED'
        ? 'Cancelled'
        : expired
          ? 'Open, expired'
          : 'Open';

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={`Quote ${quote.quoteNo}`}
        description={`For ${quote.customerName}${quote.reference ? ` · ${quote.reference}` : ''}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/quotations">
              <Button variant="secondary" size="sm">
                All quotes
              </Button>
            </Link>
            <Link href={`/quotations/${quotationId}/print`}>
              <Button variant="secondary" size="sm">
                Print
              </Button>
            </Link>
            {quote.status === 'OPEN' && can(user, 'quotations', 'edit') && (
              <Link href={`/quotations/${quotationId}/edit`}>
                <Button variant="secondary" size="sm">
                  Change
                </Button>
              </Link>
            )}
          </div>
        }
      />

      {flags.saved === '1' && (
        <Alert tone="success" className="mb-4">
          Quote saved.
        </Alert>
      )}
      {flags.cancelled === '1' && (
        <Alert tone="info" className="mb-4">
          Quote cancelled. It stays on file and can still be printed.
        </Alert>
      )}

      {quote.status === 'CONVERTED' && quote.convertedSaleId !== null && (
        <Alert tone="success" title="This quote became a sale" className="mb-4">
          <Link href={`/sales/${quote.convertedSaleId}`} className="font-medium underline">
            Open the sale
          </Link>
          {quote.overrideReason !== null && (
            <p className="mt-1">
              It was past its date when it was honoured: {quote.overrideReason}
            </p>
          )}
        </Alert>
      )}

      {quote.status === 'CANCELLED' && (
        <Alert tone="warning" title="This quote was cancelled" className="mb-4">
          {quote.cancelReason}
        </Alert>
      )}

      {expired && quote.status === 'OPEN' && (
        <Alert tone="warning" title="This quote has run out" className="mb-4">
          It was good until {formatDate(quote.validUntil)}. Prices may have moved since. You can
          still turn it into a sale, but you will be asked why.
        </Alert>
      )}

      <Card className="mb-4">
        <dl className="grid gap-4 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-content-muted">Issued</dt>
            <dd className="mt-0.5 text-sm font-medium text-content">
              {formatDate(quote.businessDate)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-content-muted">Valid until</dt>
            <dd
              className={`mt-0.5 text-sm font-medium ${expired ? 'text-warning' : 'text-content'}`}
            >
              {formatDate(quote.validUntil)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-content-muted">Status</dt>
            <dd className="mt-0.5 text-sm font-medium text-content">{statusLabel}</dd>
          </div>
          <div>
            <dt className="text-xs text-content-muted">Total</dt>
            <dd className="tabular mt-0.5 text-sm font-semibold text-content">
              {money(minor(quote.totalMinor), { currencyCode: currency })}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="mb-4">
        <h2 className="mb-3 text-sm font-semibold text-content">Items</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-content-muted">
                <th className="pb-2 font-medium">Item</th>
                <th className="pb-2 text-right font-medium">Qty</th>
                <th className="pb-2 text-right font-medium">Price</th>
                <th className="pb-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {quote.items.map((item) => (
                <tr key={item.id} className="border-b border-line">
                  <td className="py-2 text-content">{item.productName}</td>
                  <td className="tabular py-2 text-right text-content">
                    {quantity(makeQty(item.qtyMilli))} {item.unit}
                  </td>
                  <td className="tabular py-2 text-right text-content">
                    {money(minor(item.unitPriceMinor), { currencyCode: currency })}
                  </td>
                  <td className="tabular py-2 text-right font-medium text-content">
                    {money(minor(item.lineTotalMinor), { currencyCode: currency })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="mt-4 ml-auto max-w-xs space-y-1.5 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-content-muted">Subtotal</dt>
            <dd className="tabular text-content">{money(minor(quote.subtotalMinor), { currencyCode: currency })}</dd>
          </div>
          {quote.discountMinor > 0 && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-content-muted">Discount</dt>
              <dd className="tabular text-content">
                &minus;{money(minor(quote.discountMinor), { currencyCode: currency })}
              </dd>
            </div>
          )}
          {quote.taxMinor > 0 && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-content-muted">Tax</dt>
              <dd className="tabular text-content">{money(minor(quote.taxMinor), { currencyCode: currency })}</dd>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
            <dt className="font-medium text-content">Total</dt>
            <dd className="tabular font-semibold text-content">
              {money(minor(quote.totalMinor), { currencyCode: currency })}
            </dd>
          </div>
        </dl>

        {quote.notes !== null && quote.notes !== '' && (
          <p className="mt-4 border-t border-line pt-3 text-sm text-content-muted">{quote.notes}</p>
        )}
      </Card>

      {mayConvert && (
        <ConvertPanel
          quotationId={quotationId}
          customerName={quote.customerName}
          hasCustomer={quote.customerId !== null}
          totalMinor={quote.totalMinor}
          currencyCode={currency}
          expired={expired}
          validUntil={quote.validUntil}
          today={today}
          canCancel={can(user, 'quotations', 'void')}
          accounts={listPaymentAccounts(db).map((account) => ({
            id: account.id,
            name: account.name,
          }))}
          defaultTermsDays={settings?.defaultTermsDays ?? 30}
        />
      )}
    </div>
  );
}
