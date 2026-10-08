'use client';
import { Button } from '@/components/ui/button';
export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div
      className="mx-auto max-w-6xl rounded-xl border border-danger/40 bg-danger-soft p-5"
      role="alert"
    >
      <h1 className="text-xl font-semibold">
        Dashboard figures could not be loaded
      </h1>
      <p className="mt-2 text-sm">
        Balances are unavailable. A failed read has not been displayed as a zero
        balance.
      </p>
      <p className="mt-1 text-sm text-content-muted">
        Try again. If the problem continues, ask the owner to check the
        application logs.
      </p>
      {error.digest && (
        <p className="mt-2 text-xs">Reference: {error.digest}</p>
      )}
      <Button onClick={retry} className="mt-4">
        Try again
      </Button>
    </div>
  );
}
