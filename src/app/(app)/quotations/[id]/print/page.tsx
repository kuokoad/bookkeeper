import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getQuotation, isExpired } from '@/services/quotation.service';
import { isDomainError } from '@/domain/errors';
import { formatDate, money, quantity, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import { qty as makeQty } from '@/domain/quantity';
import { Button } from '@/components/ui/button';
import { PrintButton } from '../../../sales/[id]/receipt/print-button';

export const metadata: Metadata = { title: 'Quote' };
export const dynamic = 'force-dynamic';

/**
 * The paper a contractor walks out with.
 *
 * Deliberately a document rather than a screen: no card, no chrome, A4 with the
 * margins set in globals.css. It says three things a quote must say and an
 * invoice need not — what the price is, when it stops being promised, and that
 * nothing has been sold yet.
 */
export default async function QuotationPrintPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess('quotations', 'view');
  const { id } = await params;

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
  const cash = (value: number) => money(minor(value), { currencyCode: currency });
  const expired = isExpired(quote, toBusinessDate());

  return (
    <div className="mx-auto max-w-3xl">
      <div className="no-print mb-4 flex items-center justify-between gap-2">
        <Link href={`/quotations/${quotationId}`}>
          <Button variant="secondary" size="sm">
            Back
          </Button>
        </Link>
        <PrintButton />
      </div>

      <article className="rounded-xl border border-line bg-surface-raised p-6 text-sm">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-4">
          <div className="min-w-0">
            {settings?.logoData && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src="/api/logo"
                alt=""
                className="mb-2 max-h-14 max-w-36 object-contain"
              />
            )}
            <p className="text-lg font-semibold text-content">
              {settings?.businessName ?? 'NunaBooks'}
            </p>
            {settings?.tagline && <p className="text-content-muted">{settings.tagline}</p>}
            {settings?.address && <p className="text-content-muted">{settings.address}</p>}
            {settings?.phone && <p className="text-content-muted">{settings.phone}</p>}
          </div>

          <div className="text-right">
            <p className="text-xs font-semibold uppercase tracking-wider text-content-muted">
              Quotation
            </p>
            <p className="text-xl font-semibold text-content">{quote.quoteNo}</p>
            <p className="mt-1 text-content-muted">Issued {formatDate(quote.businessDate)}</p>
            <p className="font-medium text-content">Valid until {formatDate(quote.validUntil)}</p>
          </div>
        </header>

        <section className="border-b border-line py-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-content-muted">
            Prepared for
          </p>
          <p className="font-semibold text-content">{quote.customerName}</p>
          {quote.customerPhone && <p className="text-content-muted">{quote.customerPhone}</p>}
          {quote.reference && <p className="text-content-muted">{quote.reference}</p>}
        </section>

        <table className="w-full py-4">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-content-muted">
              <th className="py-3 font-semibold">Item</th>
              <th className="py-3 text-right font-semibold">Qty</th>
              <th className="py-3 text-right font-semibold">Price</th>
              <th className="py-3 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {quote.items.map((item) => (
              <tr key={item.id} className="border-b border-line">
                <td className="py-2.5 text-content">{item.productName}</td>
                <td className="tabular py-2.5 text-right text-content">
                  {quantity(makeQty(item.qtyMilli))} {item.unit}
                </td>
                <td className="tabular py-2.5 text-right text-content">
                  {cash(item.unitPriceMinor)}
                </td>
                <td className="tabular py-2.5 text-right text-content">
                  {cash(item.lineTotalMinor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="ml-auto max-w-xs space-y-1.5 pt-4">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-content-muted">Subtotal</dt>
            <dd className="tabular text-content">{cash(quote.subtotalMinor)}</dd>
          </div>
          {quote.discountMinor > 0 && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-content-muted">Discount</dt>
              <dd className="tabular text-content">&minus;{cash(quote.discountMinor)}</dd>
            </div>
          )}
          {quote.taxMinor > 0 && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-content-muted">
                Tax{quote.taxInclusive ? ' (included)' : ''}
              </dt>
              <dd className="tabular text-content">{cash(quote.taxMinor)}</dd>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
            <dt className="font-semibold text-content">Total</dt>
            <dd className="tabular text-lg font-semibold text-content">
              {cash(quote.totalMinor)}
            </dd>
          </div>
        </dl>

        <footer className="mt-6 border-t border-line pt-4 text-content-muted">
          {quote.notes && <p className="mb-2 text-content">{quote.notes}</p>}
          {/*
            The sentence that makes this a quote rather than a bill. Without it
            a customer holding an itemised total with a shop's name on top could
            reasonably think they had been invoiced.
          */}
          <p>
            This is a quotation, not a bill. Nothing has been sold and no payment is due.
            {quote.status === 'CONVERTED' ? '' : ` Prices hold until ${formatDate(quote.validUntil)}.`}
          </p>
          {expired && (
            <p className="mt-1 font-medium text-content">
              This quote has passed its date. Please ask us to confirm the price before ordering.
            </p>
          )}
          {quote.status === 'CANCELLED' && (
            <p className="mt-1 font-medium text-content">This quote was withdrawn.</p>
          )}
          {quote.status === 'CONVERTED' && (
            <p className="mt-1 font-medium text-content">
              This quote has been accepted and invoiced.
            </p>
          )}
          {settings?.phone && <p className="mt-2">Questions? Call {settings.phone}.</p>}
        </footer>
      </article>
    </div>
  );
}
