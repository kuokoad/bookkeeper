import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { db } from '@/db/client';
import { needsInitialSetup } from '@/services/auth.service';
import { SetupForm } from './setup-form';

export const metadata: Metadata = { title: 'Set up your shop' };

/**
 * Must never be prerendered: whether setup is still open depends on live
 * database state. A statically cached copy would keep offering the owner-
 * creation form after an owner already exists.
 */
export const dynamic = 'force-dynamic';

export default function SetupPage() {
  // Once any account exists this page is closed permanently.
  if (!needsInitialSetup(db)) redirect('/login');

  return (
    <div className="rounded-2xl border border-line bg-surface-raised p-8 shadow-sm">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-content">Welcome</h1>
        <p className="mt-2 text-sm text-content-muted">
          Let&rsquo;s set up your shop and create your owner account. This happens once.
        </p>
      </div>

      <SetupForm />
    </div>
  );
}
