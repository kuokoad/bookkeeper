import type { Metadata } from 'next';

import { requirePageAccess } from '@/lib/auth/current-user';
import { createSupplierAction } from '@/actions/purchase.actions';
import { PageHeader } from '@/components/ui/page';
import { SupplierForm } from '../supplier-form';

export const metadata: Metadata = { title: 'Add supplier' };
export const dynamic = 'force-dynamic';

export default async function NewSupplierPage() {
  await requirePageAccess('suppliers', 'create');

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Add supplier" description="Someone you buy stock from." />
      <SupplierForm
        action={createSupplierAction}
        submitLabel="Add supplier"
        cancelHref="/suppliers"
        initial={{ name: '', contactPerson: '', phone: '', email: '', address: '', notes: '' }}
      />
    </div>
  );
}
