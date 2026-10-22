import type { Metadata } from 'next';
import Link from 'next/link';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings, paymentAccounts, units } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { defaultFeatures, featuresFromRow } from '@/lib/business-type';
import { listProducts } from '@/services/catalog.service';
import { listSuppliers } from '@/services/supplier.service';
import { getTaxProfile } from '@/services/tax.service';
import { QTY_DECIMALS } from '@/domain/quantity';
import { toBusinessDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeader } from '@/components/ui/page';
import { PurchaseEntry } from './purchase-entry';

export const metadata: Metadata = { title: 'New purchase' };
export const dynamic = 'force-dynamic';

export default async function NewPurchasePage() {
  await requirePageAccess('purchases', 'create');

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const suppliers = listSuppliers(db).map((supplier) => ({
    id: supplier.id,
    name: supplier.name,
    balanceMinor: supplier.balance as number,
  }));

  // Each product's unit is a foreign key to units.symbol, so the exact symbol
  // finds it. The screen refuses 1.5 Pcs before Save rather than after.
  const decimals = new Map(
    db
      .select({ symbol: units.symbol, decimalPlaces: units.decimalPlaces })
      .from(units)
      .all()
      .map((unit) => [unit.symbol, unit.decimalPlaces]),
  );
  const decimalsOf = (symbol: string) => decimals.get(symbol) ?? QTY_DECIMALS;

  const products = listProducts(db, { limit: 500 }).map((product) => ({
    id: product.id,
    name: product.name,
    unit: product.unit,
    altUnit: product.altUnit,
    altFactorMilli: product.altFactor as number | null,
    costPrice: product.costPrice as number,
    altCostPrice: product.altCostPrice as number | null,
    qtyOnHandMilli: product.qtyOnHand as number,
    unitDecimals: decimalsOf(product.unit),
    altUnitDecimals: product.altUnit === null ? null : decimalsOf(product.altUnit),
    trackInventory: product.trackInventory,
  }));

  const accounts = db
    .select()
    .from(paymentAccounts)
    .where(eq(paymentAccounts.isActive, true))
    .orderBy(paymentAccounts.sortOrder)
    .all()
    .map((account) => ({ id: account.id, name: account.name, isDefault: account.isDefault }));

  if (suppliers.length === 0) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="New purchase" />
        <EmptyState
          title="Add a supplier first"
          description="A purchase records what you bought and from whom, so the money you owe can be tracked."
          action={
            <Link href="/suppliers/new">
              <Button>Add a supplier</Button>
            </Link>
          }
        />
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="New purchase" />
        <EmptyState
          title="Add a product first"
          description="You can only record a purchase of something already in your product list."
          action={
            <Link href="/products/new">
              <Button>Add a product</Button>
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="New purchase"
        description="Record a delivery. Stock goes up at the price you actually paid."
        actions={
          <Link href="/purchases">
            <Button variant="secondary" size="sm">
              All purchases
            </Button>
          </Link>
        }
      />
      <PurchaseEntry
        products={products}
        suppliers={suppliers}
        accounts={accounts}
        today={toBusinessDate()}
        currencyCode={settings?.currencyCode ?? 'GHS'}
        taxComponents={getTaxProfile(db).components}
        lockedBefore={settings?.booksLockedBefore ?? null}
        offerExpiry={
          settings ? featuresFromRow(settings).expiry_batches : defaultFeatures('general_retail').expiry_batches
        }
      />
    </div>
  );
}
