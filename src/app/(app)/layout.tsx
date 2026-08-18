import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings, users } from '@/db/schema';
import { getCurrentUser } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { NAV_SECTIONS } from '@/components/shared/navigation';
import { MobileNav, Sidebar } from '@/components/shared/app-nav';
import { PageTransition } from '@/components/shared/page-transition';
import { logoutAction } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';

/**
 * The authenticated shell.
 *
 * Every page beneath this layout is behind the session check here, and the
 * navigation is filtered through the same `can()` used by server actions.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  // Someone whose password was set by an owner must choose their own before
  // doing anything else. Enforced here, in the shell, so no page can be reached
  // by typing its address directly. The password page itself lives OUTSIDE this
  // layout, so this redirect needs no exception.
  const mustChange = db
    .select({ mustChangePassword: users.mustChangePassword })
    .from(users)
    .where(eq(users.id, user.id))
    .get()?.mustChangePassword;

  if (mustChange === true) redirect('/account/password?required=1');

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();

  const sections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => can(user, item.module, 'view')),
  })).filter((section) => section.items.length > 0);

  const primaryItems = sections.flatMap((section) => section.items).filter((item) => item.primary);

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="hidden w-64 shrink-0 border-r border-line bg-surface-raised lg:flex lg:flex-col">
        <div className="border-b border-line px-6 py-5">
          <p className="truncate font-semibold text-content">
            {settings?.businessName ?? 'Shop Bookkeeper'}
          </p>
          <p className="mt-0.5 text-xs text-content-subtle">Bookkeeping &amp; stock</p>
        </div>

        <div className="flex-1 overflow-y-auto">
          <Sidebar sections={sections} />
        </div>

        <div className="border-t border-line px-4 py-4">
          <p className="truncate text-sm font-medium text-content">{user.displayName}</p>
          <p className="mb-2 text-xs capitalize text-content-subtle">{user.role.toLowerCase()}</p>
          <Link
            href="/account/password"
            className="mb-3 block text-xs font-medium text-accent hover:underline"
          >
            Change my password
          </Link>
          <form action={logoutAction}>
            <Button type="submit" variant="secondary" size="sm" fullWidth>
              Sign out
            </Button>
          </form>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line bg-surface-raised px-4 py-3 lg:hidden">
          <p className="truncate font-semibold text-content">
            {settings?.businessName ?? 'Shop Bookkeeper'}
          </p>
          <form action={logoutAction}>
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </header>

        <main className="flex-1 px-4 py-6 pb-24 lg:px-8 lg:py-8 lg:pb-8">
          <PageTransition>{children}</PageTransition>
        </main>
      </div>

      <MobileNav items={primaryItems} />
    </div>
  );
}
