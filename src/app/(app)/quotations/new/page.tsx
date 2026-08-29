import type { Metadata } from 'next';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requirePageAccess } from '@/lib/auth/current-user';
import { listProducts } from '@/services/catalog.service';
import { listCustomers } from '@/services/customer.service';
import { createQuotationAction } from '@/actions/quotation.actions';
import { addDays } from '@/domain/business-date';
import { toBusinessDate } from '@/lib/format';
import { PageHeader } from '@/components/ui/page';
import { QuoteEditor } from '../quote-editor';

export const metadata: Metadata = { title: 'New quote' };
export const dynamic = 'force-dynamic';

export default async function NewQuotationPage() {
  await requirePageAccess('quotations', 'create');

  const today = toBusinessDate();
  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="New quote"
        description="A price the customer can take away. Nothing is sold and no stock moves until they accept."
      />
      <QuoteEditor
        action={createQuotationAction}
        submitLabel="Save quote"
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
          businessDate: today,
          // A month is the usual promise in a trade where prices move.
          validUntil: addDays(today, 30),
          customerName: '',
          customerId: null,
          customerPhone: '',
          reference: '',
          notes: '',
          quoteDiscount: '',
          lines: [],
        }}
      />
    </div>
  );
}
