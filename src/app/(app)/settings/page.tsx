import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { getLogoSummary, getSettings, hasPostedTransactions } from '@/services/settings.service';
import {
  allInTaxRateBp,
  listTaxComponents,
  listTaxHoldingAccounts,
  taxComponentUsage,
} from '@/services/tax.service';
import { formatBasisPoints } from '@/domain/rate';
import { toQtyInputString, type Qty } from '@/domain/quantity';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, PageHeader } from '@/components/ui/page';
import { SettingsForm, type SettingsFormValues } from './settings-form';
import { LogoForm } from './logo-form';
import { TaxComponents, type TaxComponentRowValues } from './tax-components';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await requirePageAccess('settings', 'view');
  const settings = getSettings(db);
  const currencyLocked = hasPostedTransactions(db);
  const logo = getLogoSummary(db);

  // The all-in rate comes from the domain rather than from adding the rates up
  // here: once a component is charged on the value PLUS the ones above it, the
  // combined figure is not the sum of the percentages.
  const allInRateBp = allInTaxRateBp(db);
  const taxRows: TaxComponentRowValues[] = listTaxComponents(db).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    rate: formatBasisPoints(row.rateBp),
    basis: row.basis,
    isRecoverable: row.isRecoverable,
    glAccountId: row.glAccountId,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    usage: taxComponentUsage(db, row.id),
  }));
  const holdingAccounts = listTaxHoldingAccounts(db);

  const values: SettingsFormValues = {
    businessName: settings.businessName,
    tagline: settings.tagline ?? '',
    address: settings.address ?? '',
    phone: settings.phone ?? '',
    email: settings.email ?? '',
    currencyCode: settings.currencyCode,
    currencySymbol: settings.currencySymbol,
    taxEnabled: settings.taxEnabled,
    taxInclusive: settings.taxInclusive,
    // Rendered by the same domain function the rates are parsed with, so what
    // is shown and what is saved cannot drift apart.
    taxSummary: `${formatBasisPoints(allInRateBp)}%`,
    lowStock: toQtyInputString(settings.lowStockThresholdMilli as Qty),
    expiryWarningDays: String(settings.expiryWarningDays),
    expiryBlocksSales: settings.expiryBlocksSales,
    allowNegativeStock: settings.allowNegativeStock,
    allowOverpayment: settings.allowOverpayment,
    defaultTermsDays: settings.defaultTermsDays,
    financialYearStartMonth: settings.financialYearStartMonth,
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Settings"
        description="How your shop records money and stock."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/settings/health">
              <Button variant="secondary" size="sm">
                Health &amp; backup
              </Button>
            </Link>
            <Link href="/users/audit?entity=business_settings">
              <Button variant="secondary" size="sm">
                Change history
              </Button>
            </Link>
          </div>
        }
      />

      {can(user, 'settings', 'edit') ? (
        <div className="space-y-6">
          <LogoForm
            logo={{
              hasLogo: logo.hasLogo,
              width: logo.width,
              height: logo.height,
              bytes: logo.bytes,
              // The upload time doubles as a cache key: a new logo is a new URL.
              version: logo.updatedAt?.getTime() ?? 0,
            }}
          />
          <SettingsForm values={values} currencyLocked={currencyLocked} />
          <TaxComponents
            rows={taxRows}
            accounts={holdingAccounts}
            allIn={formatBasisPoints(allInRateBp)}
          />
        </div>
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
