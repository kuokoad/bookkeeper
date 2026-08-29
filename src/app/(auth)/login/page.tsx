import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { needsInitialSetup } from '@/services/auth.service';
import { getCurrentUser } from '@/lib/auth/current-user';
import { isProduction } from '@/lib/env';
import { DEMO_OWNER, DEMO_STAFF } from '@/db/seed/demo';
import { Alert } from '@/components/ui/alert';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

/** Live database state, so it must never be prerendered. */
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ setup?: string }>;
}) {
  if (needsInitialSetup(db)) redirect('/setup');
  if (await getCurrentUser()) redirect('/dashboard');

  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const { setup } = await searchParams;

  // Two independent conditions: the database must actually hold demo rows AND
  // the build must not be production. Neither alone is enough to print
  // credentials on a sign-in page.
  const showDemoHint = !isProduction && settings?.hasDemoData === true;

  return (
    <div className="rounded-2xl border border-line bg-surface-raised p-8 shadow-sm">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-semibold text-content">
          {settings?.businessName ?? 'NunaBooks'}
        </h1>
        <p className="mt-1 text-sm text-content-muted">Sign in to continue</p>
      </div>

      {setup === 'complete' && (
        <Alert tone="success" className="mb-6">
          Setup complete. Sign in with the owner account you just created.
        </Alert>
      )}

      <LoginForm />

      {showDemoHint && (
        <Alert tone="warning" title="Demo data is loaded" className="mt-6">
          {/*
            Read from the seed's own constants rather than retyped here. These
            two lines are the only published record of what the seed created,
            and a hint that disagreed with it would send someone hunting for a
            password that was never set.
          */}
          <ul className="mt-1 space-y-1">
            <li>
              Owner — <code className="font-mono font-medium">{DEMO_OWNER.username}</code> /{' '}
              <code className="font-mono font-medium">{DEMO_OWNER.password}</code>
            </li>
            <li>
              Staff — <code className="font-mono font-medium">{DEMO_STAFF.username}</code> /{' '}
              <code className="font-mono font-medium">{DEMO_STAFF.password}</code>
            </li>
            {/*
              The other tab needs its own credentials. Only the staff account is
              seeded with a PIN, because that is who the till is for: the owner
              signs in with a password. Naming the tab saves working out which
              of the two boxes above this belongs in.
            */}
            <li>
              Till PIN — <code className="font-mono font-medium">{DEMO_STAFF.username}</code> /{' '}
              <code className="font-mono font-medium">{DEMO_STAFF.pin}</code>, on the{' '}
              <span className="font-medium">Sign in with PIN</span> tab
            </li>
          </ul>
          <p className="mt-2">
            This panel appears only while the database contains demo records, and never in
            production. Run <code className="font-mono">npm run db:reset -- --force</code> before
            using this for a real shop.
          </p>
        </Alert>
      )}
    </div>
  );
}
