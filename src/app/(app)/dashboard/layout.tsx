import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/current-user';

/** Authenticate before the dashboard loading boundary flushes response headers. */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await getCurrentUser())) redirect('/login');
  return <>{children}</>;
}
