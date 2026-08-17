import { requirePageAccess } from '@/lib/auth/current-user';

/**
 * Reports are the slow section — they aggregate the whole ledger — so this is
 * the one place worth showing a skeleton while the server works.
 *
 * The access check has to live HERE rather than only in the pages beneath it.
 * A `loading.tsx` wraps the page in a Suspense boundary, which means the
 * response headers are flushed before the page component runs; a `redirect()`
 * from inside the page can then only happen in the browser, and the HTTP status
 * is already 200. A layout renders before that boundary, so refusing here keeps
 * the refusal a real HTTP redirect — which is what a script, a log, or anything
 * that is not a browser actually sees.
 */
export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  await requirePageAccess('reports', 'view');
  return <>{children}</>;
}
