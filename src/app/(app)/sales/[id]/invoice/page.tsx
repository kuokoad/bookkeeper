import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getSale } from '@/services/sale.service';
import { daysOverdue } from '@/domain/business-date';
import { isDomainError } from '@/domain/errors';
import { formatDate, money, quantity, toBusinessDate } from '@/lib/format';
import { minor } from '@/domain/money';
import { saleDocumentTotals } from '@/domain/sales/present';
import { qty as makeQty } from '@/domain/quantity';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PrintButton } from '../receipt/print-button';

export const metadata: Metadata = { title: 'Invoice' };
export const dynamic = 'force-dynamic';

/**
 * An invoice: a request for payment, not a record of one.
 *
 * The difference from the receipt is the framing, and it matters. A receipt
 * thanks someone for money received; this states what is owed, by when, and how
 * to pay. Same sale, same figures — nothing here recalculates anything.
 *
 * Only a credit sale has one. A sale settled at the counter has no invoice
 * number and nothing to request, so this page refuses rather than inventing a
 * document.
 */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess('sales', 'view');
  const { id } = await params;

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
  // Presented as the sale was transacted: the ledger stores every sale net of
  // tax, which would otherwise print a subtotal contradicting the lines above.
  const totals = saleDocumentTotals(
    sale,
    sale.items.map((item) => item.lineTotalMinor),
  );

  // A cash sale has no invoice. Say so plainly and point at the receipt.
  if (!sale.invoiceNo) {
    return (
      <div className="mx-auto max-w-xl">
        <Alert tone="info" title="This sale has no invoice">
          {sale.receiptNo} was paid in full at the time, so there is nothing to request payment
          for. Its receipt is the document for it.
        </Alert>
        <Link href={`/sales/${sale.id}/receipt`} className="mt-4 inline-block">
          <Button size="sm">Open the receipt</Button>
        </Link>
      </div>
    );
  }

  const today = toBusinessDate();
  const overdueBy = sale.dueDate ? daysOverdue(sale.dueDate, today) : 0;
  const settled = sale.outstandingMinor <= 0;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 no-print">
        <Link href={`/sales/${sale.id}`}>
          <Button variant="secondary" size="sm">
            Back to the sale
          </Button>
        </Link>
        <PrintButton />
      </div>

      {settled ? (
        <Alert tone="success" className="mb-4 no-print">
          This invoice has been paid in full. Kept for the record.
        </Alert>
      ) : overdueBy > 0 ? (
        <Alert tone="warning" className="mb-4 no-print">
          Payment was due {formatDate(sale.dueDate as string)} — {overdueBy} day
          {overdueBy === 1 ? '' : 's'} ago.
        </Alert>
      ) : null}

      <article className="rounded-xl border border-line bg-surface-raised p-6 text-sm">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {settings?.logoData && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/logo?v=${settings.logoUpdatedAt?.getTime() ?? 0}`}
                alt=""
                className="mb-2 max-h-14 max-w-36 object-contain"
              />
            )}
            <h1 className="text-lg font-semibold text-content">
              {settings?.businessName ?? 'Shop Bookkeeper'}
            </h1>
            {settings?.tagline && <p className="text-xs text-content-muted">{settings.tagline}</p>}
            {settings?.address && <p className="text-xs text-content-muted">{settings.address}</p>}
            {settings?.phone && <p className="text-xs text-content-muted">{settings.phone}</p>}
          </div>

          <div className="shrink-0 text-right">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
              Invoice
            </p>
            <p className="tabular text-lg font-semibold text-content">{sale.invoiceNo}</p>
            <p className="mt-1 text-xs text-content-muted">Issued {formatDate(sale.businessDate)}</p>
            {sale.dueDate && (
              <p className="text-xs font-medium text-content">Due {formatDate(sale.dueDate)}</p>
            )}
          </div>
        </header>

        <section className="mb-6 border-y border-line py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
            Billed to
          </p>
          <p className="font-medium text-content">{sale.customerName ?? 'Customer'}</p>
          {sale.termsDays !== null && (
            <p className="text-xs text-content-muted">
              {sale.termsDays === 0
                ? 'Payment due on receipt'
                : `Payment terms: ${sale.termsDays} days`}
            </p>
          )}
        </section>

        <table className="mb-4 w-full text-sm">
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-wide text-content-subtle">
              <th className="py-1.5 text-left font-medium">Item</th>
              <th className="py-1.5 text-right font-medium">Qty</th>
              <th className="py-1.5 text-right font-medium">Price</th>
              <th className="py-1.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {sale.items.map((item) => (
              <tr key={item.id} className="border-b border-line last:border-b-0">
                <td className="py-1.5 pr-2 text-content">{item.productName}</td>
                <td className="tabular py-1.5 text-right text-content-muted">
                  {quantity(makeQty(item.qtyMilli), item.unit)}
                </td>
                <td className="tabular py-1.5 text-right text-content-muted">
                  {money(minor(item.unitPriceMinor), { currencyCode: currency, bare: true })}
                </td>
                <td className="tabular py-1.5 text-right text-content">
                  {money(minor(item.lineTotalMinor), { currencyCode: currency, bare: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="ml-auto max-w-xs space-y-1.5">
          <div className="flex justify-between gap-4">
            <dt className="text-content-muted">Subtotal</dt>
            <dd className="tabular text-content">
              {money(totals.subtotal, { currencyCode: currency, bare: true })}
            </dd>
          </div>
          {totals.discount > 0 && (
            <div className="flex justify-between gap-4">
              <dt className="text-content-muted">Discount</dt>
              <dd className="tabular text-content">
                −{money(totals.discount, { currencyCode: currency, bare: true })}
              </dd>
            </div>
          )}
          {/* Added on top only when the quoted prices excluded it. */}
          {totals.tax > 0 && !totals.taxWithinTotal && (
            <div className="flex justify-between gap-4">
              <dt className="text-content-muted">{settings?.taxLabel ?? 'Tax'}</dt>
              <dd className="tabular text-content">
                {money(totals.tax, { currencyCode: currency, bare: true })}
              </dd>
            </div>
          )}
          <div className="flex justify-between gap-4 border-t border-line pt-1.5">
            <dt className="font-semibold text-content">Total</dt>
            <dd className="tabular font-semibold text-content">
              {money(totals.total, { currencyCode: currency })}
            </dd>
          </div>
          {totals.tax > 0 && totals.taxWithinTotal && (
            <div className="flex justify-between gap-4 text-xs">
              <dt className="text-content-muted">includes {settings?.taxLabel ?? 'Tax'}</dt>
              <dd className="tabular text-content-muted">
                {money(totals.tax, { currencyCode: currency, bare: true })}
              </dd>
            </div>
          )}
          {sale.totalMinor - sale.outstandingMinor > 0 && (
            <div className="flex justify-between gap-4">
              <dt className="text-content-muted">Already paid</dt>
              <dd className="tabular text-content">
                −
                {money(minor(sale.totalMinor - sale.outstandingMinor), {
                  currencyCode: currency,
                  bare: true,
                })}
              </dd>
            </div>
          )}
          <div className="flex justify-between gap-4 border-t-2 border-line-strong pt-1.5">
            <dt className="font-semibold text-content">Amount due</dt>
            <dd className="tabular text-lg font-semibold text-content">
              {money(minor(sale.outstandingMinor), { currencyCode: currency })}
            </dd>
          </div>
        </dl>

        <footer className="mt-6 border-t border-line pt-4 text-xs text-content-muted">
          {settled ? (
            <p>Paid in full. Thank you.</p>
          ) : (
            <p>
              Please pay {money(minor(sale.outstandingMinor), { currencyCode: currency })}
              {sale.dueDate ? ` by ${formatDate(sale.dueDate)}` : ''}. Quote{' '}
              <span className="font-medium text-content">{sale.invoiceNo}</span> when you pay.
            </p>
          )}
          {settings?.phone && <p className="mt-1">Questions? Call {settings.phone}.</p>}
        </footer>
      </article>
    </div>
  );
}
