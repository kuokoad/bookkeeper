import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getSale } from '@/services/sale.service';
import { formatDateTime, money, quantity } from '@/lib/format';
import { minor } from '@/domain/money';
import { qty as makeQty } from '@/domain/quantity';
import { isDomainError } from '@/domain/errors';
import { Button } from '@/components/ui/button';
import { PrintButton } from './print-button';

export const metadata: Metadata = { title: 'Receipt' };
export const dynamic = 'force-dynamic';

/**
 * A printable receipt.
 *
 * Laid out narrow so it prints sensibly on an 80mm till roll as well as on A4.
 * The `no-print` class (see globals.css) hides the navigation and buttons when
 * the page is actually printed.
 */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
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
  const tendered = sale.tenders.reduce((total, tender) => total + tender.amountMinor, 0);
  const change = Math.max(0, tendered - sale.totalMinor);

  return (
    <div className="mx-auto max-w-md">
      <div className="no-print mb-4 flex items-center justify-between gap-2">
        <Link href={`/sales/${saleId}`}>
          <Button variant="secondary" size="sm">
            Back
          </Button>
        </Link>
        <PrintButton />
      </div>

      <article className="rounded-xl border border-line bg-surface-raised p-6 text-sm">
        <header className="mb-4 text-center">
          {settings?.logoData && (
            // A plain <img>: the source is a route reading a blob from the
            // database, so there is nothing for the image optimiser to do. The
            // upload time busts the cache when the logo changes.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/logo?v=${settings.logoUpdatedAt?.getTime() ?? 0}`}
              alt=""
              className="mx-auto mb-2 max-h-16 max-w-40 object-contain"
            />
          )}
          <h1 className="text-lg font-semibold text-content">
            {settings?.businessName ?? 'Shop Bookkeeper'}
          </h1>
          {settings?.tagline && (
            <p className="text-xs text-content-muted">{settings.tagline}</p>
          )}
          {settings?.address && <p className="text-xs text-content-muted">{settings.address}</p>}
          {settings?.phone && <p className="text-xs text-content-muted">{settings.phone}</p>}
        </header>

        <div className="mb-4 border-y border-dashed border-line py-2 text-xs">
          <div className="flex justify-between">
            <span className="text-content-muted">Receipt</span>
            <span className="font-medium text-content">{sale.receiptNo}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-content-muted">Date</span>
            <span className="text-content">{formatDateTime(sale.occurredAt)}</span>
          </div>
          {sale.customerName && (
            <div className="flex justify-between">
              <span className="text-content-muted">Customer</span>
              <span className="text-content">{sale.customerName}</span>
            </div>
          )}
        </div>

        {sale.status === 'VOIDED' && (
          <p className="mb-4 border border-danger/40 bg-danger-soft px-3 py-2 text-center text-xs font-semibold text-content">
            VOIDED — {sale.voidReason}
          </p>
        )}

        <table className="mb-3 w-full">
          <thead>
            <tr className="border-b border-dashed border-line text-xs text-content-muted">
              <th scope="col" className="pb-1 text-left font-normal">
                Item
              </th>
              <th scope="col" className="pb-1 text-right font-normal">
                Qty
              </th>
              <th scope="col" className="pb-1 text-right font-normal">
                Price
              </th>
              <th scope="col" className="pb-1 text-right font-normal">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {sale.items.map((item) => (
              <tr key={item.id} className="align-top">
                <td className="py-1 pr-2 text-content">{item.productName}</td>
                <td className="tabular py-1 text-right text-content-muted">
                  {quantity(makeQty(item.qtyMilli), item.unit)}
                </td>
                <td className="tabular py-1 text-right text-content-muted">
                  {money(minor(item.unitPriceMinor), { bare: true })}
                </td>
                <td className="tabular py-1 text-right font-medium text-content">
                  {money(minor(item.lineTotalMinor), { bare: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="space-y-1 border-t border-dashed border-line pt-2">
          <div className="flex justify-between">
            <dt className="text-content-muted">Subtotal</dt>
            <dd className="tabular text-content">
              {money(minor(sale.subtotalMinor), { bare: true })}
            </dd>
          </div>
          {sale.discountMinor > 0 && (
            <div className="flex justify-between">
              <dt className="text-content-muted">Discount</dt>
              <dd className="tabular text-content">
                −{money(minor(sale.discountMinor), { bare: true })}
              </dd>
            </div>
          )}
          {sale.taxMinor > 0 && (
            <div className="flex justify-between">
              <dt className="text-content-muted">{settings?.taxLabel ?? 'Tax'}</dt>
              <dd className="tabular text-content">
                {money(minor(sale.taxMinor), { bare: true })}
              </dd>
            </div>
          )}
          <div className="flex justify-between border-t border-line pt-1 text-base font-semibold">
            <dt className="text-content">Total</dt>
            <dd className="tabular text-content">
              {money(minor(sale.totalMinor), { currencyCode: currency })}
            </dd>
          </div>
        </dl>

        <dl className="mt-3 space-y-1 border-t border-dashed border-line pt-2 text-xs">
          {sale.tenders.map((tender) => (
            <div key={tender.id} className="flex justify-between">
              <dt className="text-content-muted">Paid by {tender.accountName}</dt>
              <dd className="tabular text-content">
                {money(minor(tender.amountMinor), { bare: true })}
              </dd>
            </div>
          ))}
          {change > 0 && (
            <div className="flex justify-between font-semibold">
              <dt className="text-content">Change</dt>
              <dd className="tabular text-content">{money(minor(change), { bare: true })}</dd>
            </div>
          )}
          {sale.outstandingMinor > 0 && (
            <div className="flex justify-between font-semibold">
              <dt className="text-content">Balance owing</dt>
              <dd className="tabular text-content">
                {money(sale.outstandingMinor, { bare: true })}
              </dd>
            </div>
          )}
        </dl>

        <footer className="mt-5 border-t border-dashed border-line pt-3 text-center text-xs text-content-muted">
          <p>Thank you.</p>
          {sale.note && <p className="mt-1 italic">{sale.note}</p>}
        </footer>
      </article>
    </div>
  );
}
