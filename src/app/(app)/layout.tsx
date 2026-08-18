import Link from 'next/link';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings, users } from '@/db/schema';
import { getCurrentUser } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { NAV_SECTIONS } from '@/components/shared/navigation';
import { MobileNav, Sidebar } from '@/components/shared/app-nav';
import { TopBar } from '@/components/shared/top-bar';
import { getNotices } from '@/services/notifications.service';
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
  const notices = getNotices(db, user);

  const sections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => can(user, item.module, 'view')),
  })).filter((section) => section.items.length > 0);

  const primaryItems = sections.flatMap((section) => section.items).filter((item) => item.primary);

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="hidden w-64 shrink-0 border-r border-sidebar-line bg-sidebar lg:flex lg:flex-col">
        <div className="border-b border-sidebar-line px-4 py-4">
          <p className="truncate px-2 font-semibold text-sidebar-text">
            {settings?.businessName ?? 'Shop Bookkeeper'}
          </p>
          <p className="mt-0.5 px-2 text-xs text-sidebar-subtle">Bookkeeping &amp; stock</p>

          {/* The thing done most times a day, always one tap away. */}
          {can(user, 'sales', 'create') && (
            <Link
              href="/sales/new"
              className="mt-3 flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              New sale
            </Link>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          <Sidebar sections={sections} />
        </div>

        <div className="border-t border-sidebar-line px-4 py-4">
          <p className="truncate text-sm font-medium text-sidebar-text">{user.displayName}</p>
          <p className="mb-2 text-xs capitalize text-sidebar-subtle">{user.role.toLowerCase()}</p>
          <Link
            href="/account/password"
            className="mb-3 block text-xs font-medium text-sidebar-muted hover:text-sidebar-text hover:underline"
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
        <TopBar shopName={settings?.businessName ?? 'Shop Bookkeeper'} notices={notices} />

        <main className="flex-1 px-4 py-6 pb-24 lg:px-8 lg:py-8 lg:pb-8">
          <PageTransition>{children}</PageTransition>
        </main>
      </div>

      <MobileNav items={primaryItems} />
    </div>
  );
}
