import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getSupplier } from '@/services/supplier.service';
import { updateSupplierAction } from '@/actions/purchase.actions';
import { isDomainError } from '@/domain/errors';
import { PageHeader } from '@/components/ui/page';
import { SupplierForm } from '../../supplier-form';

export const metadata: Metadata = { title: 'Edit supplier' };
export const dynamic = 'force-dynamic';

export default async function EditSupplierPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess('suppliers', 'edit');
  const { id } = await params;

  const supplierId = Number(id);
  if (!Number.isInteger(supplierId) || supplierId <= 0) notFound();

  let supplier;
  try {
    supplier = getSupplier(db, supplierId);
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Edit supplier" description={supplier.name} />
      <SupplierForm
        action={updateSupplierAction.bind(null, supplierId)}
        submitLabel="Save changes"
        cancelHref={`/suppliers/${supplierId}`}
        initial={{
          name: supplier.name,
          contactPerson: supplier.contactPerson ?? '',
          phone: supplier.phone ?? '',
          email: supplier.email ?? '',
          address: supplier.address ?? '',
          notes: supplier.notes ?? '',
        }}
      />
    </div>
  );
}
