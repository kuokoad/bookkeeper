'use client';

import { useSearchParams } from 'next/navigation';

import { Icon } from './icon';

/**
 * The search box in the top bar.
 *
 * A client component for one reason: it has to show what was searched for, and
 * a LAYOUT cannot read the query string. `TopBar` took a `query` prop and
 * documented it as "echoed back so the box still shows what was searched for",
 * but the layout that renders TopBar is never handed `searchParams` by Next, so
 * nothing could ever fill it. The box came back empty after every search, which
 * reads as the search having failed rather than having worked.
 *
 * This is the only piece of the top bar that ships JavaScript. The theme
 * switch, the notification panel and the charts are all deliberately without
 * it; this one needs the current URL, which is not knowable on the server from
 * inside a layout.
 *
 * `key` matters. The input is uncontrolled, so `defaultValue` alone would be
 * read once and then ignored on every later navigation — searching again from
 * the results page would leave the previous term sitting in the box. Keying on
 * the term forces a fresh input whenever it changes.
 *
 * The form still submits as a plain GET to /search, so search works with
 * JavaScript disabled or still loading. The echo is the enhancement; the
 * function is not.
 */
export function SearchBox() {
  const term = useSearchParams().get('q') ?? '';

  return (
    <form action="/search" role="search" className="hidden min-w-0 flex-1 lg:block">
      <label htmlFor="header-search" className="sr-only">
        Search products, customers, suppliers and receipts
      </label>
      <div className="relative max-w-md">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-subtle">
          <Icon name="search" className="h-4 w-4" />
        </span>
        <input
          key={term}
          id="header-search"
          name="q"
          type="search"
          defaultValue={term}
          placeholder="Search a product, customer or receipt"
          className="h-9 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-sm text-content placeholder:text-content-subtle focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
        />
      </div>
    </form>
  );
}
