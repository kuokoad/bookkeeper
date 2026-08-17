'use client';

import { useEffect } from 'react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page';

/**
 * What a person sees when a page inside the shop fails.
 *
 * Two things matter here. First, it must not pretend nothing happened — the
 * error is stated plainly and the digest is shown so a failure can be matched
 * to the server log. Second, it must say what happened to their data: every
 * write runs inside one database transaction, so a failure means nothing was
 * saved. Leaving that unsaid invites someone to re-enter a sale that already
 * went through, or to assume one did when it did not.
 *
 * The `error` object here is the sanitised one React passes to the client. In
 * production its message is replaced with a generic string, so nothing internal
 * reaches the screen either way.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaced in the browser console for a developer looking over the owner's
    // shoulder. The real detail is in the server log, matched by digest.
    console.error('Page failed:', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title="Something went wrong"
        description="This page could not be loaded."
      />

      <div className="rounded-xl border border-danger/40 bg-danger-soft p-5">
        <p className="text-sm text-content">
          <span className="font-medium">Nothing was saved.</span> Any figures you were entering
          were not recorded, so nothing has been half-written to the books.
        </p>
        <p className="mt-2 text-sm text-content-muted">
          Try again. If it keeps happening, note the code below — it identifies this exact
          failure in the server log.
        </p>

        {error.digest && (
          <p className="tabular mt-3 rounded-lg border border-line bg-surface-raised px-3 py-2 text-xs text-content-muted">
            Reference: {error.digest}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={reset}>
            Try again
          </Button>
          <Link href="/dashboard">
            <Button size="sm" variant="secondary">
              Back to the dashboard
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
