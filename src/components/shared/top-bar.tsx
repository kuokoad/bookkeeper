import Link from 'next/link';

import type { Notice } from '@/services/notifications.service';
import { logoutAction } from '@/actions/auth.actions';
import { Button } from '@/components/ui/button';
import { ThemeSwitch } from './theme-switch';
import { Icon } from './icon';

/**
 * The utility bar above the working area.
 *
 * Search and notifications are real functionality, not decoration: the search
 * queries records the person is allowed to see, and every notice below is a
 * condition that actually holds right now. Nothing here is a placeholder.
 *
 * The notification panel is a `<details>` element, so it opens and closes with
 * no JavaScript at all — the same reason the charts are server-rendered SVG.
 */
export function TopBar({
  shopName,
  notices,
  query,
}: {
  shopName: string;
  notices: Notice[];
  /** Echoed back so the box still shows what was searched for. */
  query?: string;
}) {
  const TONES = {
    danger: 'text-danger',
    warning: 'text-warning',
    info: 'text-content-muted',
  } as const;

  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface-raised px-4 py-2.5">
      <p className="truncate text-sm font-medium text-content lg:hidden">{shopName}</p>

      <form action="/search" role="search" className="hidden min-w-0 flex-1 lg:block">
        <label htmlFor="q" className="sr-only">
          Search products, customers, suppliers and receipts
        </label>
        <div className="relative max-w-md">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-subtle">
            <Icon name="reports" className="h-4 w-4" />
          </span>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={query ?? ''}
            placeholder="Search a product, customer or receipt"
            className="h-9 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-sm text-content placeholder:text-content-subtle focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
          />
        </div>
      </form>

      <div className="ml-auto flex items-center gap-1">
        <Link
          href="/search"
          className="rounded-lg p-2 text-content-muted transition-colors hover:bg-surface-sunken hover:text-content lg:hidden"
          aria-label="Search"
        >
          <Icon name="reports" className="h-5 w-5" />
        </Link>

        <ThemeSwitch />

        {/* The sidebar carries sign-out on desktop, and it is hidden on a
            phone — so without this, a phone user could not sign out at all. */}
        <form action={logoutAction} className="lg:hidden">
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>

        <details className="relative">
          <summary
            className="flex cursor-pointer list-none items-center rounded-lg p-2 text-content-muted transition-colors hover:bg-surface-sunken hover:text-content"
            aria-label={
              notices.length === 0
                ? 'Notifications: nothing needs attention'
                : `Notifications: ${notices.length} needing attention`
            }
          >
            <span className="relative">
              <Icon name="settings" className="h-5 w-5" />
              {notices.length > 0 && (
                <span
                  className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white"
                  aria-hidden="true"
                >
                  {notices.length}
                </span>
              )}
            </span>
          </summary>

          <div className="absolute right-0 z-40 mt-2 w-80 rounded-xl border border-line bg-surface-raised p-2 shadow-lg">
            <p className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
              Needs attention
            </p>
            {notices.length === 0 ? (
              <p className="px-2 py-3 text-sm text-content-muted">
                Nothing needs attention. Your books balance and nothing is overdue.
              </p>
            ) : (
              <ul className="space-y-0.5">
                {notices.map((notice) => (
                  <li key={notice.id}>
                    <Link
                      href={notice.href}
                      className="block rounded-lg px-2 py-2 transition-colors hover:bg-surface-sunken"
                    >
                      <span className={`block text-sm font-medium ${TONES[notice.tone]}`}>
                        {notice.title}
                      </span>
                      <span className="block text-xs text-content-muted">{notice.detail}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      </div>
    </header>
  );
}
