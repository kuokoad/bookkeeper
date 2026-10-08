import { Skeleton } from '@/components/ui/skeleton';
export default function DashboardLoading() {
  return (
    <div className="mx-auto max-w-6xl space-y-5" role="status" aria-busy="true">
      <span className="sr-only">Loading dashboard figures…</span>
      <Skeleton className="h-8 w-48" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-36 w-full" />
        ))}
      </div>
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-52 w-full" />
        <Skeleton className="h-52 w-full" />
      </div>
    </div>
  );
}
