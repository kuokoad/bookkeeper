import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { withParam, type FilterValues } from '@/lib/filters';

/**
 * Pager for a filtered list.
 *
 * Plain links carrying every current filter, so the pager works without
 * JavaScript and a page-2 URL can be shared and still mean the same rows. The
 * count shown is the count of the FILTERED set — filter 1,000 sales down to 27
 * and this says 27, because a pager that reports the unfiltered total is
 * telling the owner their filter did not work.
 */
export function Pagination({
  basePath,
  values,
  page,
  pageSize,
  total,
  /** What the rows are, for the summary line: "27 sales". */
  noun = 'result',
  nounPlural,
}: {
  basePath: string;
  values: FilterValues;
  page: number;
  pageSize: number;
  total: number;
  noun?: string;
  nounPlural?: string;
}) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const plural = nounPlural ?? `${noun}s`;
  const label = total === 1 ? noun : plural;

  const href = (target: number): string =>
    `${basePath}${withParam(values, 'page', target === 1 ? undefined : target)}`;

  return (
    <nav
      aria-label="Pagination"
      className="mt-4 flex flex-wrap items-center justify-between gap-3 no-print"
    >
      <p className="text-xs text-content-subtle" aria-live="polite">
        {total === 0
          ? `No ${plural}`
          : `Showing ${first}–${last} of ${total} ${label}`}
      </p>

      {lastPage > 1 && (
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link href={href(page - 1)} rel="prev">
              <Button size="sm" variant="secondary" type="button">
                Previous
              </Button>
            </Link>
          ) : (
            <Button size="sm" variant="secondary" type="button" disabled>
              Previous
            </Button>
          )}

          <span className="text-xs text-content-muted">
            Page {page} of {lastPage}
          </span>

          {page < lastPage ? (
            <Link href={href(page + 1)} rel="next">
              <Button size="sm" variant="secondary" type="button">
                Next
              </Button>
            </Link>
          ) : (
            <Button size="sm" variant="secondary" type="button" disabled>
              Next
            </Button>
          )}
        </div>
      )}
    </nav>
  );
}

/**
 * A sortable column heading.
 *
 * Sorting is a filter of a different kind and travels the same way: a link that
 * carries every other parameter, so sort, filters and the page number can never
 * disagree about what is being shown.
 */
export function SortLink({
  basePath,
  values,
  column,
  activeSort,
  activeDirection,
  children,
  /** Most columns read best descending first; names read best ascending. */
  defaultDirection = 'desc',
}: {
  basePath: string;
  values: FilterValues;
  column: string;
  activeSort: string;
  activeDirection: 'asc' | 'desc';
  children: React.ReactNode;
  defaultDirection?: 'asc' | 'desc';
}) {
  const isActive = activeSort === column;
  const nextDirection = isActive
    ? activeDirection === 'asc'
      ? 'desc'
      : 'asc'
    : defaultDirection;

  const href = `${basePath}${withParam(
    { ...values, sort: column, page: undefined },
    'direction',
    nextDirection,
  )}`;

  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 hover:text-content"
      aria-sort={isActive ? (activeDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {children}
      <span aria-hidden="true" className={isActive ? 'text-accent' : 'text-content-subtle/40'}>
        {isActive ? (activeDirection === 'asc' ? '▲' : '▼') : '⇅'}
      </span>
    </Link>
  );
}
