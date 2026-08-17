import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { createCustomerAction } from '@/actions/customer.actions';
import { PageHeader } from '@/components/ui/page';
import { CustomerForm } from '../customer-form';

export const metadata: Metadata = { title: 'Add customer' };
export const dynamic = 'force-dynamic';

export default async function NewCustomerPage() {
  await requirePageAccess('customers', 'create');
  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Add customer" description="Someone who buys from you regularly, or on credit." />
      <CustomerForm
        action={createCustomerAction}
        currencyCode={settings?.currencyCode ?? 'GHS'}
        submitLabel="Add customer"
        cancelHref="/customers"
        initial={{ name: '', phone: '', email: '', address: '', notes: '', creditLimit: '' }}
      />
    </div>
  );
}
