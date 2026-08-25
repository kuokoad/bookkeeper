import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth/current-user';
import { logoutAction } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';

/**
 * A minimal signed-in shell WITHOUT the main navigation.
 *
 * The forced password change lives here rather than inside the app shell,
 * because that shell redirects anyone who must change their password — a page
 * inside it could never be reached. Keeping it outside means the redirect needs
 * no path exception, so there is no gap to get wrong.
 */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return (
    <div className="flex min-h-dvh flex-col bg-surface-sunken">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface-raised px-4 py-3">
        <p className="truncate font-semibold text-content">NunaBooks</p>
        <form action={logoutAction}>
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      </header>
      <main className="flex-1 px-4 py-10">{children}</main>
    </div>
  );
}
