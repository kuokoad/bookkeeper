'use client';

import { usePathname } from 'next/navigation';

/**
 * Replays a short entrance whenever the route changes.
 *
 * Keyed on the pathname ONLY, never the query string. Keying on the full URL
 * would remount on every filter change and paging click — which would reset the
 * till's cart when the address gains a query, and make a table flash each time
 * a date filter moves. Neither is worth an animation.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="motion-page">
      {children}
    </div>
  );
}
