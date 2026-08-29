import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getQuotation } from '@/services/quotation.service';
import { listProducts } from '@/services/catalog.service';
import { listCustomers } from '@/services/customer.service';
import { updateQuotationAction } from '@/actions/quotation.actions';
import { isDomainError } from '@/domain/errors';
import { PageHeader } from '@/components/ui/page';
import { QuoteEditor } from '../../quote-editor';

export const metadata: Metadata = { title: 'Change quote' };
export const dynamic = 'force-dynamic';

/** Money and quantities back into the boxes they were typed into. */
const major = (minorValue: number) => (minorValue / 100).toFixed(2);
const units = (milli: number) => String(milli / 1000);

export default async function EditQuotationPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess('quotations', 'edit');
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

  // A converted quote is no longer an offer, and a cancelled one has been
  // withdrawn. The service refuses both; sending them back here means nobody
  // fills in a form that was always going to be rejected on submit.
  if (quote.status !== 'OPEN') redirect(`/quotations/${quotationId}`);

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={`Change quote ${quote.quoteNo}`}
        description="The number stays the same, because the customer may be holding paper with it on."
      />
      <QuoteEditor
        action={updateQuotationAction}
        submitLabel="Save changes"
        currencyCode={settings?.currencyCode ?? 'GHS'}
        products={listProducts(db, {}).map((product) => ({
          id: product.id,
          name: product.name,
          unit: product.unit,
          sellingPrice: product.sellingPrice,
        }))}
        customers={listCustomers(db, {}).map((customer) => ({
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
        }))}
        values={{
          quotationId,
          businessDate: quote.businessDate,
          validUntil: quote.validUntil,
          customerName: quote.customerName,
          customerId: quote.customerId,
          customerPhone: quote.customerPhone ?? '',
          reference: quote.reference ?? '',
          notes: quote.notes ?? '',
          // The discount AS TYPED, not the figure stored net of tax beside it.
          quoteDiscount: quote.quoteDiscountMinor > 0 ? major(quote.quoteDiscountMinor) : '',
          lines: quote.items.map((item) => ({
            productId: item.productId,
            qty: units(item.qtyMilli),
            unitPrice: major(item.unitPriceMinor),
            discount: item.discountMinor > 0 ? major(item.discountMinor) : '',
          })),
        }}
      />
    </div>
  );
}
