'use client';

import { Button } from '@/components/ui/button';

/** Printing must be triggered by the browser, so this needs to be a client component. */
export function PrintButton() {
  return (
    <Button type="button" size="sm" onClick={() => window.print()}>
      Print
    </Button>
  );
}
