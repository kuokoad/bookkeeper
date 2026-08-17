import Link from 'next/link';

/**
 * The 404 for addresses outside the signed-in shell — before sign-in, or a path
 * that matches no route group at all. It deliberately links only to the sign-in
 * screen, since we do not know who is asking.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-sunken px-4">
      <main className="w-full max-w-md rounded-xl border border-line bg-surface-raised p-6 text-center">
        <h1 className="text-lg font-semibold text-content">Page not found</h1>
        <p className="mt-2 text-sm text-content-muted">
          That address does not exist in this application.
        </p>
        <Link
          href="/login"
          className="mt-5 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Go to sign in
        </Link>
      </main>
    </div>
  );
}
