import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import Link from 'next/link';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings, paymentAccounts } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { listProducts } from '@/services/catalog.service';
import { getExpiryOutlook } from '@/services/inventory.service';
import { listCustomers } from '@/services/customer.service';
import { toBusinessDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeader } from '@/components/ui/page';
import { Pos } from './pos';
import { getTaxProfile } from '@/services/tax.service';

export const metadata: Metadata = { title: 'New sale' };
export const dynamic = 'force-dynamic';

export default async function NewSalePage() {
  const user = await requirePageAccess('sales', 'create');

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();

  // One aggregate for the whole catalogue rather than a query per line: the
  // till renders every product and cannot afford the second shape.
  const today = toBusinessDate(new Date());
  const outlook = getExpiryOutlook(db, today);

  const products = listProducts(db, { limit: 500 }).map((product) => {
    const dates = outlook.get(product.id);
    return {
      id: product.id,
      name: product.name,
      sku: product.sku,
      barcode: product.barcode,
      unit: product.unit,
      sellingPrice: product.sellingPrice as number,
      qtyOnHandMilli: product.qtyOnHand as number,
      trackInventory: product.trackInventory,
      goodQtyMilli: dates?.goodQtyMilli ?? 0,
      soonestExpiry: dates?.soonestExpiry ?? null,
    };
  });

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
          taxComponents={getTaxProfile(db).components}
          taxInclusive={settings?.taxInclusive ?? false}
          mayOverridePrice={can(user, 'sales', 'edit')}
          maySellExpired={can(user, 'inventory', 'void')}
          expiryWarningDays={settings?.expiryWarningDays ?? 30}
          expiryBlocksSales={settings?.expiryBlocksSales ?? true}
          cartSeed={randomUUID()}
        />
      )}
    </div>
  );
}
