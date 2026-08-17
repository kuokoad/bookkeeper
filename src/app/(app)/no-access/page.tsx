import type { Metadata } from 'next';
import Link from 'next/link';

import { getCurrentUser } from '@/lib/auth/current-user';
import { moduleLabel } from '@/components/shared/modules';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page';

export const metadata: Metadata = { title: 'No access' };
export const dynamic = 'force-dynamic';

/**
 * Where a page sends someone who is signed in but not allowed in.
 *
 * It says plainly what happened and who can change it, rather than showing a
 * server error. It reveals nothing about the contents of the area itself.
 */
export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string }>;
}) {
  const user = await getCurrentUser();
  const { area } = await searchParams;

  // Only echo back an area name we recognise, so the page cannot be used to
  // put arbitrary text on the screen from a link someone was sent.
  const label = area ? moduleLabel(area) : null;

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title="You do not have access"
        description={
          label
            ? `Your account is not set up to open ${label.toLowerCase()}.`
            : 'Your account is not set up to open that part of the shop.'
        }
      />

      <div className="rounded-xl border border-line bg-surface-raised p-5">
        <p className="text-sm text-content">
          You are signed in as{' '}
          <span className="font-medium">{user?.displayName ?? 'someone'}</span>. If you need this,
          ask the shop owner to give your account access.
        </p>
        <p className="mt-2 text-sm text-content-muted">
          Nothing has gone wrong, and nothing was changed.
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Link href="/dashboard">
            <Button size="sm">Back to the dashboard</Button>
          </Link>
          <Link href="/sales/new">
            <Button size="sm" variant="secondary">
              New sale
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
