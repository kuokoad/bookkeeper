'use client';

import Link from 'next/link';

import { Button } from '@/components/ui/button';

/**
 * Download and print controls for a report.
 *
 * Printing must be triggered by the browser, so this is a client component.
 * The CSV link is a plain anchor to a route handler — no JavaScript needed, and
 * it behaves the same on a phone.
 */
export function ReportActions({
  csvHref,
  backHref = '/reports',
}: {
  csvHref: string;
  backHref?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 no-print">
      <Link href={backHref}>
        <Button variant="secondary" size="sm" type="button">
          All reports
        </Button>
      </Link>
      <a href={csvHref} download>
        <Button variant="secondary" size="sm" type="button">
          Download CSV
        </Button>
      </a>
      <Button type="button" size="sm" onClick={() => window.print()}>
        Print
      </Button>
    </div>
  );
}
