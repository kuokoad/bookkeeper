import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { getCurrentUser } from '@/lib/auth/current-user';
import { redirect } from 'next/navigation';
import { search } from '@/services/search.service';
import { money } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeader } from '@/components/ui/page';

export const metadata: Metadata = { title: 'Search' };
export const dynamic = 'force-dynamic';

/**
 * Search results.
 *
 * Reachable by anyone signed in — the permission work happens per record type
 * inside the service, so a person only ever queries what they may see. Guarding
 * the page itself on one module would either lock out staff who can legitimately
 * look up a product, or imply a right they do not have.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  // Signed in is the only requirement. Guarding this page on a module would
  // lock out a till operator who may perfectly well look up a product — and the
  // search box sits in their top bar, so it would be a control that always
  // refuses. The real guard is per record type inside the service.
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const { q } = await searchParams;

  const results = search(db, q ?? '', user);
  const tooShort = (q ?? '').trim().length === 1;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Search"
        description="Products, customers, suppliers, receipts, purchases and journal entries."
      />

      <form action="/search" role="search" className="mb-6 flex gap-2">
        <label htmlFor="q" className="sr-only">
          What are you looking for?
        </label>
        <input
          id="q"
          name="q"
          type="search"
          autoFocus
          defaultValue={results.query}
          placeholder="A product name, a customer, a receipt number…"
          className="h-11 flex-1 rounded-lg border border-line-strong bg-surface-raised px-3 text-content placeholder:text-content-subtle"
        />
        <Button type="submit">Search</Button>
      </form>

      {tooShort && (
        <p className="mb-4 text-sm text-content-muted">
          Type at least two characters — a single letter would match almost everything.
        </p>
      )}

      {results.query.length >= 2 && results.total === 0 && (
        <EmptyState
          title={`Nothing matches “${results.query}”`}
          description="Check the spelling, or try part of a name or number instead of the whole thing."
        />
      )}

      {results.total > 0 && (
        <>
          <p className="mb-4 text-sm text-content-muted">
            {results.total} match{results.total === 1 ? '' : 'es'} for “{results.query}”
            {results.truncated && ' — showing the first few of each kind'}
          </p>

          <div className="space-y-6">
            {results.groups.map((group) => (
              <section key={group.label}>
                <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
                  {group.label}
                </h2>
                <ul className="overflow-hidden rounded-xl border border-line bg-surface-raised">
                  {group.hits.map((hit) => (
                    <li key={`${hit.kind}-${hit.id}`} className="border-b border-line last:border-b-0">
                      <Link
                        href={hit.href}
                        className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-surface-sunken"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-content">
                            {hit.title}
                          </span>
                          <span className="block truncate text-xs text-content-muted">
                            {hit.detail}
                          </span>
                        </span>
                        {hit.amount !== undefined && (
                          <span className="tabular shrink-0 text-sm font-medium text-content">
                            {money(hit.amount)}
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}

      <p className="mt-6 text-xs text-content-subtle">
        You only see records you are allowed to open. Anything outside your access is not searched
        at all.
      </p>
    </div>
  );
}
