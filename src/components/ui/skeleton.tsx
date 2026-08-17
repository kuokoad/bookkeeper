import { cn } from '@/lib/cn';

/**
 * A placeholder block shown while a page's data is still being read.
 *
 * Deliberately shows no numbers, not even zeros: a figure on screen in a
 * bookkeeping application is a claim about the shop's money, and a placeholder
 * that looks like a balance is worse than an obvious grey box.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-surface-sunken', className)}
    />
  );
}

/** The page header, stat row and table that most pages in the app share. */
export function PageSkeleton({
  stats = 3,
  rows = 6,
}: {
  stats?: number;
  rows?: number;
}) {
  return (
    <div className="mx-auto max-w-6xl" role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <div className="mb-6">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>

      {stats > 0 && (
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          {Array.from({ length: stats }, (_, index) => (
            <div key={index} className="rounded-xl border border-line bg-surface-raised p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-2 h-6 w-28" />
            </div>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-line bg-surface-raised">
        <div className="border-b border-line px-4 py-3">
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="border-b border-line px-4 py-3 last:border-b-0">
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
