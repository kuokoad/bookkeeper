import type { Metadata } from 'next';
import Link from 'next/link';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { ADJUSTMENT_REASONS } from '@/db/schema/inventory';
import { requirePageAccess } from '@/lib/auth/current-user';
import { listProducts } from '@/services/catalog.service';
import {
  REASON_DEFAULT_DIRECTION,
  REASON_LABELS,
} from '@/services/stock-adjustment.service';
import { toBusinessDate, quantity } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeader } from '@/components/ui/page';
import { AdjustmentForm } from './adjustment-form';

export const metadata: Metadata = { title: 'New stock adjustment' };
export const dynamic = 'force-dynamic';

export default async function NewAdjustmentPage() {
  await requirePageAccess('inventory', 'create');

  const products = listProducts(db)
    .filter((product) => product.trackInventory)
    .map((product) => ({
      id: product.id,
      name: product.name,
      unit: product.unit,
      qtyOnHandLabel: `${quantity(product.qtyOnHand, product.unit)} on hand`,
    }));

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();

  const reasons = ADJUSTMENT_REASONS.map((value) => ({
    value,
    label: REASON_LABELS[value],
    defaultDirection: REASON_DEFAULT_DIRECTION[value],
  }));

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Stock adjustment"
        description="Record stock that came in or went out for any reason other than a sale or purchase."
      />

      {products.length === 0 ? (
        <EmptyState
          title="No stock-tracked products yet"
          description="Add a product first, then come back to record its opening stock."
          action={
            <Link href="/products/new">
              <Button>Add a product</Button>
            </Link>
          }
        />
      ) : (
        <AdjustmentForm
          products={products}
          reasons={reasons}
          today={toBusinessDate()}
          currencyCode={settings?.currencyCode ?? 'GHS'}
        />
      )}
    </div>
  );
}
