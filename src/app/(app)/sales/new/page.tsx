import type { Metadata } from 'next';
import Link from 'next/link';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings, paymentAccounts } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { listProducts } from '@/services/catalog.service';
import { listCustomers } from '@/services/customer.service';
import { toBusinessDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeader } from '@/components/ui/page';
import { Pos } from './pos';

export const metadata: Metadata = { title: 'New sale' };
export const dynamic = 'force-dynamic';

export default async function NewSalePage() {
  await requirePageAccess('sales', 'create');

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();

  const products = listProducts(db, { limit: 500 }).map((product) => ({
    id: product.id,
    name: product.name,
    sku: product.sku,
    barcode: product.barcode,
    unit: product.unit,
    sellingPrice: product.sellingPrice as number,
    qtyOnHandMilli: product.qtyOnHand as number,
    trackInventory: product.trackInventory,
  }));

  const customers = listCustomers(db).map((customer) => ({
    id: customer.id,
    name: customer.name,
    balanceMinor: customer.balance as number,
  }));

  const accounts = db
    .select()
    .from(paymentAccounts)
    .where(eq(paymentAccounts.isActive, true))
    .orderBy(paymentAccounts.sortOrder)
    .all()
    .map((account) => ({
      id: account.id,
      name: account.name,
      kind: account.kind,
      isDefault: account.isDefault,
    }));

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="New sale"
        description="Search or scan, take payment, done."
        actions={
          <Link href="/sales">
            <Button variant="secondary" size="sm">
              All sales
            </Button>
          </Link>
        }
      />

      {products.length === 0 ? (
        <EmptyState
          title="No products to sell yet"
          description="Add what you sell first, then record its opening stock. After that this screen is ready."
          action={
            <Link href="/products/new">
              <Button>Add a product</Button>
            </Link>
          }
        />
      ) : (
        <Pos
          products={products}
          customers={customers}
          accounts={accounts}
          today={toBusinessDate()}
          currencyCode={settings?.currencyCode ?? 'GHS'}
          taxRateBp={settings?.taxEnabled ? (settings?.taxRateBp ?? 0) : 0}
          taxInclusive={settings?.taxInclusive ?? false}
        />
      )}
    </div>
  );
}
