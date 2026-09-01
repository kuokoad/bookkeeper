import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getSale } from '@/services/sale.service';
import { formatDate, formatTime, money, quantity } from '@/lib/format';
import { minor } from '@/domain/money';
import { saleDocumentTotals } from '@/domain/sales/present';
import { qty as makeQty } from '@/domain/quantity';
import { isDomainError } from '@/domain/errors';
import { Button } from '@/components/ui/button';
import { PrintButton } from './print-button';

export const metadata: Metadata = { title: 'Receipt' };
export const dynamic = 'force-dynamic';

/**
 * The paper a receipt comes out on, which is not the paper everything else uses.
 *
 * `size: auto` overrides the A4 default in globals.css and means "whichever
 * paper is chosen in the print dialog". On the A4 printer a shop has today the
 * receipt prints down the top of a sheet; on an 80mm till roll bought next year
 * it fills the roll, with nothing in this application to change on the day it is
 * plugged in.
 *
 * `size: A4` here instead would be wrong the moment a roll appears, and a fixed
 * `80mm auto` would be wrong right now. Neither guess is needed: the person
 * standing at the printer already told the dialog which paper they loaded.
 *
 * The margin has to adapt for the same reason the size does. In print a media
 * query measures the PAGE, so `min-width: 120mm` asks "is this a sheet or a
 * roll?" — nothing narrower than 120mm is a sheet, and nothing wider is a roll.
 * A roll gets 4mm, because 14mm off each side of 80mm would throw away a third
 * of the paper. A sheet gets the same 14mm as every other document, because
 * 4mm on A4 runs the figures out to the edge, where printers cannot mark and
 * the last column risks being clipped.
 *
 * Scoped by being on this route. `@page` cannot be scoped to a component, but a
 * receipt is its own address, so this rule only ever reaches the browser when a
 * receipt is what is on screen.
 */
const RECEIPT_PAGE_CSS = `
@page { size: auto; margin: 0; }
@media print { body { padding: 4mm; } }
@media print and (min-width: 120mm) { body { padding: 14mm; } }
`;

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
  // Presented as the sale was transacted: the ledger stores every sale net of
  // tax, which would otherwise print a subtotal contradicting the lines above.
  const totals = saleDocumentTotals(
    sale,
    sale.items.map((item) => item.lineTotalMinor),
  );

  return (
    <div className="mx-auto max-w-md">
      <style>{RECEIPT_PAGE_CSS}</style>
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
            {settings?.businessName ?? 'NunaBooks'}
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
            {/*
              The trading date, not the moment the row was written. `occurredAt`
              defaults to `new Date()` at the till, so the two agree on a sale
              rung up as it happens and diverge on every one that is not —
              yesterday's takings entered this morning, or a quotation converted
              today for the day it was agreed. The date belongs to the sale, so
              it comes from `businessDate`, the same column every list, report
              and filter reads; only the time of day comes from `occurredAt`.
              This is the format the sales list already prints.
            */}
            <span className="text-content">
              {formatDate(sale.businessDate)} {formatTime(sale.occurredAt)}
            </span>
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
              {money(totals.subtotal, { bare: true })}
            </dd>
          </div>
          {totals.discount > 0 && (
            <div className="flex justify-between">
              <dt className="text-content-muted">Discount</dt>
              <dd className="tabular text-content">
                −{money(totals.discount, { bare: true })}
              </dd>
            </div>
          )}
          {/*
            Added on top only when the shelf prices excluded it. One line per
            tax: a VAT invoice has to show each separately, and the names come
            from the sale itself rather than from today's settings.
          */}
          {!totals.taxWithinTotal &&
            sale.taxes.map(
              (line) =>
                line.amountMinor !== 0 && (
                  <div key={line.id} className="flex justify-between">
                    <dt className="text-content-muted">{line.name}</dt>
                    <dd className="tabular text-content">
                      {money(minor(line.amountMinor), { bare: true })}
                    </dd>
                  </div>
                ),
            )}
          <div className="flex justify-between border-t border-line pt-1 text-base font-semibold">
            <dt className="text-content">Total</dt>
            <dd className="tabular text-content">
              {money(totals.total, { currencyCode: currency })}
            </dd>
          </div>
          {totals.taxWithinTotal &&
            sale.taxes.map(
              (line) =>
                line.amountMinor !== 0 && (
                  <div key={line.id} className="flex justify-between text-xs">
                    <dt className="text-content-muted">includes {line.name}</dt>
                    <dd className="tabular text-content-muted">
                      {money(minor(line.amountMinor), { bare: true })}
                    </dd>
                  </div>
                ),
            )}
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
