import type { Metadata } from 'next';
import Link from 'next/link';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { ADJUSTMENT_REASONS } from '@/db/schema/inventory';
import { requirePageAccess } from '@/lib/auth/current-user';
import { listProducts } from '@/services/catalog.service';
import { listExpiredBatches } from '@/services/inventory.service';
import {
  REASON_DEFAULT_DIRECTION,
  REASON_LABELS,
} from '@/services/stock-adjustment.service';
import { formatDate, toBusinessDate, quantity } from '@/lib/format';
import { qty as makeQty } from '@/domain/quantity';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeader } from '@/components/ui/page';
import { AdjustmentForm } from './adjustment-form';

export const metadata: Metadata = { title: 'New stock adjustment' };
export const dynamic = 'force-dynamic';

export default async function NewAdjustmentPage() {
  await requirePageAccess('inventory', 'create');

  // Which crates have actually turned, so a write-off can name one instead of
  // taking the stock out of whatever happens to expire soonest — the good crate.
  const today = toBusinessDate();
  const expired = listExpiredBatches(db, today);

  const products = listProducts(db)
    .filter((product) => product.trackInventory)
    .map((product) => ({
      id: product.id,
      name: product.name,
      unit: product.unit,
      qtyOnHandLabel: `${quantity(product.qtyOnHand, product.unit)} on hand`,
      expiredBatches: expired
        .filter((batch) => batch.productId === product.id)
        .map((batch) => ({
          id: batch.id,
          label: `${batch.batchRef} — ${quantity(makeQty(batch.qtyMilli), product.unit)}, expired ${formatDate(batch.expiryDate)}`,
        })),
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
