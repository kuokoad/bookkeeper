import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page';

/**
 * Reached both by a mistyped address and by `notFound()` — which pages call
 * when a record id does not exist. The wording covers both without guessing,
 * and without confirming whether a given record exists.
 */
export default function AppNotFound() {
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Not found" description="That page or record does not exist." />

      <div className="rounded-xl border border-line bg-surface-raised p-5">
        <p className="text-sm text-content">
          It may have been a mistyped address, or a record that was never created.
        </p>
        <p className="mt-2 text-sm text-content-muted">
          Nothing has been deleted — this application does not delete financial records.
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Link href="/dashboard">
            <Button size="sm">Back to the dashboard</Button>
          </Link>
          <Link href="/sales">
            <Button size="sm" variant="secondary">
              Sales
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
