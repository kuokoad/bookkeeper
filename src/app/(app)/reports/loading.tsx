import { PageSkeleton } from '@/components/ui/skeleton';

/**
 * Reports read the entire ledger — a balance sheet at a year of trading takes
 * roughly half a second. This stands in meanwhile, so the screen never looks
 * frozen. Safe here because the section's access check sits in `layout.tsx`,
 * which runs before this boundary. See the note there.
 */
export default function ReportsLoading() {
  return <PageSkeleton stats={4} rows={8} />;
}
