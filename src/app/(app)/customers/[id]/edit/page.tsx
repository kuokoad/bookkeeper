import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { requirePageAccess } from '@/lib/auth/current-user';
import { getCustomer } from '@/services/customer.service';
import { updateCustomerAction } from '@/actions/customer.actions';
import { toInputString } from '@/domain/money';
import { isDomainError } from '@/domain/errors';
import { PageHeader } from '@/components/ui/page';
import { CustomerForm } from '../../customer-form';

export const metadata: Metadata = { title: 'Edit customer' };
export const dynamic = 'force-dynamic';

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess('customers', 'edit');
  const { id } = await params;

  const customerId = Number(id);
  if (!Number.isInteger(customerId) || customerId <= 0) notFound();

  let customer;
  try {
    customer = getCustomer(db, customerId);
  } catch (error) {
    if (isDomainError(error) && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const action = updateCustomerAction.bind(null, customerId);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Edit customer" description={customer.name} />
      <CustomerForm
        action={action}
        currencyCode={settings?.currencyCode ?? 'GHS'}
        submitLabel="Save changes"
        cancelHref={`/customers/${customerId}`}
        initial={{
          name: customer.name,
          phone: customer.phone ?? '',
          email: customer.email ?? '',
          address: customer.address ?? '',
          notes: customer.notes ?? '',
          creditLimit: customer.creditLimit === null ? '' : toInputString(customer.creditLimit),
        }}
      />
    </div>
  );
}
