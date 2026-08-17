import type { Metadata } from 'next';

import { requirePageAccess } from '@/lib/auth/current-user';
import { PageHeader } from '@/components/ui/page';
import { NewUserForm } from './new-user-form';

export const metadata: Metadata = { title: 'Add a user' };
export const dynamic = 'force-dynamic';

export default async function NewUserPage() {
  await requirePageAccess('users', 'create');

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Add a user"
        description="Someone who will sign in — a shop assistant, a manager, or a second owner."
      />
      <NewUserForm />
    </div>
  );
}
