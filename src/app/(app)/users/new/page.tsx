import type { Metadata } from 'next';

import { requirePageAccess } from '@/lib/auth/current-user';
import { PageHeader } from '@/components/ui/page';
import { NewUserForm } from './new-user-form';

export const metadata: Metadata = { title: 'Add a user' };
export const dynamic = 'force-dynamic';

export default async function NewUserPage() {
  const actor = await requirePageAccess('users', 'create');
  const isOwner = actor.role === 'OWNER';

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Add a user"
        description={
          isOwner
            ? 'Someone who will sign in — a shop assistant, a manager, or a second owner.'
            : 'Someone who will sign in. You can give them any of the access you have yourself.'
        }
      />
      {/*
        A non-owner may not create an owner, and may only pass on rights they
        hold themselves. The server enforces both; the form is told so that it
        does not offer choices that would come back as a refusal.
      */}
      <NewUserForm isOwner={isOwner} grantable={isOwner ? null : actor.permissions} />
    </div>
  );
}
