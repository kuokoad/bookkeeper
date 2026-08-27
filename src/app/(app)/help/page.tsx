import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/current-user';
import { HELP_PAGES } from '@/lib/help';
import { Card, PageHeader } from '@/components/ui/page';

export const metadata: Metadata = { title: 'Help' };
export const dynamic = 'force-dynamic';

/**
 * Help is for everyone who can sign in.
 *
 * No module gate, deliberately — the same rule the dashboard follows. The staff
 * member who most needs to be told how the till works is exactly the one with
 * the fewest permissions, and a help page they cannot open is worse than none.
 */
export default async function HelpPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Help"
        description="How to use the shop's books. Stored on this machine, so it works without internet."
      />

      <div className="grid gap-3">
        {HELP_PAGES.map((page) => (
          <Link key={page.slug} href={`/help/${page.slug}`} className="block">
            <Card className="h-full transition-colors hover:bg-surface-sunken">
              <p className="font-medium text-accent">{page.title}</p>
              <p className="mt-1 text-sm text-content-muted">{page.blurb}</p>
            </Card>
          </Link>
        ))}
      </div>

      <p className="mt-6 text-xs text-content-subtle">
        These pages are the same ones kept with the software, so what you read here
        matches the version you are running.
      </p>
    </div>
  );
}
