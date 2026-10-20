import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { listUnits } from '@/services/units.service';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page';
import { UnitForm } from './unit-form';

export const metadata: Metadata = { title: 'Units' };
export const dynamic = 'force-dynamic';

export default async function UnitsPage() {
  const user = await requirePageAccess('products', 'view');
  const units = listUnits(db);
  const canCreate = can(user, 'products', 'create');
  const canEdit = can(user, 'products', 'edit');

  return (
    <div className="w-full">
      <PageHeader
        title="Units"
        description="What stock is counted in, and how many decimals each allows. Pcs takes 0, Kg takes 3."
        actions={
          <Link href="/products">
            <Button variant="secondary" size="sm">
              Back to products
            </Button>
          </Link>
        }
      />

      {canCreate && <UnitForm unit={null} />}

      <div className="mt-6 space-y-2">
        {units.map((unit) =>
          canEdit ? (
            <UnitForm key={unit.symbol} unit={unit} />
          ) : (
            <div
              key={unit.symbol}
              className="flex items-center justify-between rounded-xl border border-line bg-surface-raised px-4 py-3 text-sm"
            >
              <span className="font-medium text-content">
                {unit.symbol} <span className="font-normal text-content-subtle">— {unit.name}</span>
              </span>
              <span className="tabular text-content-subtle">
                {unit.decimalPlaces} dp · {unit.productCount} products
              </span>
            </div>
          ),
        )}
      </div>

      <p className="mt-4 text-xs text-content-subtle">
        Renaming a unit renames it on every product that uses it. Receipts already printed keep the
        name they were printed with. A unit in use cannot be deleted.
      </p>
    </div>
  );
}
