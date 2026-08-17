import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { users } from '@/db/schema';
import { requireUser } from '@/lib/auth/current-user';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page';
import { ChangePasswordForm } from './change-password-form';

export const metadata: Metadata = { title: 'Change your password' };
export const dynamic = 'force-dynamic';

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ required?: string }>;
}) {
  const actor = await requireUser();
  const params = await searchParams;

  const row = db
    .select({ mustChangePassword: users.mustChangePassword })
    .from(users)
    .where(eq(users.id, actor.id))
    .get();

  const required = params.required === '1' || row?.mustChangePassword === true;

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader
        title="Change your password"
        description={`Signed in as ${actor.displayName}`}
      />

      {required && (
        <Alert tone="warning" title="Please choose your own password" className="mb-4">
          Your password was set by someone else. Choose one only you know before carrying on.
        </Alert>
      )}

      <ChangePasswordForm />

      <p className="mt-4 text-xs text-content-subtle">
        Changing your password signs out every device, including this one, so you will sign in again
        with the new password.
      </p>
    </div>
  );
}
