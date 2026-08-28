import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings, products } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getFeatures } from '@/lib/business-type.server';
import { getProduct, listCategories } from '@/services/catalog.service';
import { updateProductAction } from '@/actions/catalog.actions';
import { PageHeader } from '@/components/ui/page';
import { toInputString } from '@/domain/money';
import { toQtyInputString } from '@/domain/quantity';
import { ProductForm } from '../../product-form';

export const metadata: Metadata = { title: 'Edit product' };
export const dynamic = 'force-dynamic';

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess('products', 'edit');

  const { id } = await params;
  const productId = Number(id);
  if (!Number.isInteger(productId) || productId <= 0) notFound();

  const exists = db.select({ id: products.id }).from(products).where(eq(products.id, productId)).get();
  if (!exists) notFound();

  const product = getProduct(db, productId);
  const categories = listCategories(db, true).map((category) => ({
    id: category.id,
    name: category.name,
  }));
  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();

  // `bind` gives the action the product id without putting it in a hidden field
  // where the browser could change which product is edited.
  const action = updateProductAction.bind(null, productId);

  const row = db.select().from(products).where(eq(products.id, productId)).get();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Edit product" description={product.name} />
      <ProductForm
        offerExpiry={getFeatures().expiry_batches}
        action={action}
        categories={categories}
        currencyCode={settings?.currencyCode ?? 'GHS'}
        submitLabel="Save changes"
        showStockNotice={false}
        initial={{
          name: product.name,
          sku: product.sku ?? '',
          barcode: product.barcode ?? '',
          categoryId: product.categoryId ? String(product.categoryId) : '',
          unit: product.unit,
          description: row?.description ?? '',
          costPrice: toInputString(product.costPrice),
          sellingPrice: toInputString(product.sellingPrice),
          minStock: product.minStock === null ? '' : toQtyInputString(product.minStock),
          warnDays: product.warnDays === null ? '' : String(product.warnDays),
          trackInventory: product.trackInventory,
        }}
      />
    </div>
  );
}
