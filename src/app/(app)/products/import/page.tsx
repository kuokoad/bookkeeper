import type { Metadata } from 'next';

import { requirePageAccess } from '@/lib/auth/current-user';
import { PageHeader } from '@/components/ui/page';
import { ImportForm } from './import-form';

export const metadata: Metadata = { title: 'Import products' };
export const dynamic = 'force-dynamic';

export default async function ImportProductsPage() {
  await requirePageAccess('products', 'create');

  return (
    <div className="w-full">
      <PageHeader
        title="Import products"
        description="Add many products at once from an Excel (.xlsx) or CSV price list. Nothing is saved until you have checked the preview."
      />
      <ImportForm />
    </div>
  );
}
