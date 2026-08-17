import { redirect } from 'next/navigation';

import { db } from '@/db/client';
import { needsInitialSetup } from '@/services/auth.service';
import { getCurrentUser } from '@/lib/auth/current-user';

/** Entry point: first run -> setup, signed in -> dashboard, otherwise -> login. */
export default async function RootPage() {
  if (needsInitialSetup(db)) redirect('/setup');

  const user = await getCurrentUser();
  redirect(user ? '/dashboard' : '/login');
}
