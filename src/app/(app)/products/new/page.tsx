import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getFeatures } from '@/lib/business-type.server';
import { listCategories } from '@/services/catalog.service';
import { createProductAction } from '@/actions/catalog.actions';
import { PageHeader } from '@/components/ui/page';
import { ProductForm } from '../product-form';

export const metadata: Metadata = { title: 'Add product' };
export const dynamic = 'force-dynamic';

export default async function NewProductPage() {
  await requirePageAccess('products', 'create');

  const categories = listCategories(db).map((category) => ({
    id: category.id,
    name: category.name,
  }));
  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Add product" description="Something new to sell." />
      <ProductForm
        offerExpiry={getFeatures().expiry_batches}
        action={createProductAction}
        categories={categories}
        currencyCode={settings?.currencyCode ?? 'GHS'}
        submitLabel="Create product"
        showStockNotice
        initial={{
          name: '',
          sku: '',
          barcode: '',
          categoryId: '',
          unit: 'pcs',
          description: '',
          costPrice: '0.00',
          sellingPrice: '0.00',
          minStock: '',
          warnDays: '',
          trackInventory: true,
        }}
      />
    </div>
  );
}
