'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/cn';
import { Icon } from './icon';
import type { NavItem, NavSection } from './navigation';

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function ItemLabel({ item }: { item: NavItem }) {
  return (
    <>
      <Icon name={item.icon} className="h-5 w-5 shrink-0" />
      <span className="truncate">{item.label}</span>
      {item.comingSoon && (
        <span className="ml-auto rounded bg-sidebar-raised px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sidebar-subtle">
          Soon
        </span>
      )}
    </>
  );
}

/**
 * Desktop sidebar.
 *
 * Modules not yet implemented render as disabled rows rather than links that go
 * nowhere — the shape of the finished app is visible without pretending a
 * feature exists.
 */
export function Sidebar({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="space-y-1 px-3 py-4">
      {sections.map((section) => (
        // `<details>` opens and closes with no JavaScript. `open` is decided on
        // the server from the current path, so the section you are in is
        // already expanded when the page arrives — nothing to click first, and
        // nothing to flicker on load.
        <details
          key={section.heading}
          open={section.items.some((item) => isActive(pathname, item.href))}
          className="group"
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-subtle transition-colors hover:text-sidebar-muted">
            <span className="flex-1">{section.heading}</span>
            <span
              aria-hidden="true"
              className="text-sidebar-subtle transition-transform group-open:rotate-90"
            >
              ›
            </span>
          </summary>
          <ul className="mt-0.5 space-y-0.5 pb-2">
            {section.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  {item.comingSoon ? (
                    <span
                      aria-disabled="true"
                      title="Coming in a later stage"
                      className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-subtle opacity-70"
                    >
                      <ItemLabel item={item} />
                    </span>
                  ) : (
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                        active
                          ? 'bg-sidebar-raised font-medium text-sidebar-text'
                          : 'text-sidebar-muted hover:bg-sidebar-raised hover:text-sidebar-text',
                      )}
                    >
                      <ItemLabel item={item} />
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      ))}
    </nav>
  );
}

/**
 * Mobile bottom bar — the shop owner is usually on a phone behind the counter,
 * so the few things they do all day are one thumb-tap away.
 */
export function MobileNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface-raised pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <ul className="grid grid-cols-4">
        {items.slice(0, 4).map((item) => {
          const active = isActive(pathname, item.href);
          const content = (
            <>
              <Icon name={item.icon} className="h-5 w-5" />
              <span className="text-[11px] leading-none">{item.label}</span>
            </>
          );
          return (
            <li key={item.href}>
              {item.comingSoon ? (
                <span className="flex min-h-[56px] cursor-not-allowed flex-col items-center justify-center gap-1 px-1 text-content-subtle opacity-60">
                  {content}
                </span>
              ) : (
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-[56px] flex-col items-center justify-center gap-1 px-1',
                    active ? 'text-accent' : 'text-content-muted',
                  )}
                >
                  {content}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
