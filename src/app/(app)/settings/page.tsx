import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getSettings, hasPostedTransactions } from '@/services/settings.service';
import { formatBasisPoints } from '@/domain/rate';
import { toQtyInputString, type Qty } from '@/domain/quantity';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, PageHeader } from '@/components/ui/page';
import { SettingsForm, type SettingsFormValues } from './settings-form';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await requirePageAccess('settings', 'view');
  const settings = getSettings(db);
  const currencyLocked = hasPostedTransactions(db);

  const values: SettingsFormValues = {
    businessName: settings.businessName,
    address: settings.address ?? '',
    phone: settings.phone ?? '',
    email: settings.email ?? '',
    currencyCode: settings.currencyCode,
    currencySymbol: settings.currencySymbol,
    taxEnabled: settings.taxEnabled,
    // Rendered by the same domain functions the form is parsed with, so what
    // is shown and what is saved cannot drift apart.
    taxRate: formatBasisPoints(settings.taxRateBp),
    taxInclusive: settings.taxInclusive,
    taxLabel: settings.taxLabel,
    lowStock: toQtyInputString(settings.lowStockThresholdMilli as Qty),
    allowNegativeStock: settings.allowNegativeStock,
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Settings"
        description="How your shop records money and stock."
        actions={
          <Link href="/users/audit?entity=business_settings">
            <Button variant="secondary" size="sm">
              Change history
            </Button>
          </Link>
        }
      />

      {can(user, 'settings', 'edit') ? (
        <SettingsForm values={values} currencyLocked={currencyLocked} />
      ) : (
        <Card>
          <p className="text-sm text-content-muted">
            You can see these settings but not change them. Ask the shop owner if something here is
            wrong.
          </p>
        </Card>
      )}

      <Alert tone="info" className="mt-6">
        Closing the books for a past period is under{' '}
        <Link href="/accounting" className="font-medium text-accent hover:underline">
          Accounting
        </Link>
        , kept beside the ledger it protects.
      </Alert>

      <p className="mt-4 text-xs text-content-subtle">
        Every change here is recorded in the audit log with what it was before and after.
      </p>
    </div>
  );
}
